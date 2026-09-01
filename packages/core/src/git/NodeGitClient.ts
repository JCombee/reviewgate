import fs from "node:fs/promises";
import path from "node:path";
import { buildDiff, parseUnifiedDiff } from "../diff/parse.js";
import { resolveInRepo, toPosix } from "../paths.js";
import type { Diff, DiffFile, ReviewScope } from "../types.js";
import { runGit, splitLines, splitNul } from "./exec.js";
import { EMPTY_TREE, type DiffOptions, type GitClient, type RepoInfo } from "./GitClient.js";

const DEFAULT_CONTEXT = 5;

/** Concrete `GitClient` bovenop de git-CLI. */
export class NodeGitClient implements GitClient {
  #info: RepoInfo | null = null;

  constructor(readonly cwd: string) {}

  /** Zoekt de repo-root vanaf een willekeurige directory binnen de repo. */
  static async open(cwd: string): Promise<NodeGitClient> {
    const { stdout } = await runGit(["rev-parse", "--show-toplevel"], { cwd });
    const root = path.resolve(stdout.trim());
    return new NodeGitClient(root);
  }

  async info(): Promise<RepoInfo> {
    if (this.#info) return this.#info;

    const [rootRes, gitDirRes] = await Promise.all([
      runGit(["rev-parse", "--show-toplevel"], { cwd: this.cwd }),
      runGit(["rev-parse", "--absolute-git-dir"], { cwd: this.cwd }),
    ]);
    const root = path.resolve(rootRes.stdout.trim());
    const gitDir = path.resolve(gitDirRes.stdout.trim());

    const headRes = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: this.cwd,
      okCodes: [0, 1],
    });
    const hasHead = headRes.code === 0 && headRes.stdout.trim() !== "";

    const branchRes = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: this.cwd,
      okCodes: [0, 1],
    });
    const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null;

    const inMergeOrRebase = await this.#anyExists(gitDir, [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ]);

    this.#info = { root, gitDir, branch, hasHead, inMergeOrRebase };
    return this.#info;
  }

  async rawDiff(scope: ReviewScope, opts: DiffOptions = {}): Promise<string> {
    const args = await this.#diffArgs(scope, opts);
    const { stdout } = await runGit(args, { cwd: this.cwd });
    return stdout;
  }

  async diff(scope: ReviewScope, opts: DiffOptions = {}): Promise<Diff> {
    const files = parseUnifiedDiff(await this.rawDiff(scope, opts));
    if (opts.includeUntracked && (scope === "working" || scope === "range")) {
      files.push(...(await this.untrackedFiles(opts)));
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return buildDiff(scope, files);
  }

  async fileContent(
    filePath: string,
    side: "old" | "new",
    scope: ReviewScope,
  ): Promise<string | null> {
    const info = await this.info();

    if (side === "new" && scope === "working") {
      try {
        return await fs.readFile(resolveInRepo(info.root, filePath), "utf8");
      } catch {
        return null;
      }
    }

    const rev =
      side === "new"
        ? ":" // de index
        : scope === "amend"
          ? info.hasHead
            ? "HEAD~1:"
            : `${EMPTY_TREE}:`
          : info.hasHead
            ? "HEAD:"
            : `${EMPTY_TREE}:`;

    const res = await runGit(["show", `${rev}${filePath}`], {
      cwd: this.cwd,
      okCodes: [0, 128],
    });
    return res.code === 0 ? res.stdout : null;
  }

  async untrackedFiles(opts: DiffOptions = {}): Promise<DiffFile[]> {
    const { stdout } = await runGit(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: this.cwd },
    );

    const paths: string[] = [];
    for (const entry of splitNul(stdout)) {
      // Formaat: "XY <pad>". Alleen "??" is untracked; renames hebben een tweede
      // NUL-veld, maar die vallen hier niet onder "??".
      if (entry.startsWith("?? ")) paths.push(toPosix(entry.slice(3)));
    }

    const context = opts.context ?? DEFAULT_CONTEXT;
    const files: DiffFile[] = [];
    for (const p of paths) {
      const file = await this.#untrackedAsDiffFile(p, context);
      if (file) files.push(file);
    }
    return files;
  }

  // -------------------------------------------------------------------------

  async #diffArgs(scope: ReviewScope, opts: DiffOptions): Promise<string[]> {
    const info = await this.info();
    const context = opts.context ?? DEFAULT_CONTEXT;
    const base = [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      "--find-copies",
      `-U${context}`,
    ];

    switch (scope) {
      case "staged":
        return info.hasHead
          ? [...base, "--cached"]
          : [...base, "--cached", EMPTY_TREE];
      case "working":
        // `git diff HEAD` = index + working tree samen tegen HEAD, precies de
        // scope die hoort bij `git add -A && git commit` (§2).
        return info.hasHead ? [...base, "HEAD"] : [...base, "--cached", EMPTY_TREE];
      case "amend":
        return info.hasHead
          ? [...base, "--cached", await this.#amendBase()]
          : [...base, "--cached", EMPTY_TREE];
      case "range": {
        const range = opts.range;
        if (!range) throw new Error('scope "range" vereist een opts.range');
        return [...base, range];
      }
    }
  }

  /** HEAD~1, of de lege boom als HEAD de allereerste commit is. */
  async #amendBase(): Promise<string> {
    const res = await runGit(["rev-parse", "--verify", "--quiet", "HEAD~1"], {
      cwd: this.cwd,
      okCodes: [0, 1],
    });
    return res.code === 0 && res.stdout.trim() !== "" ? res.stdout.trim() : EMPTY_TREE;
  }

  /**
   * Untracked bestand als "added" entry. `--no-index` levert dezelfde patchvorm als
   * een gewone diff, dus de parser hoeft geen apart geval te kennen. Exitcode 1
   * betekent hier "er zijn verschillen", niet "fout".
   */
  async #untrackedAsDiffFile(relPosix: string, context: number): Promise<DiffFile | null> {
    const info = await this.info();
    const abs = resolveInRepo(info.root, relPosix);

    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) return null;
    } catch {
      return null;
    }

    const res = await runGit(
      [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-index",
        `-U${context}`,
        "--",
        "/dev/null",
        relPosix,
      ],
      { cwd: info.root, okCodes: [0, 1] },
    );

    const parsed = parseUnifiedDiff(res.stdout);
    const file = parsed[0];
    if (!file) return null;

    return {
      ...file,
      path: relPosix,
      oldPath: null,
      newPath: relPosix,
      status: "added",
    };
  }

  async #anyExists(gitDir: string, names: readonly string[]): Promise<boolean> {
    for (const name of names) {
      try {
        await fs.access(path.join(gitDir, name));
        return true;
      } catch {
        // niet aanwezig
      }
    }
    return false;
  }
}

export { splitLines };
