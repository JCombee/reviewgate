/**
 * The DTOs that server and web share. Deliberately its own entrypoint
 * (`@reviewgate/core/api`): the web bundle must carry nothing from core's node side.
 */
import type { IntralinePair } from "./diff/intraline.js";
import type {
  Comment,
  CommentKind,
  CommentScope,
  Review,
  Side,
} from "./review/types.js";
import type { DiffFile, FileStatus, ReviewScope } from "./types.js";

export interface RepoSummary {
  root: string;
  branch: string | null;
}

export interface FileSummary {
  /** Position in the review order; also the key for the detail endpoint. */
  index: number;
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  submodule: boolean;
  similarity: number | null;
  additions: number;
  deletions: number;
  hunkCount: number;
}

export interface ReviewSummary {
  /** Session id in the URL; the review itself has its own, persistent id. */
  id: string;
  scope: ReviewScope;
  repo: RepoSummary;
  createdAt: string;
  files: FileSummary[];
  additions: number;
  deletions: number;
  changedLines: number;
  /** The persistent review with comments, suggestions and rounds (§5). */
  review: Review;
  /** State of the automatic pass at the moment of loading. */
  passStatus: PassStatus;
}

/**
 * One coloured piece of text: the text plus an index into the file's palette. A file
 * uses only a handful of colours, so the index easily saves half the payload compared
 * with colours per token on large files.
 */
export interface HighlightToken {
  t: string;
  c: number;
}

/** Tokens of one line. The index in the array is the line number − 1. */
export type HighlightLine = HighlightToken[];

/** Colour pair [light, dark] that `HighlightToken.c` points at. */
export type PaletteEntry = readonly [light: string, dark: string];

export interface FileHighlight {
  /** Tokens of the old side, or null when that side does not exist or is too large. */
  old: HighlightLine[] | null;
  new: HighlightLine[] | null;
  /** Shared by both sides of this file. */
  palette: PaletteEntry[];
  /** The language shiki used; "text" when unknown or skipped. */
  lang: string;
  /** Highlighting skipped because the file is too large (§12). */
  skipped: boolean;
}

export interface FileDetail {
  index: number;
  file: DiffFile;
  /** Per hunk, the paired lines with their differing pieces; same order as `file.hunks`. */
  intraline: IntralinePair[][];
  highlight: FileHighlight;
  /** Line count on either side, so the UI knows how far context expansion can go. */
  oldLineCount: number;
  newLineCount: number;
}

/** What the UI sends along with a new comment. */
export interface CreateCommentBody {
  scope: CommentScope;
  kind?: CommentKind;
  body: string;
  path?: string;
  side?: Side;
  startLine?: number;
  endLine?: number;
  anchorSnippet?: string;
  fromSuggestion?: string;
}

/** State of the automatic first pass, for the header bar (§9). */
export type PassStatus =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; count: number }
  | { state: "failed"; error: string };

/** Server-sent events on `/api/review/:id/events` (§7). */
export type ReviewEvent =
  | { type: "review"; review: Review }
  | { type: "chat-token"; text: string }
  | { type: "pass"; status: PassStatus }
  | { type: "ping" };

export interface ApiError {
  error: string;
}

export type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffLineType,
  FileStatus,
  ReviewScope,
} from "./types.js";
export type { IntralinePair, IntralineSegment } from "./diff/intraline.js";
export type {
  Author,
  ChatMessage,
  Comment,
  CommentKind,
  CommentScope,
  CommentStatus,
  Reply,
  Review,
  Round,
  Severity,
  Side,
  Suggestion,
  SuggestionStatus,
} from "./review/types.js";
