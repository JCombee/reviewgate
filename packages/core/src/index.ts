export type {
  Diff,
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffLineType,
  FileStatus,
  ReviewScope,
} from "./types.js";

export { buildDiff, parseUnifiedDiff } from "./diff/parse.js";
export { intralineDiff, segmentsFor } from "./diff/intraline.js";
export type { IntralinePair, IntralineSegment } from "./diff/intraline.js";
export { resolveInRepo, toPlatform, toPosix } from "./paths.js";
export { GitError, runGit, splitLines, splitNul } from "./git/exec.js";
export { EMPTY_TREE } from "./git/GitClient.js";
export type { DiffOptions, GitClient, RepoInfo } from "./git/GitClient.js";
export { NodeGitClient } from "./git/NodeGitClient.js";

export { diffHash, normalizePatch } from "./review/hash.js";
export { ReviewStore } from "./review/store.js";
export {
  addComment,
  addReply,
  deleteComment,
  editComment,
  ReviewError,
  setCommentStatus,
  setEditedCommitMessage,
} from "./review/mutations.js";
export type { NewCommentInput } from "./review/mutations.js";
export { currentRound, openComments } from "./review/types.js";
export type {
  Author,
  ChatMessage,
  Comment,
  CommentKind,
  CommentScope,
  CommentStatus,
  Decision,
  DismissedReason,
  Reply,
  Review,
  ReviewStatus,
  Round,
  Severity,
  Side,
  Suggestion,
  SuggestionStatus,
} from "./review/types.js";

/** Testhulp: een wegwerp-git-repo. Wordt door de server-integratietests gebruikt. */
export { TestRepo } from "./git/testRepo.js";

export { analyzeCommand, rewriteWithMessageFile, splitCommand } from "./hook/command.js";
export type { CommitAnalysis } from "./hook/command.js";
export { renderApproved, renderChangesRequested } from "./hook/feedback.js";
export {
  APPROVAL_TTL_MS,
  consumeApproval,
  readApproval,
  writeApproval,
} from "./review/approval.js";
export type { Approval } from "./review/approval.js";
export { waitForDecision } from "./hook/wait.js";
export type { WaitOptions, WaitResult } from "./hook/wait.js";

export {
  acceptSuggestion,
  addSuggestions,
  applyCap,
  closeOpenSuggestions,
  DEFAULT_CAP,
  DEFAULT_DEDUPE,
  dismissSuggestion,
  findDuplicate,
  normalize,
  reopenSuggestion,
  similarity,
  suggestionCap,
} from "./review/suggestions.js";
export type {
  AddSuggestionsResult,
  DedupeConfig,
  DuplicateMatch,
  IncomingSuggestion,
  SuggestionCapConfig,
} from "./review/suggestions.js";

export { ANCHOR_WINDOW, reanchorComment, reanchorComments } from "./review/anchor.js";
export type { AnchorOutcome, AnchorResult, FileLines } from "./review/anchor.js";

export { CONFIG_FILENAME, DEFAULT_CONFIG, isIgnored, loadConfig, matchesPattern, mergeConfig } from "./config.js";
export type { ReviewGateConfig } from "./config.js";
