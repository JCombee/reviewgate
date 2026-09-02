import fs from "node:fs/promises";
import path from "node:path";
import {
  analyzeCommand,
  consumeApproval,
  diffHash,
  isIgnored,
  loadConfig,
  parseUnifiedDiff,
  NodeGitClient,
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
 * De blokkerende PreToolUse-hook (§2).
 *
 * Leest de hook-JSON van stdin, bepaalt of dit een commit is die gereviewd moet
 * worden, opent de review en blijft wachten tot er een beslissing valt. Faalt er
 * iets, dan laten we de commit door: een kapotte gate mag nooit het werk
 * blokkeren, alleen niet reviewen (§11).
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
    // Onleesbare invoer: niets zeggen, niets blokkeren.
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
    // Een server die deze hook zelf startte houdt anders de event loop open en
    // laat het proces hangen nadat het oordeel al geprint is.
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
        "`--no-verify` omzeilt de review-gate. Commit zonder die vlag; " +
        "als een git-hook faalt, los dan die fout op in plaats van hem over te slaan.",
    };
  }

  if (process.env["REVIEWGATE_SKIP"] === "1") return null;

  const git = await NodeGitClient.open(cwd);
  const info = await git.info();

  // Midden in een merge, rebase of cherry-pick heeft reviewen geen zin (§12).
  if (info.inMergeOrRebase) return null;

  const config = await loadConfig(info.root);

  const options: DiffOptions = { context: 5, includeUntracked: analysis.scope === "working" };
  const patch = await git.rawDiff(analysis.scope, options);
  if (patch.trim() === "") return null;

  // Genegeerde paden en te kleine diffs gaan zonder review door (§2). We tellen op
  // de geparste diff, zodat lockfiles de telling niet opblazen.
  const files = parseUnifiedDiff(patch).filter((f) => !isIgnored(f.path, config.ignore));
  if (files.length === 0) return null;
  const changedLines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (changedLines < config.minLines) return null;

  const hash = diffHash(patch);

  // Al goedgekeurd? Dan hoeft dezelfde diff niet nóg een keer langs de review (§2).
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

  // In tests en op headless machines is de browser niet gewenst of niet aanwezig.
  if (config.autoOpen && process.env["REVIEWGATE_NO_OPEN"] !== "1") await openBrowser(session.url);

  // De omgevingsvariabele wint van de config; die is bedoeld om per aanroep bij te
  // sturen, bijvoorbeeld in tests.
  const fromEnv = Number.parseInt(process.env["REVIEWGATE_TIMEOUT_MS"] ?? "", 10);
  const result = await waitForDecision(info.gitDir, session.reviewId, {
    timeoutMs: Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : config.timeoutMs,
  });

  if (!result) {
    return {
      kind: "deny",
      reason:
        `De review is nog niet afgerond: ${session.url}\n\n` +
        "Wacht op de gebruiker en probeer daarna opnieuw te committen.",
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
 * De reviewer heeft de commit message aangepast.
 *
 * Een PreToolUse-hook kan het commando niet herschrijven — er is geen veld waarmee
 * je `tool_input` mag aanpassen. Daarom schrijven we de message naar een bestand en
 * vragen we om precies één nieuwe poging met `-F`. Het approval-artifact staat er
 * al, dus die tweede poging loopt zonder review door.
 */
async function denyForEditedMessage(gitDir: string, message: string): Promise<Verdict> {
  const file = path.join(gitDir, "reviewgate", "COMMIT_EDITMSG");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, message.endsWith("\n") ? message : `${message}\n`, "utf8");

  return {
    kind: "deny",
    reason:
      "De review is goedgekeurd, maar de reviewer heeft de commit message aangepast.\n\n" +
      `Commit opnieuw met exact deze message:\n\n    git commit -F ${toPosix(file)}\n\n` +
      "De goedkeuring geldt nog, dus die poging loopt zonder nieuwe review door.",
  };
}

/** Gebruikt het commando de door ons geschreven message al? Dan is het de tweede poging. */
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

  // De hook blijft draaien zolang hij blokkeert, dus deze server leeft precies zo
  // lang als de review. Daarna moet hij dicht, anders eindigt het hookproces niet.
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
            permissionDecisionReason: "Goedgekeurd in de review.",
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
    // Als zelfs loggen niet lukt, is stil falen het enige goede antwoord.
  }
}
