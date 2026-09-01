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
