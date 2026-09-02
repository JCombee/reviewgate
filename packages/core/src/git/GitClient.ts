import type { Diff, DiffFile, ReviewScope } from "../types.js";

/** The empty tree: the scope base for a repo without any commit (§12). */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface RepoInfo {
  /** Absolute platform path to the repo root. */
  root: string;
  /** Absolute platform path to the .git directory (or the gitdir file for worktrees). */
  gitDir: string;
  branch: string | null;
  /** false for a fresh repo without commits. */
  hasHead: boolean;
  /** A merge, rebase or cherry-pick is in progress; the gate then steps aside (§12). */
  inMergeOrRebase: boolean;
}

export interface DiffOptions {
  /** Number of context lines; defaults to 5, as §4 prescribes. */
  context?: number;
  /** Include untracked files too (only meaningful for scope "working"). */
  includeUntracked?: boolean;
  /** For scope "range": the revision expression, e.g. `main...HEAD`. */
  range?: string;
}

/**
 * All git interaction goes through this interface, so core stays testable without a
 * real repo and a second implementation can live alongside it later (§4).
 */
export interface GitClient {
  info(): Promise<RepoInfo>;
  /** Raw patch text for a scope. */
  rawDiff(scope: ReviewScope, opts?: DiffOptions): Promise<string>;
  /** Parsed, typed diff for a scope. */
  diff(scope: ReviewScope, opts?: DiffOptions): Promise<Diff>;
  /** Full file content on one side of the diff, for context expansion (§7). */
  fileContent(path: string, side: "old" | "new", scope: ReviewScope): Promise<string | null>;
  /** Untracked files as standalone "added" entries. */
  untrackedFiles(opts?: DiffOptions): Promise<DiffFile[]>;
}
