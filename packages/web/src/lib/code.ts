import type { HighlightLine, IntralineSegment, PaletteEntry } from "@reviewgate/core/api";

/** One renderable piece of a line: text, theme colours, and whether it changed. */
export interface Piece {
  text: string;
  light: string;
  dark: string;
  changed: boolean;
}

/**
 * Lays the intraline segments over the shiki tokens.
 *
 * The two know nothing of each other: shiki cuts on grammar, the segments on word
 * boundaries. Here they are merged on character position, so a changed word in the
 * middle of a token still gets marked precisely.
 */
export function toPieces(
  content: string,
  tokens: HighlightLine | null | undefined,
  palette: readonly PaletteEntry[] = [],
  segments: readonly IntralineSegment[] = [],
): Piece[] {
  const base: Piece[] =
    tokens && tokens.length > 0
      ? tokens.map((t) => ({
          text: t.t,
          light: palette[t.c]?.[0] ?? "",
          dark: palette[t.c]?.[1] ?? "",
          changed: false,
        }))
      : [{ text: content, light: "", dark: "", changed: false }];

  if (segments.length === 0) return base.filter((p) => p.text !== "");

  const bounds = new Set<number>();
  for (const s of segments) {
    bounds.add(s.start);
    bounds.add(s.end);
  }

  const out: Piece[] = [];
  let offset = 0;
  for (const piece of base) {
    let start = 0;
    const len = piece.text.length;
    while (start < len) {
      // Cut the token at the next segment boundary that falls inside it.
      let end = len;
      for (const b of bounds) {
        const local = b - offset;
        if (local > start && local < end) end = local;
      }
      const absStart = offset + start;
      out.push({
        text: piece.text.slice(start, end),
        light: piece.light,
        dark: piece.dark,
        changed: segments.some((s) => absStart >= s.start && absStart < s.end),
      });
      start = end;
    }
    offset += len;
  }

  return out.filter((p) => p.text !== "");
}

/**
 * Reconstructs the file lines from the tokens, so context expansion needs no second
 * request: the text is already in what we fetched for the highlighting.
 */
export function linesFromTokens(lines: HighlightLine[] | null): string[] | null {
  if (!lines) return null;
  return lines.map((toks) => toks.map((t) => t.t).join(""));
}
