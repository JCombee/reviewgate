import { randomUUID } from "node:crypto";
import type { Review, Severity, Suggestion } from "./types.js";

/**
 * The rules around suggestions from §9, as pure functions.
 *
 * Suggestions are *not* comments: they do not count towards the button and they do
 * not go to Claude. The agent may draw your attention to something, but it may not
 * put a judgement into the review on your behalf.
 */

export interface SuggestionCapConfig {
  /** Changed lines per allowed suggestion. Default: 25. */
  perLines: number;
  min: number;
  max: number;
}

export const DEFAULT_CAP: SuggestionCapConfig = { perLines: 25, min: 2, max: 20 };

/**
 * The most suggestions there may be: two per fifty changed lines, with 2 as a floor
 * and 20 as a safety valve.
 *
 * It is a ceiling, not a target — zero suggestions is a valid outcome.
 */
export function suggestionCap(changedLines: number, config = DEFAULT_CAP): number {
  const raw = Math.ceil(Math.max(0, changedLines) / config.perLines);
  return Math.min(config.max, Math.max(config.min, raw));
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  blocker: 0,
  consideration: 1,
  nit: 2,
};

/**
 * The cap is enforced server-side, not merely requested in the prompt. If the agent
 * hands over more, we keep the highest severity first, then file order and line
 * number (§9).
 */
export function applyCap<T extends Pick<Suggestion, "severity" | "path" | "startLine">>(
  suggestions: readonly T[],
  cap: number,
): { kept: T[]; dropped: T[] } {
  const sorted = [...suggestions].sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    const p = (a.path ?? "").localeCompare(b.path ?? "");
    if (p !== 0) return p;
    return (a.startLine ?? 0) - (b.startLine ?? 0);
  });
  return { kept: sorted.slice(0, cap), dropped: sorted.slice(cap) };
}

export interface DedupeConfig {
  /** Threshold within the same file on overlapping lines. */
  overlapping: number;
  /** Threshold regardless of location. */
  anywhere: number;
}

export const DEFAULT_DEDUPE: DedupeConfig = { overlapping: 0.6, anywhere: 0.8 };

export interface DuplicateMatch {
  duplicateOf: string;
  score: number;
}

/**
 * Looks for an earlier dismissed suggestion that says virtually the same thing.
 *
 * Deterministic and unit-testable, not a model judgement: normalise the text and
 * compare with Jaccard similarity. Only suggestions *you* dismissed suppress
 * repetition; suggestions closed along with a decision were never judged by you and
 * so may come back (§9).
 */
export function findDuplicate(
  candidate: Pick<Suggestion, "body" | "path" | "startLine" | "endLine">,
  earlier: readonly Suggestion[],
  config = DEFAULT_DEDUPE,
): DuplicateMatch | null {
  const suppressing = earlier.filter(
    (s) =>
      s.status === "dismissed" &&
      (s.dismissedReason === "user" || s.dismissedReason === "auto_duplicate"),
  );

  let best: DuplicateMatch | null = null;
  for (const other of suppressing) {
    const score = similarity(candidate.body, other.body);
    const sameFile = candidate.path !== undefined && candidate.path === other.path;
    const threshold = sameFile && rangesOverlap(candidate, other) ? config.overlapping : config.anywhere;
    if (score >= threshold && (best === null || score > best.score)) {
      best = { duplicateOf: other.id, score };
    }
  }
  return best;
}

/**
 * Jaccard similarity over the words of the normalised text.
 *
 * The plan called for word trigrams, but those are far too strict for the thresholds
 * it also states: "this fetch has no error handling" against "this fetch still has no
 * error handling" scores 0.25 on trigrams, well below 0.6 — deduplication would
 * practically never fire. At word level that same pair is 0.75, which does fit 0.6
 * within a file and 0.8 outside it.
 */
