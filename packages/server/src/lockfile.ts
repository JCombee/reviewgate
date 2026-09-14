import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface ServerRecord {
  port: number;
  pid: number;
  /** Admin token for `POST /api/sessions`; only the local CLI knows it. */
  serverToken: string;
  startedAt: string;
  version: string;
}

/** `.git/reviewgate` — outside version control, one per repo (§4). */
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
 * Is this pid still running? `process.kill(pid, 0)` sends no signal, it only checks
 * for existence, and so works on macOS, Linux and Windows alike (§4).
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means: the process exists, but it is not ours.
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

/**
 * The cached verdict of the daily GitHub release check (FR-008), tagged with the
 * local calendar day ("YYYY-MM-DD") it was computed on — including a failed/unreachable
 * check, so a failure does not retry more than once per day.
 */
export interface UpdateCheckCache {
  date: string;
  latest: string | null;
  updateAvailable: boolean;
}

export function updateCheckPath(gitDir: string): string {
  return path.join(stateDir(gitDir), "update-check.json");
}

export async function writeUpdateCheckCache(gitDir: string, rec: UpdateCheckCache): Promise<void> {
  const dir = stateDir(gitDir);
  await fs.mkdir(dir, { recursive: true });
  const file = updateCheckPath(gitDir);
  // Unlike `writeServerRecord` (started once per process at server boot), this write
  // can race with itself: two callers may both find no cache yet and both write. A
  // pid-only tmp name would let one rename steal the other's file out from under it
  // (ENOENT); a random suffix per call keeps each write's tmp file distinct.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function readUpdateCheckCache(gitDir: string): Promise<UpdateCheckCache | null> {
  try {
    const raw = await fs.readFile(updateCheckPath(gitDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isUpdateCheckCache(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isUpdateCheckCache(v: unknown): v is UpdateCheckCache {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["date"] === "string" &&
    (typeof r["latest"] === "string" || r["latest"] === null) &&
    typeof r["updateAvailable"] === "boolean"
  );
}
