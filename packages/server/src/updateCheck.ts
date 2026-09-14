import { isNewer, latestTag, type LatestTag } from "@reviewgate/core";
import type { UpdateCheckResult } from "@reviewgate/core/api";
import { readUpdateCheckCache, writeUpdateCheckCache } from "./lockfile.js";

/** Today's date on the *local* machine clock, as "YYYY-MM-DD" — not `toISOString()`'s UTC day. */
function localDateStamp(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * `GET /api/update-check` (§5, FR-008): calls GitHub's releases API at most once per
 * calendar day (local machine clock), caching the verdict — including a failed or
 * unreachable check — in `stateDir(gitDir)` so later calls the same day, and a
 * missing/corrupt cache, are both handled without ever double-checking GitHub.
 *
 * `fetchLatest` defaults to the real `latestTag()` and exists so tests can substitute
 * a fake lookup instead of hitting the network.
 */
export async function checkForUpdate(
  gitDir: string,
  current: string,
  fetchLatest: () => Promise<LatestTag> = latestTag,
): Promise<UpdateCheckResult> {
  const today = localDateStamp();

  const cached = await readUpdateCheckCache(gitDir);
  if (cached && cached.date === today) {
    return { current, latest: cached.latest, updateAvailable: cached.updateAvailable };
  }

  const result = await fetchLatest();
  const latest = result.tag;
  const updateAvailable = latest !== null && isNewer(latest, current);

  await writeUpdateCheckCache(gitDir, { date: today, latest, updateAvailable });

  return { current, latest, updateAvailable };
}
