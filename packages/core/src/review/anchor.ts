import type { Comment, Side } from "./types.js";

/**
 * Comments meenemen naar een volgende ronde (§5).
 *
 * Bij een nieuwe ronde verschuiven regelnummers. Per openstaande comment:
 *
 * 1. Zoek `anchorSnippet` terug binnen ±40 regels rond het oude nummer. Exacte
 *    match → verplaats de comment.
 * 2. Precies één match elders in het bestand → verplaats en markeer als verplaatst.
 * 3. Geen of meerdere matches → `outdated`. Blijft zichtbaar in de UI, telt niet
 *    meer mee als openstaand.
 */

/** Hoe ver we rond het oude regelnummer zoeken voordat we het hele bestand afgaan. */
export const ANCHOR_WINDOW = 40;

export type AnchorOutcome = "unchanged" | "shifted" | "moved" | "outdated" | "skipped";

export interface AnchorResult {
  comment: Comment;
  outcome: AnchorOutcome;
  /** Regelnummer waar de comment stond, als hij verplaatst is. */
  from?: number;
}

/** De inhoud van de bestanden in de nieuwe ronde, per pad, per kant. */
export interface FileLines {
  get(path: string, side: Side): readonly string[] | null;
}

export function reanchorComments(
  comments: readonly Comment[],
  files: FileLines,
): { comments: Comment[]; results: AnchorResult[] } {
  const results: AnchorResult[] = [];

  const next = comments.map((comment) => {
    const result = reanchorComment(comment, files);
    results.push(result);
    return result.comment;
  });

  return { comments: next, results };
}

export function reanchorComment(comment: Comment, files: FileLines): AnchorResult {
  // Alleen openstaande regel-comments verhuizen mee. Opgeloste en globale comments
  // hebben geen anker, en verouderde blijven verouderd.
  if (comment.scope !== "line" || comment.status !== "open") {
    return { comment, outcome: "skipped" };
  }
  if (!comment.path || !comment.side || comment.startLine === undefined) {
    return { comment, outcome: "skipped" };
  }
  if (!comment.anchorSnippet) {
    // Zonder anker kunnen we niets terugvinden; dan is verouderd het eerlijke antwoord.
    return { comment: { ...comment, status: "outdated" }, outcome: "outdated" };
  }

  const lines = files.get(comment.path, comment.side);
  if (!lines) return { comment: { ...comment, status: "outdated" }, outcome: "outdated" };

  const target = comment.anchorSnippet;
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === target) matches.push(i + 1);
  }

  if (matches.length === 0) {
    return { comment: { ...comment, status: "outdated" }, outcome: "outdated" };
  }

  const old = comment.startLine;
  const span = (comment.endLine ?? old) - old;

  // 1. Binnen het venster: de dichtstbijzijnde match is de juiste.
  const nearby = matches.filter((line) => Math.abs(line - old) <= ANCHOR_WINDOW);
  if (nearby.length > 0) {
    const best = nearby.reduce((a, b) => (Math.abs(a - old) <= Math.abs(b - old) ? a : b));
    if (best === old) return { comment, outcome: "unchanged" };
    return { comment: move(comment, best, span), outcome: "shifted", from: old };
  }

  // 2. Precies één match elders in het bestand.
  if (matches.length === 1) {
    const only = matches[0] as number;
    return { comment: move(comment, only, span), outcome: "moved", from: old };
  }

  // 3. Meerdere matches, allemaal ver weg: niet te bepalen welke bedoeld is.
  return { comment: { ...comment, status: "outdated" }, outcome: "outdated" };
}

function move(comment: Comment, startLine: number, span: number): Comment {
  return { ...comment, startLine, endLine: startLine + span };
}
