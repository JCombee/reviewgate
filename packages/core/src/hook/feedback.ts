import type { Comment, Review, Round } from "../review/types.js";

/**
 * The markdown that goes back into the session as `permissionDecisionReason` (§10).
 *
 * Compact and machine-readable enough for Claude to work from directly: grouped per
 * file, line numbers up front, questions with a `?` so he answers them instead of
 * fixing blindly.
 */
export function renderChangesRequested(review: Review): string {
  const round = review.rounds[review.rounds.length - 1];
  const roundNumber = round?.n ?? 1;
  const open = review.comments.filter((c) => c.status === "open");

  const lines: string[] = [];
  lines.push(`# Code review: changes requested (round ${roundNumber})`);
  lines.push("");
  lines.push(
    "The commit was blocked. Work through the points below, then try to commit again.",
  );
  lines.push(
    "Questions (marked with ?) are for you to answer in your reply to the user; they need no fix.",
  );

  if (round?.summary) {
    lines.push("", "## Summary", "", round.summary.trim());
  }

  const messageBlock = renderCommitMessage(round, open);
  if (messageBlock.length > 0) lines.push("", ...messageBlock);

  const globals = open.filter((c) => c.scope === "global");
  if (globals.length > 0) {
    lines.push("", "## General", "");
    for (const c of globals) lines.push(bullet(c));
  }

  for (const [path, comments] of groupByPath(open)) {
    lines.push("", `## ${path}`, "");
    for (const c of comments) lines.push(bullet(c));
  }

  const earlier = open.filter((c) => c.round < roundNumber);
  if (earlier.length > 0) {
    lines.push("", `## Still open from earlier rounds`, "");
    for (const c of earlier) {
      const where = c.path ? `${c.path} ${lineRef(c)}: ` : "";
      lines.push(`- ${where}${firstLine(c.body)} (round ${c.round})`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** What still travels along on an approve, as `systemMessage` (§10). */
export function renderApproved(review: Review): string | null {
  const round = review.rounds[review.rounds.length - 1];
  const summary = round?.summary?.trim();
  if (!summary) return null;
  return `Code review: approved (round ${round?.n ?? 1}).\n\n${summary}\n`;
}

// ---------------------------------------------------------------------------

/**
 * The commit-message block appears only when the message was edited or when a comment
 * about it is open, and then carries both of those things (§10).
 */
function renderCommitMessage(round: Round | undefined, open: readonly Comment[]): string[] {
  const messageComments = open.filter((c) => c.scope === "commit_message");
  const edited = round?.editedCommitMessage ?? null;
  if (edited === null && messageComments.length === 0) return [];

  const lines: string[] = ["## Commit message", ""];
  if (edited !== null) {
    lines.push("Use this message (adjusted by the reviewer):", "");
    // An indented block, so a message with backticks or markdown breaks nothing.
    for (const line of edited.split("\n")) lines.push(`    ${line}`);
    if (messageComments.length > 0) lines.push("");
  }
  for (const c of messageComments) lines.push(bullet(c));
  return lines;
}

function groupByPath(comments: readonly Comment[]): Map<string, Comment[]> {
  const map = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.scope !== "line" || !c.path) continue;
    const list = map.get(c.path);
    if (list) list.push(c);
    else map.set(c.path, [c]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  }
  // A fixed order: the feedback should look the same every round, even when the
  // comments were placed in a different order.
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function bullet(c: Comment): string {
  const mark = c.kind === "question" ? "? " : "";
  const ref = c.scope === "line" ? `${lineRef(c)}: ` : "";
  const body = c.body.trim().split("\n").join("\n  ");
  const replies = c.replies
    .filter((r) => r.author === "user")
    .map((r) => `\n  ${r.body.trim().split("\n").join("\n  ")}`)
    .join("");
  return `- ${mark}${ref}${body}${replies}`;
}

function lineRef(c: Comment): string {
  if (c.startLine === undefined) return "";
  const side = c.side === "old" ? "old " : "";
  return c.endLine && c.endLine !== c.startLine
    ? `${side}L${c.startLine}-${c.endLine}`
    : `${side}L${c.startLine}`;
}

function firstLine(body: string): string {
  const [first] = body.trim().split("\n");
  return first ?? "";
}
