import type { ReviewScope } from "../types.js";

/**
 * Het persistente reviewmodel uit §5. Eén JSON-bestand per review in
 * `.git/reviewgate/reviews/<id>.json` — dat pad zit al buiten versiebeheer.
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
  /** Ronde waarin de comment geplaatst is. */
  round: number;
  scope: CommentScope;
  /** Vragen worden in de feedback met ? gerenderd, zodat Claude ze beantwoordt (§10). */
  kind: CommentKind;
  path?: string;
  side?: Side;
  startLine?: number;
  endLine?: number;
  /** De daadwerkelijke regeltekst, voor het terugvinden in een volgende ronde (§5). */
  anchorSnippet?: string;
  body: string;
  author: Author;
  status: CommentStatus;
  /** Id van de suggestie waar deze comment uit voortkomt (§9). */
  fromSuggestion?: string;
  replies: Reply[];
  createdAt: string;
}

export type SuggestionStatus = "pending" | "accepted" | "dismissed";
export type Severity = "blocker" | "aandachtspunt" | "nit";
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
  /** De message uit het onderschepte commando, of null bij een handmatige review. */
  commitMessage: string | null;
  /** Door de reviewer aangepaste message; null betekent ongewijzigd (§8). */
  editedCommitMessage: string | null;
  claudeSessionId: string | null;
  transcriptPath: string | null;
  decision: Decision | null;
  decidedAt: string | null;
  /** Vrij tekstveld bij de beslissing: de richting van de review (§8). */
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

/** Alleen openstaande comments bepalen de knop-state; suggesties nooit (§8). */
export function openComments(review: Review): Comment[] {
  return review.comments.filter((c) => c.status === "open");
}

export function currentRound(review: Review): Round | undefined {
  return review.rounds[review.rounds.length - 1];
}
