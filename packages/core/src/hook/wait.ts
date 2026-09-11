import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import { ReviewStore } from "../review/store.js";
import type { Decision, Review } from "../review/types.js";

export interface WaitResult {
  decision: Decision;
  review: Review;
}

export interface WaitOptions {
  /** How long the hook blocks at most. After that it is a timeout (§2). */
  timeoutMs: number;
  /** How often we re-read the review file when the watcher tells us nothing. */
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Waits until a decision is made in the UI.
 *
 * We read the review file on disk instead of sharing a promise in memory: the server
 * often runs in a *different* process than the hook, and a server restart must not
 * leave the hook hanging forever (§7). The file is the source of truth and survives
 * both.
 *
 * A watcher on the review directory turns the store's write into a wake-up, so the
 * gate lifts within milliseconds of the click rather than at the next tick of a timer.
 * The timer stays as the fallback: `fs.watch` is not reliable everywhere — network
 * mounts and some containers deliver nothing — and a gate that only reacts fast is
 * worth less than one that always reacts.
 */
export async function waitForDecision(
  gitDir: string,
  reviewId: string,
  opts: WaitOptions,
): Promise<WaitResult | null> {
  const store = new ReviewStore(gitDir);
  const interval = opts.intervalMs ?? 400;
  const deadline = Date.now() + opts.timeoutMs;

  let wake: (() => void) | null = null;
  const watcher = await openWatcher(store.dir, reviewId, () => wake?.());
  const onAbort = () => wake?.();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      const review = await store.load(reviewId);
      const round = review?.rounds[review.rounds.length - 1];
      if (review && round?.decision && round.decision !== "timeout") {
        return { decision: round.decision, review };
      }
      if (opts.signal?.aborted || Date.now() >= deadline) return null;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now())));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    watcher?.close();
  }
}

/**
 * Watches the review directory. The store writes to a temporary file and renames it,
 * so the interesting event is a rename of `<id>.json`; on platforms that report no
 * filename at all we wake on everything and let the next read decide.
 */
async function openWatcher(
  dir: string,
  reviewId: string,
  onChange: () => void,
): Promise<FSWatcher | null> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const watcher = watch(dir, (_event, filename) => {
      if (!filename || filename.toString().startsWith(`${reviewId}.json`)) onChange();
    });
    // A watcher that dies takes nothing with it: the timer keeps the loop going.
    watcher.on("error", () => watcher.close());
    watcher.unref?.();
    return watcher;
  } catch {
    return null;
  }
}
