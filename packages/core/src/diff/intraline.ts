import type { DiffHunk, DiffLine } from "../types.js";

/**
 * A piece of a line that is or is not changed. The UI colours only the changed
 * pieces brightly; the line background itself stays low-saturation (§8).
 */
export interface IntralineSegment {
  start: number;
  end: number;
}

export interface IntralinePair {
  /** Index of the deleted line within `hunk.lines`. */
  delIndex: number;
  /** Index of the added line within `hunk.lines`. */
  addIndex: number;
  delSegments: IntralineSegment[];
  addSegments: IntralineSegment[];
}

/**
 * Above this line length we skip per-character comparison: it yields no readable
 * highlight on such lines anyway, and it costs needless time on generated files with
 * lines thousands of characters long.
 */
const MAX_LINE_LENGTH = 2000;

/**
 * If more than this share of the line differs, it is not an edit but a replacement.
 * Highlighting everything is noise then, so we leave the line unmarked.
 */
const MAX_CHANGE_RATIO = 0.6;

/**
 * Pairs deleted with added lines inside a hunk and works out, per pair, which pieces
 * actually differ.
 *
 * The pairing is positional: the nth minus block belongs with the nth plus block,
 * just like git-diff itself does. That is predictable and unit-testable.
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
    // We pair one-to-one only for blocks of equal length. With unequal blocks there
    // is no reliable pairing, so we leave it alone.
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
 * The differing pieces between two lines, or null when marking makes no sense
 * (identical, too long, or too much difference to still be an edit).
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
 * Splits a line into tokens: words, individual punctuation and runs of whitespace.
 * Comparing on word boundaries gives a calmer highlight than per character, which
 * quickly falls apart into loose letters in code.
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

/** Character position of token range [from, to) within the original line. */
function spanOf(tokens: readonly string[], from: number, to: number): IntralineSegment {
  let start = 0;
  for (let i = 0; i < from; i++) start += (tokens[i] as string).length;
  let end = start;
  for (let i = from; i < to; i++) end += (tokens[i] as string).length;
  return { start, end };
}
