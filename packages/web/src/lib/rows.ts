import type { DiffHunk, DiffLineType } from "@reviewgate/core/api";

/**
 * Het rijmodel dat beide views renderen. Bewust een pure functie zonder React:
 * context-expansie en de koppeling tussen oude en nieuwe regelnummers zijn precies
 * het soort logica dat je wil kunnen testen zonder een browser.
 */

export interface LineRow {
  kind: "line";
  /** Uit een hunk, of bijgeladen via context-expansie. */
  source: "hunk" | "expanded";
  type: DiffLineType;
  content: string;
  oldLine: number | null;
  newLine: number | null;
  /** Positie in het detail, zodat de view de juiste tokens en segmenten vindt. */
  hunkIndex: number | null;
  lineIndex: number | null;
}

export interface HunkRow {
  kind: "hunk";
  hunkIndex: number;
  section: string;
  oldStart: number;
  newStart: number;
}

export interface ExpanderRow {
  kind: "expander";
  gapIndex: number;
  /** Aantal regels dat in dit gat nog verborgen is. */
  hidden: number;
  /** Of er boven en onder dit gat een hunk staat; bepaalt welke knoppen zin hebben. */
  hasAbove: boolean;
  hasBelow: boolean;
}

export type Row = LineRow | HunkRow | ExpanderRow;

/** Hoeveel regels een gap-expansie per klik onthult (§8). */
export const EXPAND_STEP = 10;

export interface GapExpansion {
  /** Regels onthuld vanaf de bovenkant van het gat. */
  top: number;
  /** Regels onthuld vanaf de onderkant van het gat. */
  bottom: number;
}

export type ExpansionState = Readonly<Record<number, GapExpansion | undefined>>;

export interface BuildRowsInput {
  hunks: readonly DiffHunk[];
  oldLineCount: number;
  newLineCount: number;
  /** Volledige bestandsinhoud per regel; null als die kant niet beschikbaar is. */
  linesOld: readonly string[] | null;
  linesNew: readonly string[] | null;
  expansion: ExpansionState;
}

interface Gap {
  index: number;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  hidden: number;
  hasAbove: boolean;
  hasBelow: boolean;
}

/** De gaten tussen de hunks, inclusief het gat vóór de eerste en na de laatste. */
export function computeGaps(input: {
  hunks: readonly DiffHunk[];
  oldLineCount: number;
  newLineCount: number;
}): Gap[] {
  const gaps: Gap[] = [];
  let lastOld = 0;
  let lastNew = 0;

  input.hunks.forEach((h, i) => {
    const oldStart = lastOld + 1;
    const oldEnd = h.oldStart - 1;
    const newStart = lastNew + 1;
    const newEnd = h.newStart - 1;
    const hidden = Math.max(0, oldEnd - oldStart + 1, newEnd - newStart + 1);
    gaps.push({
      index: i,
      oldStart,
      oldEnd,
      newStart,
      newEnd,
      hidden,
      hasAbove: i > 0,
      hasBelow: true,
    });
    // Een hunk met 0 regels aan één kant verbruikt aan die kant niets; git noemt
    // dan het regelnummer ervóór.
    lastOld = h.oldLines === 0 ? h.oldStart : h.oldStart + h.oldLines - 1;
    lastNew = h.newLines === 0 ? h.newStart : h.newStart + h.newLines - 1;
  });

  const tailOldStart = lastOld + 1;
  const tailNewStart = lastNew + 1;
  const tailHidden = Math.max(
    0,
    input.oldLineCount - tailOldStart + 1,
    input.newLineCount - tailNewStart + 1,
  );
  gaps.push({
    index: input.hunks.length,
    oldStart: tailOldStart,
    oldEnd: input.oldLineCount,
    newStart: tailNewStart,
    newEnd: input.newLineCount,
    hidden: tailHidden,
    hasAbove: input.hunks.length > 0,
    hasBelow: false,
  });

  return gaps;
}

