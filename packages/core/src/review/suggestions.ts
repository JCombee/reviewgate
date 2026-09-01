import { randomUUID } from "node:crypto";
import type { Review, Severity, Suggestion } from "./types.js";

/**
 * De regels rond suggesties uit §9, als pure functies.
 *
 * Suggesties zijn géén comments: ze tellen niet mee voor de knop en gaan niet naar
 * Claude. De agent mag je aandacht ergens op vestigen, maar mag niet namens jou een
 * oordeel in de review zetten.
 */

export interface SuggestionCapConfig {
  /** Aantal gewijzigde regels per toegestaan voorstel. Default: 25. */
  perLines: number;
  min: number;
  max: number;
}

export const DEFAULT_CAP: SuggestionCapConfig = { perLines: 25, min: 2, max: 20 };

/**
 * Hoeveel voorstellen er hoogstens mogen zijn: twee per vijftig gewijzigde regels,
 * met 2 als ondergrens en 20 als veiligheidsklep.
 *
 * Het is een plafond, geen doel — nul voorstellen is een geldige uitkomst.
 */
export function suggestionCap(changedLines: number, config = DEFAULT_CAP): number {
  const raw = Math.ceil(Math.max(0, changedLines) / config.perLines);
  return Math.min(config.max, Math.max(config.min, raw));
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  blocker: 0,
  aandachtspunt: 1,
  nit: 2,
};

/**
 * De cap wordt server-side afgedwongen, niet alleen in de prompt gevraagd. Levert
 * de agent er meer, dan houden we de hoogste severity aan, daarna bestandsvolgorde
 * en regelnummer (§9).
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
  /** Drempel bij hetzelfde bestand met overlappende regels. */
  overlapping: number;
  /** Drempel ongeacht locatie. */
  anywhere: number;
}

export const DEFAULT_DEDUPE: DedupeConfig = { overlapping: 0.6, anywhere: 0.8 };

export interface DuplicateMatch {
  duplicateOf: string;
  score: number;
}

/**
 * Zoekt een eerder afgewezen voorstel dat vrijwel hetzelfde zegt.
 *
 * Deterministisch en unit-testbaar, geen model-oordeel: normaliseer de tekst en
 * vergelijk met Jaccard-similariteit over woord-trigrammen. Alleen voorstellen die
 * jij hebt afgewezen onderdrukken herhaling; voorstellen die bij een beslissing zijn
 * gesloten had je nooit beoordeeld en mogen dus terugkomen (§9).
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
 * Jaccard-similariteit over de woorden van de genormaliseerde tekst.
 *
 * Het plan noemde woord-trigrammen, maar die zijn veel te streng voor de drempels
 * die er ook in staan: "deze fetch heeft geen error-afhandeling" versus "deze fetch
 * heeft nog steeds geen error-afhandeling" komt op trigrammen uit op 0,25, ver onder
 * de 0,6 — de deduplicatie zou dan vrijwel nooit aanslaan. Op woordniveau is
 * datzelfde paar 0,75, en dat past wél bij 0,6 binnen een bestand en 0,8 daarbuiten.
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
 * Lowercase, leestekens en regelnummers eruit, whitespace inklappen. Regelnummers
 * horen er expliciet uit: dezelfde opmerking op een verschoven regel is dezelfde
 * opmerking.
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
  /** Automatisch afgewezen duplicaten, met hun score voor de dedupe-log (§15). */
  duplicates: Array<{ suggestion: Suggestion; score: number }>;
  /** Afgekapt door de cap; belandt in het sessiebestand, niet in de UI. */
  dropped: IncomingSuggestion[];
}

/**
 * Voegt de bevindingen van een pass toe: dedupe eerst, dan de cap over wat er
 * overblijft. Automatisch afgewezen duplicaten tellen niet mee voor de cap, anders
 * verdringt de historie de nieuwe bevindingen (§9).
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
 * Een voorstel afwijzen. Het verdwijnt nooit: het blijft in het bestand en in de
 * UI staan, zodat je kunt terugzien wat er is voorgesteld en wat je ermee deed.
 */
export function dismissSuggestion(review: Review, id: string): Review {
  return mapSuggestion(review, id, (s) => ({
    ...s,
    status: "dismissed",
    dismissedReason: "user",
  }));
}

/** Een automatisch afgewezen duplicaat alsnog heropenen; jij houdt het laatste woord. */
export function reopenSuggestion(review: Review, id: string): Review {
  return mapSuggestion(review, id, (s) => {
    const { dismissedReason: _reason, duplicateOf: _dup, ...rest } = s;
    return { ...rest, status: "pending" };
  });
}

/** Markeert een voorstel als overgenomen; de comment zelf maakt `addComment`. */
export function acceptSuggestion(review: Review, id: string, commentId: string): Review {
  return mapSuggestion(review, id, (s) => ({
    ...s,
    status: "accepted",
    promotedToCommentId: commentId,
  }));
}

/**
 * Bij een beslissing gaan openstaande voorstellen dicht met reden `round_closed`.
 * Die onderdrukken géén herhaling: je had ze nooit beoordeeld (§9).
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
