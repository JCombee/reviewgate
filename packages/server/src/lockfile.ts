import fs from "node:fs/promises";
import path from "node:path";

export interface ServerRecord {
  port: number;
  pid: number;
  /** Beheerstoken voor `POST /api/sessions`; alleen de lokale CLI kent dit. */
  serverToken: string;
  startedAt: string;
  version: string;
}

/** `.git/reviewgate` — buiten versiebeheer, per repo (§4). */
export function stateDir(gitDir: string): string {
  return path.join(gitDir, "reviewgate");
}

export function serverRecordPath(gitDir: string): string {
  return path.join(stateDir(gitDir), "server.json");
}

export async function writeServerRecord(gitDir: string, rec: ServerRecord): Promise<void> {
  const dir = stateDir(gitDir);
  await fs.mkdir(dir, { recursive: true });
  const file = serverRecordPath(gitDir);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function readServerRecord(gitDir: string): Promise<ServerRecord | null> {
  try {
    const raw = await fs.readFile(serverRecordPath(gitDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isServerRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function removeServerRecord(gitDir: string): Promise<void> {
  await fs.rm(serverRecordPath(gitDir), { force: true });
}

/**
 * Draait dit pid nog? `process.kill(pid, 0)` doet geen signaal maar alleen een
 * bestaanscheck, en werkt zo op macOS, Linux én Windows (§4).
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM betekent: het proces bestaat, maar is niet van ons.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isServerRecord(v: unknown): v is ServerRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["port"] === "number" &&
    typeof r["pid"] === "number" &&
    typeof r["serverToken"] === "string" &&
    typeof r["startedAt"] === "string" &&
    typeof r["version"] === "string"
  );
}