export function similarity(a: string, b: string): number {
  const ta = words(normalize(a));
  const tb = words(normalize(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;

  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Lowercase, punctuation and line numbers stripped, whitespace collapsed. Line
 * numbers go explicitly: the same remark on a shifted line is the same remark.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bl?\d+([-–]\d+)?\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): Set<string> {
  return new Set(text.split(" ").filter((w) => w !== ""));
}

function rangesOverlap(
  a: Pick<Suggestion, "startLine" | "endLine">,
  b: Pick<Suggestion, "startLine" | "endLine">,
): boolean {
  if (a.startLine === undefined || b.startLine === undefined) return false;
  const aEnd = a.endLine ?? a.startLine;
  const bEnd = b.endLine ?? b.startLine;
  return a.startLine <= bEnd && b.startLine <= aEnd;
}

export interface IncomingSuggestion {
  scope: Suggestion["scope"];
  body: string;
  severity: Severity;
  path?: string;
  side?: Suggestion["side"];
  startLine?: number;
  endLine?: number;
  anchorSnippet?: string;
}

export interface AddSuggestionsResult {
  review: Review;
  added: Suggestion[];
  /** Automatically dismissed duplicates, with their score for the dedupe log (§15). */
  duplicates: Array<{ suggestion: Suggestion; score: number }>;
  /** Cut off by the cap; lands in the session file, not in the UI. */
  dropped: IncomingSuggestion[];
}

/**
 * Adds the findings of a pass: dedupe first, then the cap over what remains.
 * Automatically dismissed duplicates do not count towards the cap, otherwise the
 * history would crowd out the new findings (§9).
 */
export function addSuggestions(
  review: Review,
  incoming: readonly IncomingSuggestion[],
  options: { cap: number; dedupe?: DedupeConfig },
): AddSuggestionsResult {
  const round = review.rounds[review.rounds.length - 1]?.n ?? 1;
  const now = new Date().toISOString();

  const duplicates: Array<{ suggestion: Suggestion; score: number }> = [];
  const fresh: IncomingSuggestion[] = [];

  for (const item of incoming) {
    const match = findDuplicate(item, review.suggestions, options.dedupe);
    if (match) {
      duplicates.push({
        suggestion: build(item, round, now, {
          status: "dismissed",
          dismissedReason: "auto_duplicate",
          duplicateOf: match.duplicateOf,
        }),
        score: match.score,
      });
    } else {
      fresh.push(item);
    }
  }

  const { kept, dropped } = applyCap(
    fresh.map((f) => ({ ...f, severity: f.severity })),
    options.cap,
  );

  const added = kept.map((item) => build(item, round, now, { status: "pending" }));
  const all = [...review.suggestions, ...added, ...duplicates.map((d) => d.suggestion)];

  return { review: { ...review, suggestions: all }, added, duplicates, dropped };
}

function build(
  item: IncomingSuggestion,
  round: number,
  createdAt: string,
  state: Pick<Suggestion, "status"> & Partial<Pick<Suggestion, "dismissedReason" | "duplicateOf">>,
): Suggestion {
  return {
    id: randomUUID(),
    round,
    scope: item.scope,
    body: item.body.trim(),
    severity: item.severity,
    createdAt,
    ...(item.path !== undefined ? { path: item.path } : {}),
    ...(item.side !== undefined ? { side: item.side } : {}),
    ...(item.startLine !== undefined ? { startLine: item.startLine } : {}),
    ...(item.endLine !== undefined ? { endLine: item.endLine } : {}),
    ...(item.anchorSnippet !== undefined ? { anchorSnippet: item.anchorSnippet } : {}),
    ...state,
  };
}

/**
 * Dismissing a suggestion. It never disappears: it stays in the file and in the UI,
 * so you can look back at what was proposed and what you did with it.
 */
export function dismissSuggestion(review: Review, id: string): Review {
  return mapSuggestion(review, id, (s) => ({
    ...s,
    status: "dismissed",
    dismissedReason: "user",
  }));
}

/** Reopening an automatically dismissed duplicate; you keep the last word. */
export function reopenSuggestion(review: Review, id: string): Review {
  return mapSuggestion(review, id, (s) => {
    const { dismissedReason: _reason, duplicateOf: _dup, ...rest } = s;
    return { ...rest, status: "pending" };
  });
}

/** Marks a suggestion as accepted; `addComment` makes the comment itself. */
export function acceptSuggestion(review: Review, id: string, commentId: string): Review {
  return mapSuggestion(review, id, (s) => ({
    ...s,
    status: "accepted",
    promotedToCommentId: commentId,
  }));
}

/**
 * On a decision, open suggestions close with reason `round_closed`. Those suppress
 * no repetition: you never judged them (§9).
 */
export function closeOpenSuggestions(review: Review): Review {
  return {
    ...review,
    suggestions: review.suggestions.map((s) =>
      s.status === "pending"
        ? { ...s, status: "dismissed" as const, dismissedReason: "round_closed" as const }
        : s,
    ),
  };
}

function mapSuggestion(review: Review, id: string, fn: (s: Suggestion) => Suggestion): Review {
  return { ...review, suggestions: review.suggestions.map((s) => (s.id === id ? fn(s) : s)) };
}
