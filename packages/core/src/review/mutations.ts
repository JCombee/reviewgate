import { randomUUID } from "node:crypto";
import type {
  Comment,
  CommentKind,
  CommentScope,
  Review,
  Side,
} from "./types.js";

/**
 * Mutations on a review, as pure functions: they return a new review and never touch
 * the disk. That way the rule "approve is impossible with open comments" lives in one
 * place and is tested there, apart from HTTP and from the store (§8).
 */

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

export interface NewCommentInput {
  scope: CommentScope;
  kind?: CommentKind;
  body: string;
  path?: string;
  side?: Side;
  startLine?: number;
  endLine?: number;
  anchorSnippet?: string;
  author?: Comment["author"];
  fromSuggestion?: string;
}

export function addComment(review: Review, input: NewCommentInput): { review: Review; comment: Comment } {
  const body = input.body.trim();
  if (body === "") throw new ReviewError("a comment without text says nothing", 400);

  if (input.scope === "line") {
    if (!input.path) throw new ReviewError("a line comment needs a path", 400);
    if (input.side !== "old" && input.side !== "new") {
      throw new ReviewError("a line comment needs a side", 400);
    }
    if (!Number.isInteger(input.startLine) || (input.startLine as number) < 1) {
      throw new ReviewError("invalid start line", 400);
    }
  }

  const startLine = input.startLine;
  const endLine = input.endLine ?? input.startLine;
  if (
    startLine !== undefined &&
    endLine !== undefined &&
    endLine < startLine
  ) {
    throw new ReviewError("the end of the range comes before its start", 400);
  }

  const round = review.rounds[review.rounds.length - 1];
  const comment: Comment = {
    id: randomUUID(),
    round: round?.n ?? 1,
    scope: input.scope,
    kind: input.kind ?? "issue",
    body,
    author: input.author ?? "user",
    status: "open",
    replies: [],
    createdAt: new Date().toISOString(),
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.side !== undefined ? { side: input.side } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    ...(input.anchorSnippet !== undefined ? { anchorSnippet: input.anchorSnippet } : {}),
    ...(input.fromSuggestion !== undefined ? { fromSuggestion: input.fromSuggestion } : {}),
  };

  return { review: { ...review, comments: [...review.comments, comment] }, comment };
}

function replaceComment(review: Review, id: string, fn: (c: Comment) => Comment): Review {
  let found = false;
  const comments = review.comments.map((c) => {
    if (c.id !== id) return c;
    found = true;
    return fn(c);
  });
  if (!found) throw new ReviewError("unknown comment", 404);
  return { ...review, comments };
}

export function editComment(review: Review, id: string, body: string): Review {
  const trimmed = body.trim();
  if (trimmed === "") throw new ReviewError("a comment without text says nothing", 400);
  return replaceComment(review, id, (c) => ({ ...c, body: trimmed }));
}

export function deleteComment(review: Review, id: string): Review {
  const comments = review.comments.filter((c) => c.id !== id);
  if (comments.length === review.comments.length) throw new ReviewError("unknown comment", 404);
  return { ...review, comments };
}

export function addReply(
  review: Review,
  id: string,
  body: string,
  author: Comment["author"] = "user",
): Review {
  const trimmed = body.trim();
  if (trimmed === "") throw new ReviewError("a reply without text says nothing", 400);
  return replaceComment(review, id, (c) => ({
    ...c,
    replies: [...c.replies, { author, body: trimmed, at: new Date().toISOString() }],
  }));
}

/**
 * Resolving and reopening. An `outdated` comment cannot be resolved: it belongs in
 * the outdated section and already does not count towards anything (§5).
 */
export function setCommentStatus(review: Review, id: string, resolved: boolean): Review {
  return replaceComment(review, id, (c) => {
    if (c.status === "outdated") return c;
    return { ...c, status: resolved ? "resolved" : "open" };
  });
}

export function setEditedCommitMessage(review: Review, message: string | null): Review {
  const rounds = [...review.rounds];
  const last = rounds[rounds.length - 1];
  if (!last) throw new ReviewError("this review has no round yet", 409);
  const trimmed = message === null ? null : message.trim();
  rounds[rounds.length - 1] = {
    ...last,
    // Typing the original message back verbatim is not a change.
    editedCommitMessage: trimmed === "" || trimmed === last.commitMessage ? null : trimmed,
  };
  return { ...review, rounds };
}
