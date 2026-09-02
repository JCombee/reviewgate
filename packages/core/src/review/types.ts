import type { ReviewScope } from "../types.js";

/**
 * The persistent review model from §5. One JSON file per review in
 * `.git/reviewgate/reviews/<id>.json` — that path is already outside version control.
 */

export type ReviewStatus = "open" | "approved" | "changes_requested" | "abandoned";

export type CommentScope = "global" | "line" | "commit_message";
export type CommentKind = "issue" | "question";
export type CommentStatus = "open" | "resolved" | "outdated";
export type Side = "old" | "new";
export type Author = "user" | "agent";

export interface Reply {
  author: Author;
  body: string;
  at: string;
}

export interface Comment {
  id: string;
  /** The round this comment was placed in. */
  round: number;
  scope: CommentScope;
  /** Questions are rendered with a ? in the feedback, so Claude answers them (§10). */
  kind: CommentKind;
  path?: string;
  side?: Side;
  startLine?: number;
  endLine?: number;
  /** The actual line text, for finding it again in a later round (§5). */
  anchorSnippet?: string;
  body: string;
  author: Author;
  status: CommentStatus;
  /** Id of the suggestion this comment came out of (§9). */
  fromSuggestion?: string;
  replies: Reply[];
  createdAt: string;
}

export type SuggestionStatus = "pending" | "accepted" | "dismissed";
export type Severity = "blocker" | "consideration" | "nit";
export type DismissedReason = "user" | "auto_duplicate" | "round_closed";

export interface Suggestion {
  id: string;
  round: number;
  scope: CommentScope;
  path?: string;
  side?: Side;
  startLine?: number;
  endLine?: number;
  anchorSnippet?: string;
  body: string;
  severity: Severity;
  status: SuggestionStatus;
  dismissedReason?: DismissedReason;
  duplicateOf?: string;
  promotedToCommentId?: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  body: string;
  at: string;
}

export type Decision = "approve" | "request_changes" | "timeout";

export interface Round {
  n: number;
  diffHash: string;
  scope: ReviewScope;
  /** The message from the intercepted command, or null for a manual review. */
  commitMessage: string | null;
  /** Message adjusted by the reviewer; null means unchanged (§8). */
  editedCommitMessage: string | null;
  claudeSessionId: string | null;
  transcriptPath: string | null;
  decision: Decision | null;
  decidedAt: string | null;
  /** Free text alongside the decision: the direction of the review (§8). */
  summary: string | null;
}

export interface Review {
  id: string;
  repoRoot: string;
  branch: string | null;
  createdAt: string;
  updatedAt: string;
  rounds: Round[];
  comments: Comment[];
  suggestions: Suggestion[];
  chat: ChatMessage[];
  status: ReviewStatus;
}

/** Only open comments drive the button state; suggestions never do (§8). */
export function openComments(review: Review): Comment[] {
  return review.comments.filter((c) => c.status === "open");
}

export function currentRound(review: Review): Round | undefined {
  return review.rounds[review.rounds.length - 1];
}
