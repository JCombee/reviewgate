/**
 * The typed diff structure. This is the contract between core, server and web:
 * the parser produces it, the UI renders it, anchoring works on it (§5).
 *
 * All paths are POSIX (forward slashes), the way git hands them over. Converting to
 * a platform path happens only at the moment of actual filesystem contact (§4).
 */

/** Which set of changes is under review (§2). */
export type ReviewScope = "staged" | "working" | "amend" | "range";

export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  /** Line content without the +/-/space marker character. */
  content: string;
  /** Line number in the old version, null for added lines. */
  oldLine: number | null;
  /** Line number in the new version, null for deleted lines. */
  newLine: number | null;
  /** Git reported "\ No newline at end of file" right after this line. */
  noNewlineAtEof: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The section context git puts after the second `@@`, e.g. a function name. */
  section: string;
  lines: DiffLine[];
}

export type FileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "mode_changed";

export interface DiffFile {
  /**
   * The path this file is known by within the review: the new path, or the old path
   * if the file was deleted. A stable key for comments.
   */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  /** Git could not produce a textual diff, so there are no hunks (§12). */
  binary: boolean;
  /** A submodule pointer rather than an ordinary file (§12). */
  submodule: boolean;
  /** Percentage for a rename or copy, null otherwise. */
  similarity: number | null;
  oldMode: string | null;
  newMode: string | null;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface Diff {
  scope: ReviewScope;
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** Sum of all + and − lines: the basis for the suggestion cap (§9). */
  changedLines: number;
}
