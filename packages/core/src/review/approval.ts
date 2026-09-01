import fs from "node:fs/promises";
import path from "node:path";

/**
 * Het approval-artifact (§2): na een Approve legt de server vast dat déze diff is
 * goedgekeurd. Roept de agent daarna nog eens `git commit` aan — bijvoorbeeld omdat
 * een pre-commit hook van git zelf faalde — dan hoeft er niet opnieuw gereviewd te
 * worden. Verandert er ook maar iets aan de diff, dan verandert de hash en vervalt
 * het artifact vanzelf.
 */

/** Artifacts ouder dan dit vervallen; een goedkeuring van gisteren zegt niets. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface Approval {
  diffHash: string;
  reviewId: string;
  approvedAt: string;
  claudeSessionId: string | null;
  /** Door de reviewer aangepaste commit message, of null. */
  editedCommitMessage: string | null;
  summary: string | null;
}

function dir(gitDir: string): string {
  return path.join(gitDir, "reviewgate", "approved");
}

function fileFor(gitDir: string, diffHash: string): string {
  return path.join(dir(gitDir), `${diffHash}.json`);
}

export async function writeApproval(gitDir: string, approval: Approval): Promise<void> {
  await fs.mkdir(dir(gitDir), { recursive: true });
  const file = fileFor(gitDir, approval.diffHash);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/** Een geldig artifact voor deze diff, of null. Verlopen artifacts ruimen we op. */
export async function readApproval(
  gitDir: string,
  diffHash: string,
  now = Date.now(),
): Promise<Approval | null> {
  const file = fileFor(gitDir, diffHash);
  let approval: Approval;
  try {
    approval = JSON.parse(await fs.readFile(file, "utf8")) as Approval;
  } catch {
    return null;
  }
  if (approval.diffHash !== diffHash) return null;

  const age = now - Date.parse(approval.approvedAt);
  if (!Number.isFinite(age) || age > APPROVAL_TTL_MS || age < -60_000) {
    await fs.rm(file, { force: true });
    return null;
  }
  return approval;
}

/** Na een geslaagde commit is het artifact op. */
export async function consumeApproval(gitDir: string, diffHash: string): Promise<void> {
  await fs.rm(fileFor(gitDir, diffHash), { force: true });
}
