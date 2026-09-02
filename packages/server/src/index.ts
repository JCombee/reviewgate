import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { NodeGitClient, VERSION as CORE_VERSION } from "@reviewgate/core";
import { createApp, SessionStore, type CreateSessionBody } from "./app.js";
import {
  isAlive,
  readServerRecord,
  removeServerRecord,
  writeServerRecord,
  type ServerRecord,
} from "./lockfile.js";

export const VERSION = CORE_VERSION;

export interface RunningServer {
  port: number;
  serverToken: string;
  store: SessionStore;
  close: () => Promise<void>;
}

export interface StartOptions {
  cwd: string;
  /** 0 = an ephemeral port, which is the default (§3). */
  port?: number;
}

/**
 * Starts the review server on 127.0.0.1 and records port, pid and admin token in
 * `.git/reviewgate/server.json`, so a second invocation in the same repo reuses the
 * running server instead of starting a second one (§3).
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const git = await NodeGitClient.open(opts.cwd);
  const info = await git.info();

  const serverToken = randomBytes(24).toString("base64url");
  const store = new SessionStore();
  const app = createApp({ serverToken, repoRoot: info.root, version: VERSION }, store);

  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: opts.port ?? 0 }, () =>
      resolve(s),
    );
  });

  // Every socket, tracked by hand. `closeAllConnections()` is a Node addition that a
  // different runtime need not have — under the compiled binary it is simply absent —
  // and without it a browser holding an SSE stream keeps the hook's process alive.
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const record: ServerRecord = {
    port,
    pid: process.pid,
    serverToken,
    startedAt: new Date().toISOString(),
    version: VERSION,
  };
  await writeServerRecord(info.gitDir, record);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    // An open SSE stream never ends by itself, and `close()` waits for every
    // connection. Without this the hook hangs as soon as a browser is watching: the
    // verdict is already on stdout, but the process does not end.
    const node = server as unknown as {
      closeIdleConnections?: () => void;
      closeAllConnections?: () => void;
    };
    node.closeIdleConnections?.();
    node.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
    sockets.clear();

    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      // Last resort: better a socket that lingers a moment than a hook that never
      // finishes.
      new Promise<void>((resolve) => setTimeout(resolve, 2000).unref()),
    ]);

    const current = await readServerRecord(info.gitDir);
    if (current?.pid === process.pid) await removeServerRecord(info.gitDir);
  };

  return { port, serverToken, store, close };
}

/**
 * Returns the running server for this repo, or null. A record for a process that no
 * longer exists or no longer answers gets cleaned up.
 */
export async function findRunningServer(gitDir: string): Promise<ServerRecord | null> {
  const rec = await readServerRecord(gitDir);
  if (!rec) return null;
  if (!isAlive(rec.pid)) {
    await removeServerRecord(gitDir);
    return null;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`healthz returned ${res.status}`);
    return rec;
  } catch {
    await removeServerRecord(gitDir);
    return null;
  }
}

export interface CreatedSession {
  id: string;
  token: string;
  url: string;
  /** Id of the persistent review; this is what the hook waits on (§7). */
  reviewId: string;
}

/** Creates a session on a running server and returns the review URL. */
export async function createSession(
  rec: ServerRecord,
  body: CreateSessionBody,
): Promise<CreatedSession> {
  const res = await fetch(`http://127.0.0.1:${rec.port}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rec.serverToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`could not create a review session: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    id: string;
    token: string;
    path: string;
    reviewId: string;
  };
  return {
    id: data.id,
    token: data.token,
    reviewId: data.reviewId,
    url: `http://127.0.0.1:${rec.port}${data.path}?token=${encodeURIComponent(data.token)}`,
  };
}

export { createApp, SessionStore } from "./app.js";
export type { AppDeps, CreateSessionBody } from "./app.js";
export { Session } from "./session.js";
export { Highlighting, languageFor } from "./highlight.js";
export {
  isAlive,
  readServerRecord,
  removeServerRecord,
  serverRecordPath,
  stateDir,
  writeServerRecord,
} from "./lockfile.js";
export type { ServerRecord } from "./lockfile.js";
