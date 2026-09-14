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
  /** Cut off by the cap; lands in the session file, not in the UI. */
  dropped: IncomingSuggestion[];
}

/**
 * Adds the findings of a pass: only the cap is applied.
 */
export function addSuggestions(
  review: Review,
  incoming: readonly IncomingSuggestion[],
  options: { cap: number },
): AddSuggestionsResult {
  const round = review.rounds[review.rounds.length - 1]?.n ?? 1;
  const now = new Date().toISOString();

  const { kept, dropped } = applyCap(
    incoming.map((f) => ({ ...f, severity: f.severity })),
    options.cap,
  );

  const added = kept.map((item) => build(item, round, now, { status: "pending" }));
  const all = [...review.suggestions, ...added];

  return { review: { ...review, suggestions: all }, added, dropped };
}

function build(
  item: IncomingSuggestion,
  round: number,
  createdAt: string,
  state: Pick<Suggestion, "status"> & Partial<Pick<Suggestion, "dismissedReason">>,
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

/** Reopening a dismissed suggestion; you keep the last word. */
export function reopenSuggestion(review: Review, id: string): Review {
  return mapSuggestion(review, id, (s) => {
    const { dismissedReason: _reason, ...rest } = s;
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
