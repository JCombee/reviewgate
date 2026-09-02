import { NodeGitClient, type Diff, type DiffFile } from "@reviewgate/core";
import {
  createSession,
  findRunningServer,
  startServer,
  VERSION,
  type ServerRecord,
} from "@reviewgate/server";
import { parseOpenArgs, type OpenArgs } from "../args.js";
import { openBrowser } from "../browser.js";

export async function cmdOpen(argv: readonly string[], cwd: string): Promise<number> {
  const args = parseOpenArgs(argv, cwd);
  const git = await NodeGitClient.open(args.cwd);

  if (args.json) return await printJson(git, args);

  const info = await git.info();
  const diffOptions = {
    context: args.context,
    includeUntracked: args.includeUntracked,
    ...(args.range ? { range: args.range } : {}),
  };

  // Reuse a server that is already running for this repo; otherwise start one and
  // keep it up for as long as the review is open (§3).
  let record = await findRunningServer(info.gitDir);
  let stop: (() => Promise<void>) | null = null;

  if (!record) {
    const server = await startServer({ cwd: args.cwd, ...(args.port ? { port: args.port } : {}) });
    record = {
      port: server.port,
      pid: process.pid,
      serverToken: server.serverToken,
      startedAt: new Date().toISOString(),
      version: VERSION,
    } satisfies ServerRecord;
    stop = server.close;
  }

  const session = await createSession(record, {
    scope: args.scope,
    options: diffOptions,
    cwd: args.cwd,
  });

  process.stdout.write(`${session.url}\n`);

  if (!args.noOpen) {
    const opened = await openBrowser(session.url);
    if (!opened) {
      process.stdout.write("Could not open the browser — use the URL above.\n");
    }
  }

  if (!stop) {
    // The server was already running, so it belongs to the other process and we are
    // done here.
    return 0;
  }

  process.stdout.write("Server is running. Ctrl+C to stop.\n");
  await waitForSignal(stop);
  return 0;
}

async function printJson(git: NodeGitClient, args: OpenArgs): Promise<number> {
  const diff = await git.diff(args.scope, {
    context: args.context,
    includeUntracked: args.includeUntracked,
    ...(args.range ? { range: args.range } : {}),
  });
  const info = await git.info();
  process.stdout.write(
    `${JSON.stringify(
      { repo: { root: info.root, branch: info.branch, hasHead: info.hasHead }, diff },
      null,
      2,
    )}\n`,
  );
  return 0;
}

function waitForSignal(stop: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      void stop().then(resolve, resolve);
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

export function renderSummary(diff: Diff): string {
  const lines: string[] = [];
  lines.push(
    `${diff.files.length} file(s) · +${diff.additions} −${diff.deletions} · scope: ${diff.scope}`,
  );
  for (const f of diff.files) lines.push(`  ${statusChar(f)} ${label(f)}${counts(f)}`);
  return `${lines.join("\n")}\n`;
}

function statusChar(f: DiffFile): string {
  switch (f.status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    default:
      return "M";
  }
}

function label(f: DiffFile): string {
  if (f.status === "renamed" || f.status === "copied") {
    return `${f.oldPath ?? "?"} → ${f.newPath ?? "?"}`;
  }
  return f.path;
}

function counts(f: DiffFile): string {
  if (f.binary) return "  (binary)";
  if (f.submodule) return "  (submodule)";
  return `  +${f.additions} −${f.deletions}`;
}
