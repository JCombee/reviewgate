import { NodeGitClient } from "@reviewgate/core";
import { findRunningServer, startServer } from "@reviewgate/server";
import { parseOpenArgs } from "../args.js";

/** Start the server without a review; meant for development (§6). */
export async function cmdServe(argv: readonly string[], cwd: string): Promise<number> {
  const args = parseOpenArgs(argv, cwd);
  const server = await startServer({
    cwd: args.cwd,
    ...(args.port ? { port: args.port } : {}),
  });
  process.stdout.write(`ReviewGate server on http://127.0.0.1:${server.port}\n`);
  process.stdout.write("Ctrl+C to stop.\n");

  await new Promise<void>((resolve) => {
    const done = () => void server.close().then(resolve, resolve);
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  return 0;
}

/** Show the running server and the open reviews (§6). */
export async function cmdStatus(argv: readonly string[], cwd: string): Promise<number> {
  const args = parseOpenArgs(argv, cwd);
  const git = await NodeGitClient.open(args.cwd);
  const info = await git.info();

  const record = await findRunningServer(info.gitDir);
  if (!record) {
    process.stdout.write(`No server running for ${info.root}.\n`);
    return 0;
  }

  const res = await fetch(`http://127.0.0.1:${record.port}/healthz`);
  const health = (await res.json()) as { sessions?: number; version?: string };
  process.stdout.write(
    [
      `Repo:     ${info.root}`,
      `Server:   http://127.0.0.1:${record.port} (pid ${record.pid}, version ${health.version ?? record.version})`,
      `Started:  ${record.startedAt}`,
      `Reviews:  ${health.sessions ?? 0} open`,
      "",
    ].join("\n"),
  );
  return 0;
}
