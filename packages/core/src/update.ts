import { REPO } from "./version.js";

export interface LatestTag {
  tag: string | null;
  /** `none` when the repo simply has no releases; that is not a failure to report as one. */
  reason: "ok" | "none" | "unreachable";
}

/** The newest non-prerelease tag on GitHub. */
export async function latestTag(): Promise<LatestTag> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "reviewgate" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { tag: null, reason: "none" };
    if (!res.ok) return { tag: null, reason: "unreachable" };
    const body = (await res.json()) as { tag_name?: unknown };
    if (typeof body.tag_name !== "string") return { tag: null, reason: "none" };
    return { tag: body.tag_name, reason: "ok" };
  } catch {
    return { tag: null, reason: "unreachable" };
  }
}

/** Compares vMAJOR.MINOR.PATCH tags; a build from source is always behind. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
