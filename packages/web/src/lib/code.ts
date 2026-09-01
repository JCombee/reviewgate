import type { HighlightLine, IntralineSegment, PaletteEntry } from "@reviewgate/core/api";

/** Eén te renderen stukje regel: tekst, themakleuren, en of het gewijzigd is. */
export interface Piece {
  text: string;
  light: string;
  dark: string;
  changed: boolean;
}

/**
 * Legt de intraline-segmenten over de shiki-tokens heen.
 *
 * De twee weten niets van elkaar: shiki knipt op grammatica, de segmenten op
 * woordgrens. Hier worden ze op tekenpositie samengevoegd, zodat een gewijzigd
 * woord midden in een token alsnog precies gemarkeerd wordt.
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
      // Knip het token op de eerstvolgende segmentgrens die erbinnen valt.
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
 * Reconstrueert de bestandsregels uit de tokens, zodat context-expansie geen
 * tweede request nodig heeft: de tekst zit al in wat we voor de highlighting
 * hebben opgehaald.
 */
export function linesFromTokens(lines: HighlightLine[] | null): string[] | null {
  if (!lines) return null;
  return lines.map((toks) => toks.map((t) => t.t).join(""));
}
