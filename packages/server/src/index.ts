import { randomBytes } from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import { NodeGitClient } from "@reviewgate/core";
import { createApp, SessionStore, type CreateSessionBody } from "./app.js";
import {
  isAlive,
  readServerRecord,
  removeServerRecord,
  writeServerRecord,
  type ServerRecord,
} from "./lockfile.js";

export const VERSION = "0.0.0";

export interface RunningServer {
  port: number;
  serverToken: string;
  store: SessionStore;
  close: () => Promise<void>;
}

export interface StartOptions {
  cwd: string;
  /** 0 = ephemeral poort, wat de default is (§3). */
  port?: number;
}

/**
 * Start de review-server op 127.0.0.1 en legt poort, pid en beheerstoken vast in
 * `.git/reviewgate/server.json`, zodat een tweede aanroep in dezelfde repo de
 * draaiende server hergebruikt in plaats van een tweede te starten (§3).
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const current = await readServerRecord(info.gitDir);
    if (current?.pid === process.pid) await removeServerRecord(info.gitDir);
  };

  return { port, serverToken, store, close };
}

/**
 * Geeft de draaiende server voor deze repo terug, of null. Een record van een
 * proces dat niet meer bestaat of niet meer antwoordt wordt opgeruimd.
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
    if (!res.ok) throw new Error(`healthz gaf ${res.status}`);
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
}

/** Maakt een sessie aan op een draaiende server en geeft de review-URL terug. */
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
    throw new Error(`kon geen review-sessie aanmaken: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string; token: string; path: string };
  return {
    id: data.id,
    token: data.token,
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
