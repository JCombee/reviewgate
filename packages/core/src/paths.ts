import path from "node:path";

/**
 * Internally we work with POSIX paths, because that is what git returns and what
 * ends up in the review files. Only at actual filesystem contact do we convert back
 * to a platform path (§4).
 */
export function toPosix(p: string): string {
  return p.split(path.win32.sep).join(path.posix.sep);
}

/** A POSIX path back to one this platform's filesystem understands. */
export function toPlatform(p: string): string {
  return p.split(path.posix.sep).join(path.sep);
}

/** A repo-relative POSIX path to an absolute platform path inside the repo. */
export function resolveInRepo(repoRoot: string, relPosix: string): string {
  return path.resolve(repoRoot, toPlatform(relPosix));
}
