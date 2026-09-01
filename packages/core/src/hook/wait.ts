import { ReviewStore } from "../review/store.js";
import type { Decision, Review } from "../review/types.js";

export interface WaitResult {
  decision: Decision;
  review: Review;
}

export interface WaitOptions {
  /** Hoe lang de hook maximaal blokkeert. Daarna is het een timeout (§2). */
  timeoutMs: number;
  /** Hoe vaak we het reviewbestand teruglezen. */
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Wacht tot er in de UI een beslissing valt.
 *
 * We pollen het reviewbestand op schijf in plaats van een promise in het geheugen
 * te delen: de server draait vaak in een ánder proces dan de hook, en een
 * serverherstart mag de hook niet eeuwig laten hangen (§7). Het bestand is de
 * bron van waarheid en overleeft allebei.
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
