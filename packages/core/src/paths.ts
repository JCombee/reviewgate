import path from "node:path";

/**
 * Intern werken we met POSIX-paden, want dat is wat git teruggeeft en wat in de
 * reviewbestanden terechtkomt. Alleen bij echt filesystem-contact converteren we
 * terug naar een platformpad (§4).
 */
export function toPosix(p: string): string {
  return p.split(path.win32.sep).join(path.posix.sep);
}

/** POSIX-pad terug naar een pad dat het filesystem van dit platform begrijpt. */
export function toPlatform(p: string): string {
  return p.split(path.posix.sep).join(path.sep);
}

/** Repo-relatief POSIX-pad naar een absoluut platformpad binnen de repo. */
export function resolveInRepo(repoRoot: string, relPosix: string): string {
  return path.resolve(repoRoot, toPlatform(relPosix));
}