export function buildRows(input: BuildRowsInput): Row[] {
  const gaps = computeGaps(input);
  const rows: Row[] = [];

  const canExpand = input.linesNew !== null || input.linesOld !== null;

  gaps.forEach((gap, i) => {
    if (gap.hidden > 0 && canExpand) {
      rows.push(...gapRows(gap, input));
    }
    const hunk = input.hunks[i];
    if (!hunk) return;
    rows.push({
      kind: "hunk",
      hunkIndex: i,
      section: hunk.section,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
    });
    hunk.lines.forEach((l, lineIndex) => {
      rows.push({
        kind: "line",
        source: "hunk",
        type: l.type,
        content: l.content,
        oldLine: l.oldLine,
        newLine: l.newLine,
        hunkIndex: i,
        lineIndex,
      });
    });
  });

  return rows;
}

function gapRows(gap: Gap, input: BuildRowsInput): Row[] {
  const exp = input.expansion[gap.index] ?? { top: 0, bottom: 0 };
  const top = Math.min(exp.top, gap.hidden);
  const bottom = Math.min(exp.bottom, gap.hidden - top);
  const remaining = gap.hidden - top - bottom;

  const rows: Row[] = [];
  // Van boven af tellen we vanaf het begin van het gat, van onder af vanaf de hunk
  // eronder. In een echte diff is een gat aan beide kanten even lang, dus vallen
  // die twee samen; bij een scheve gaptelling blijft de kant die je uitklapt kloppen.
  for (let k = 0; k < top; k++) {
    rows.push(contextRow(gap.oldStart + k, gap.newStart + k, gap, input));
  }
  if (remaining > 0) {
    rows.push({
      kind: "expander",
      gapIndex: gap.index,
      hidden: remaining,
      hasAbove: gap.hasAbove,
      hasBelow: gap.hasBelow,
    });
  }
  for (let k = bottom - 1; k >= 0; k--) {
    rows.push(contextRow(gap.oldEnd - k, gap.newEnd - k, gap, input));
  }
  return rows;
}

/** Eén onthulde contextregel, met de nummers van beide kanten erbij. */
function contextRow(
  oldLine: number,
  newLine: number,
  gap: Gap,
  input: BuildRowsInput,
): LineRow {
  const oldOk = oldLine >= gap.oldStart && oldLine <= gap.oldEnd;
  const newOk = newLine >= gap.newStart && newLine <= gap.newEnd;
  const fromNew = newOk ? input.linesNew?.[newLine - 1] : undefined;
  const fromOld = oldOk ? input.linesOld?.[oldLine - 1] : undefined;
  return {
    kind: "line",
    source: "expanded",
    type: "context",
    content: fromNew ?? fromOld ?? "",
    oldLine: oldOk ? oldLine : null,
    newLine: newOk ? newLine : null,
    hunkIndex: null,
    lineIndex: null,
  };
}

// --- split view ------------------------------------------------------------

export interface PairRow {
  kind: "pair";
  left: LineRow | null;
  right: LineRow | null;
}

export type SplitRow = HunkRow | ExpanderRow | PairRow;

/**
 * Zet de unified rijen om in linker/rechter paren. Een blok verwijderde regels
 * wordt positioneel gekoppeld aan het blok toegevoegde regels erna, wat dezelfde
 * koppeling is als die de intraline-highlight gebruikt.
 */
export function toSplitRows(rows: readonly Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;

  while (i < rows.length) {
    const row = rows[i] as Row;

    if (row.kind !== "line") {
      out.push(row);
      i++;
      continue;
    }

    if (row.type === "context") {
      out.push({ kind: "pair", left: row, right: row });
      i++;
      continue;
    }

    const dels: LineRow[] = [];
    while (i < rows.length) {
      const r = rows[i];
      if (r?.kind !== "line" || r.type !== "del") break;
      dels.push(r);
      i++;
    }
    const adds: LineRow[] = [];
    while (i < rows.length) {
      const r = rows[i];
      if (r?.kind !== "line" || r.type !== "add") break;
      adds.push(r);
      i++;
    }

    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      out.push({ kind: "pair", left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }

  return out;
}

/** Volgende expansiestand na een klik op een van de knoppen van een gat. */
export function expand(
  current: GapExpansion | undefined,
  hidden: number,
  action: "top" | "bottom" | "all",
): GapExpansion {
  const base = current ?? { top: 0, bottom: 0 };
  if (action === "all") return { top: hidden, bottom: 0 };
  const room = hidden - base.top - base.bottom;
  const step = Math.min(EXPAND_STEP, Math.max(0, room));
  return action === "top"
    ? { top: base.top + step, bottom: base.bottom }
    : { top: base.top, bottom: base.bottom + step };
}
