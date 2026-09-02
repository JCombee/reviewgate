import { ReviewStore } from "../review/store.js";
import type { Decision, Review } from "../review/types.js";

export interface WaitResult {
  decision: Decision;
  review: Review;
}

export interface WaitOptions {
  /** How long the hook blocks at most. After that it is a timeout (§2). */
  timeoutMs: number;
  /** How often we re-read the review file. */
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Waits until a decision is made in the UI.
 *
 * We poll the review file on disk instead of sharing a promise in memory: the server
 * often runs in a *different* process than the hook, and a server restart must not
 * leave the hook hanging forever (§7). The file is the source of truth and survives
 * both.
 */
export async function waitForDecision(
  gitDir: string,
  reviewId: string,
  opts: WaitOptions,
): Promise<WaitResult | null> {
  const store = new ReviewStore(gitDir);
  const interval = opts.intervalMs ?? 400;
  const deadline = Date.now() + opts.timeoutMs;

  for (;;) {
    const review = await store.load(reviewId);
    const round = review?.rounds[review.rounds.length - 1];
    if (review && round?.decision && round.decision !== "timeout") {
      return { decision: round.decision, review };
    }
    if (opts.signal?.aborted || Date.now() >= deadline) return null;
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
