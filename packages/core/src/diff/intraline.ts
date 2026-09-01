import type { DiffHunk, DiffLine } from "../types.js";

/**
 * Een stuk van een regel dat wel of niet gewijzigd is. De UI kleurt alleen de
 * gewijzigde stukken fel; het regelvlak zelf blijft laag verzadigd (§8).
 */
export interface IntralineSegment {
  start: number;
  end: number;
}

export interface IntralinePair {
  /** Index van de verwijderde regel binnen `hunk.lines`. */
  delIndex: number;
  /** Index van de toegevoegde regel binnen `hunk.lines`. */
  addIndex: number;
  delSegments: IntralineSegment[];
  addSegments: IntralineSegment[];
}

/**
 * Boven deze regellengte slaan we het per-teken vergelijken over: het levert bij
 * zulke regels toch geen leesbare highlight op en het kost onnodig tijd bij
 * gegenereerde bestanden met regels van duizenden tekens.
 */
const MAX_LINE_LENGTH = 2000;

/**
 * Als meer dan dit aandeel van de regel verschilt, is het geen bewerking maar een
 * vervanging. Alles highlighten is dan ruis, dus laten we de regel ongemarkeerd.
 */
const MAX_CHANGE_RATIO = 0.6;

/**
 * Koppelt verwijderde aan toegevoegde regels binnen een hunk en berekent per paar
 * welke stukken daadwerkelijk verschillen.
 *
 * De koppeling is positioneel: het n-de min-blok hoort bij het n-de plus-blok, net
 * zoals git-diff dat zelf doet. Dat is voorspelbaar en unit-testbaar.
 */
export function intralineDiff(hunk: DiffHunk): IntralinePair[] {
  const pairs: IntralinePair[] = [];
  const lines = hunk.lines;

  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.type !== "del") {
      i++;
      continue;
    }

    const delStart = i;
    while (lines[i]?.type === "del") i++;
    const addStart = i;
    while (lines[i]?.type === "add") i++;

    const delCount = addStart - delStart;
    const addCount = i - addStart;
    // Alleen blokken met evenveel regels aan beide kanten koppelen we één-op-één.
    // Bij ongelijke blokken is er geen betrouwbare koppeling en laten we het.
    if (delCount === 0 || addCount === 0 || delCount !== addCount) continue;

    for (let k = 0; k < delCount; k++) {
      const delIndex = delStart + k;
      const addIndex = addStart + k;
      const before = lines[delIndex] as DiffLine;
      const after = lines[addIndex] as DiffLine;
      const seg = segmentsFor(before.content, after.content);
      if (seg) pairs.push({ delIndex, addIndex, ...seg });
    }
  }

  return pairs;
}

/**
 * Verschilstukken tussen twee regels, of null als markeren geen zin heeft
 * (identiek, te lang, of te veel verschil om nog een bewerking te zijn).
 */
export function segmentsFor(
  before: string,
  after: string,
): { delSegments: IntralineSegment[]; addSegments: IntralineSegment[] } | null {
  if (before === after) return null;
  if (before.length > MAX_LINE_LENGTH || after.length > MAX_LINE_LENGTH) return null;

  const a = tokenize(before);
  const b = tokenize(after);

  const prefix = commonPrefix(a, b);
  const suffix = commonSuffix(a, b, prefix);

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);

  const changedChars =
    aMid.reduce((n, t) => n + t.length, 0) + bMid.reduce((n, t) => n + t.length, 0);
  const totalChars = before.length + after.length;
  if (totalChars > 0 && changedChars / totalChars > MAX_CHANGE_RATIO) return null;

  const delSegments = aMid.length > 0 ? [spanOf(a, prefix, a.length - suffix)] : [];
  const addSegments = bMid.length > 0 ? [spanOf(b, prefix, b.length - suffix)] : [];
  if (delSegments.length === 0 && addSegments.length === 0) return null;

  return { delSegments, addSegments };
}

// ---------------------------------------------------------------------------

/**
 * Splitst een regel in tokens: woorden, losse leestekens en aaneengesloten
 * whitespace. Op woordgrens vergelijken geeft een rustiger highlight dan per
 * teken, dat bij code snel uiteenvalt in losse letters.
 */
function tokenize(s: string): string[] {
  return s.match(/[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu) ?? [];
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a[n] === b[n]) n++;
  return n;
}

function commonSuffix(a: readonly string[], b: readonly string[], prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let n = 0;
  while (n < max && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Tekenpositie van tokenbereik [from, to) binnen de oorspronkelijke regel. */
function spanOf(tokens: readonly string[], from: number, to: number): IntralineSegment {
  let start = 0;
  for (let i = 0; i < from; i++) start += (tokens[i] as string).length;
  let end = start;
  for (let i = from; i < to; i++) end += (tokens[i] as string).length;
  return { start, end };
}
