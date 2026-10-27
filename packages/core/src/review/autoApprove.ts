import fs from "node:fs/promises";
import path from "node:path";

/**
 * The auto-approve switch: while it is on, the hook lets every commit in this repo
 * through without a review, so an agent can work on its own for a while.
 *
 * Deliberately not a key in `.reviewgate.json`. That file is in the working tree, so
 * the agent could turn the gate off with a one-line edit, and the switch would travel
 * with the repo to every clone. A file under `.git/reviewgate/` is never part of a
 * diff and belongs to this checkout alone.
 */

export interface AutoApprove {
  enabledAt: string;
}

function fileFor(gitDir: string): string {
  return path.join(gitDir, "reviewgate", "auto-approve.json");
}

/** The switch when it is on, or null. An unreadable file counts as off. */
export async function readAutoApprove(gitDir: string): Promise<AutoApprove | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(fileFor(gitDir), "utf8")) as Partial<AutoApprove>;
    return typeof parsed.enabledAt === "string" ? { enabledAt: parsed.enabledAt } : null;
  } catch {
    return null;
  }
}

export async function setAutoApprove(gitDir: string, on: boolean, now = new Date()): Promise<void> {
  const file = fileFor(gitDir);
  if (!on) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const value: AutoApprove = { enabledAt: now.toISOString() };
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Does this Bash command try to switch auto-approve on? The hook refuses it: the agent
 * must not be the one to lift its own gate. Matched on the raw string rather than on
 * parsed argv, so `bash -c "reviewgate auto-approve on"` is caught as well.
 */
export function enablesAutoApprove(command: string): boolean {
  return /\bauto-approve\s+on\b/.test(command);
}
