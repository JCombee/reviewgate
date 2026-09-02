import fs from "node:fs/promises";
import path from "node:path";

/**
 * The approval artifact (§2): after an Approve, the server records that *this* diff
 * was approved. If the agent then calls `git commit` again — because a pre-commit
 * hook of git's own failed, say — there is no need to review it a second time. Change
 * anything at all about the diff and the hash changes, so the artifact lapses by
 * itself.
 */

/** Artifacts older than this lapse; yesterday's approval says nothing. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface Approval {
  diffHash: string;
  reviewId: string;
  approvedAt: string;
  claudeSessionId: string | null;
  /** Commit message adjusted by the reviewer, or null. */
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

/** A valid artifact for this diff, or null. Expired artifacts get cleaned up. */
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

/** After a successful commit the artifact is spent. */
export async function consumeApproval(gitDir: string, diffHash: string): Promise<void> {
  await fs.rm(fileFor(gitDir, diffHash), { force: true });
}
