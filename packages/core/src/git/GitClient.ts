import type { Diff, DiffFile, ReviewScope } from "../types.js";

/** De lege boom: scope-basis voor een repo zonder enige commit (§12). */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface RepoInfo {
  /** Absoluut platformpad naar de repo-root. */
  root: string;
  /** Absoluut platformpad naar de .git-directory (of het gitdir-bestand bij worktrees). */
  gitDir: string;
  branch: string | null;
  /** false bij een verse repo zonder commits. */
  hasHead: boolean;
  /** Een merge, rebase of cherry-pick is bezig; de gate slaat dan over (§12). */
  inMergeOrRebase: boolean;
}

export interface DiffOptions {
  /** Aantal contextregels; default 5, zoals §4 voorschrijft. */
  context?: number;
  /** Ook untracked bestanden meenemen (alleen zinvol bij scope "working"). */
  includeUntracked?: boolean;
  /** Voor scope "range": de revisie-expressie, bijv. `main...HEAD`. */
  range?: string;
}

/**
 * Alle git-interactie loopt via deze interface, zodat core testbaar blijft
 * zonder echte repo en er later een tweede implementatie naast kan (§4).
 */
export interface GitClient {
  info(): Promise<RepoInfo>;
  /** Ruwe patchtekst voor een scope. */
  rawDiff(scope: ReviewScope, opts?: DiffOptions): Promise<string>;
  /** Geparste, getypeerde diff voor een scope. */
  diff(scope: ReviewScope, opts?: DiffOptions): Promise<Diff>;
  /** Volledige bestandsinhoud aan één kant van de diff, voor context-expansie (§7). */
  fileContent(path: string, side: "old" | "new", scope: ReviewScope): Promise<string | null>;
  /** Untracked bestanden als losse "added" entries. */
  untrackedFiles(opts?: DiffOptions): Promise<DiffFile[]>;
}
