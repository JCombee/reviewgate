import fs from "node:fs/promises";
import path from "node:path";
import {
  analyzeCommand,
  consumeApproval,
  diffHash,
  isIgnored,
  loadConfig,
  NodeGitClient,
  parseUnifiedDiff,
  readApproval,
  renderApproved,
  renderChangesRequested,
  waitForDecision,
  type CommitAnalysis,
  type DiffOptions,
} from "@reviewgate/core";
import {
  createSession,
  findRunningServer,
  startServer,
  VERSION,
  type ServerRecord,
} from "@reviewgate/server";
import { openBrowser } from "../browser.js";

/**
 * The blocking PreToolUse hook (§2).
 *
 * Reads the hook JSON from stdin, works out whether this is a commit that needs
 * reviewing, opens the review and waits until a decision is made. If anything fails we
 * let the commit through: a broken gate must never block the work, only fail to review
 * it (§11).
 */

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: string };
}

type Verdict =
  | { kind: "allow"; context?: string }
  | { kind: "deny"; reason: string };

export async function cmdHook(cwdFallback: string): Promise<number> {
  const raw = await readStdin();

  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    // Unreadable input: say nothing, block nothing.
    return 0;
  }

  const cwd = payload.cwd ?? cwdFallback;
  const started: Array<() => Promise<void>> = [];
  try {
    const verdict = await decide(payload, cwd, started);
    if (verdict) emit(verdict);
    return 0;
  } catch (err) {
    await logError(cwd, err);
    return 0;
  } finally {
    // A server this hook started itself would otherwise keep the event loop open and
    // leave the process hanging after the verdict has already been printed.
    for (const stop of started) await stop().catch(() => {});
  }
}

async function decide(
  payload: HookPayload,
  cwd: string,
  started: Array<() => Promise<void>>,
): Promise<Verdict | null> {
  if (payload.tool_name !== "Bash") return null;

  const command = payload.tool_input?.command ?? "";
  const analysis = analyzeCommand(command);
  if (!analysis.isCommit) return null;

  if (analysis.noVerify) {
    return {
      kind: "deny",
      reason:
        "`--no-verify` bypasses the review gate. Commit without that flag; " +
        "if a git hook fails, fix that failure instead of skipping it.",
    };
  }

  if (process.env["REVIEWGATE_SKIP"] === "1") return null;

  const git = await NodeGitClient.open(cwd);
  const info = await git.info();

  // Halfway through a merge, rebase or cherry-pick, reviewing makes no sense (§12).
  if (info.inMergeOrRebase) return null;

  const config = await loadConfig(info.root);

  const options: DiffOptions = { context: 5, includeUntracked: analysis.scope === "working" };
  const patch = await git.rawDiff(analysis.scope, options);
  if (patch.trim() === "") return null;

  // Ignored paths and diffs that are too small go through unreviewed (§2). We count on
  // the parsed diff, so lockfiles cannot inflate the count.
  const files = parseUnifiedDiff(patch).filter((f) => !isIgnored(f.path, config.ignore));
  if (files.length === 0) return null;
  const changedLines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (changedLines < config.minLines) return null;

  const hash = diffHash(patch);

  // Already approved? Then this diff need not go past the review a second time (§2).
  const approval = await readApproval(info.gitDir, hash);
  if (approval) {
    if (approval.editedCommitMessage && !usesMessageFile(analysis, info.gitDir)) {
      return denyForEditedMessage(info.gitDir, approval.editedCommitMessage);
    }
    await consumeApproval(info.gitDir, hash);
    return approval.summary ? { kind: "allow", context: approval.summary } : { kind: "allow" };
  }

  const record = await ensureServer(cwd, info.gitDir, started);
  const session = await createSession(record, {
    scope: analysis.scope,
    options,
    cwd,
    commitMessage: analysis.message,
    claudeSessionId: payload.session_id ?? null,
    transcriptPath: payload.transcript_path ?? null,
  });

  // In tests and on headless machines the browser is unwanted or absent.
  if (config.autoOpen && process.env["REVIEWGATE_NO_OPEN"] !== "1") await openBrowser(session.url);

  // The environment variable wins over the config; it exists to adjust things per
  // invocation, in tests for instance.
  const fromEnv = Number.parseInt(process.env["REVIEWGATE_TIMEOUT_MS"] ?? "", 10);
  const result = await waitForDecision(info.gitDir, session.reviewId, {
    timeoutMs: Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : config.timeoutMs,
  });

  if (!result) {
    return {
      kind: "deny",
      reason:
        `The review has not been finished yet: ${session.url}\n\n` +
        "Wait for the user, then try to commit again.",
    };
  }

  if (result.decision === "request_changes") {
    return { kind: "deny", reason: renderChangesRequested(result.review) };
  }

  const round = result.review.rounds[result.review.rounds.length - 1];
  const edited = round?.editedCommitMessage ?? null;
  if (edited) return denyForEditedMessage(info.gitDir, edited);

  await consumeApproval(info.gitDir, hash);
  const context = renderApproved(result.review);
  return context ? { kind: "allow", context } : { kind: "allow" };
}

/**
 * The reviewer adjusted the commit message.
 *
 * A PreToolUse hook cannot rewrite the command — there is no field that lets you
 * change `tool_input`. So we write the message to a file and ask for exactly one more
 * attempt with `-F`. The approval artifact is already there, so that second attempt
 * goes through without a review.
 */
async function denyForEditedMessage(gitDir: string, message: string): Promise<Verdict> {
  const file = path.join(gitDir, "reviewgate", "COMMIT_EDITMSG");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, message.endsWith("\n") ? message : `${message}\n`, "utf8");

  return {
    kind: "deny",
    reason:
      "The review was approved, but the reviewer adjusted the commit message.\n\n" +
      `Commit again with exactly this message:\n\n    git commit -F ${toPosix(file)}\n\n` +
      "The approval still stands, so that attempt goes through without a new review.",
  };
}

/** Does the command already use the message we wrote? Then this is the second attempt. */
function usesMessageFile(analysis: CommitAnalysis, gitDir: string): boolean {
  if (!analysis.messageFile) return false;
  const expected = toPosix(path.join(gitDir, "reviewgate", "COMMIT_EDITMSG"));
  return toPosix(path.resolve(analysis.messageFile)) === expected;
}

async function ensureServer(
  cwd: string,
  gitDir: string,
  started: Array<() => Promise<void>>,
): Promise<ServerRecord> {
  const running = await findRunningServer(gitDir);
  if (running) return running;

  // The hook keeps running for as long as it blocks, so this server lives exactly as
  // long as the review. After that it has to close, or the hook process never ends.
  const server = await startServer({ cwd });
  started.push(server.close);
  return {
    port: server.port,
    pid: process.pid,
    serverToken: server.serverToken,
    startedAt: new Date().toISOString(),
    version: VERSION,
  };
}

function emit(verdict: Verdict): void {
  const output =
    verdict.kind === "allow"
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "Approved in the review.",
          },
          ...(verdict.context ? { systemMessage: verdict.context } : {}),
        }
      : {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: verdict.reason,
          },
        };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function toPosix(p: string): string {
  return p.split(path.win32.sep).join("/");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function logError(cwd: string, err: unknown): Promise<void> {
  try {
    const git = await NodeGitClient.open(cwd);
    const info = await git.info();
    const file = path.join(info.gitDir, "reviewgate", "hook.log");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const line = `${new Date().toISOString()} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`;
    await fs.appendFile(file, line, "utf8");
  } catch {
    // If even logging fails, failing silently is the only right answer.
  }
}
