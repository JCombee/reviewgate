import type { Comment, Side } from "./types.js";

/**
 * Carrying comments into a next round (§5).
 *
 * Line numbers shift between rounds. For each open comment:
 *
 * 1. Look the `anchorSnippet` back up within ±40 lines of the old number. An exact
 *    match moves the comment.
 * 2. Exactly one match elsewhere in the file → move it and mark it as moved.
 * 3. No match or several → `outdated`. It stays visible in the UI and no longer
 *    counts as open.
 */

/** How far around the old line number we look before scanning the whole file. */
export const ANCHOR_WINDOW = 40;

export type AnchorOutcome = "unchanged" | "shifted" | "moved" | "outdated" | "skipped";

export interface AnchorResult {
  comment: Comment;
  outcome: AnchorOutcome;
  /** The line the comment used to sit on, if it moved. */
  from?: number;
}

/** The file contents for the new round, per path, per side. */
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
  // Only open line comments move along. Resolved and global comments have no anchor,
  // and outdated ones stay outdated.
  if (comment.scope !== "line" || comment.status !== "open") {
    return { comment, outcome: "skipped" };
  }
  if (!comment.path || !comment.side || comment.startLine === undefined) {
    return { comment, outcome: "skipped" };
  }
  if (!comment.anchorSnippet) {
    // Without an anchor we can find nothing back, so outdated is the honest answer.
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

  // 1. Inside the window: the nearest match is the right one.
  const nearby = matches.filter((line) => Math.abs(line - old) <= ANCHOR_WINDOW);
  if (nearby.length > 0) {
    const best = nearby.reduce((a, b) => (Math.abs(a - old) <= Math.abs(b - old) ? a : b));
    if (best === old) return { comment, outcome: "unchanged" };
    return { comment: move(comment, best, span), outcome: "shifted", from: old };
  }

  // 2. Exactly one match elsewhere in the file.
  if (matches.length === 1) {
    const only = matches[0] as number;
    return { comment: move(comment, only, span), outcome: "moved", from: old };
  }

  // 3. Several matches, all far away: no way to tell which one was meant.
  return { comment: { ...comment, status: "outdated" }, outcome: "outdated" };
}

function move(comment: Comment, startLine: number, span: number): Comment {
  return { ...comment, startLine, endLine: startLine + span };
}
