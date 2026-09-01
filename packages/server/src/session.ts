import { randomUUID, randomBytes } from "node:crypto";
import {
  intralineDiff,
  type Diff,
  type DiffOptions,
  type GitClient,
  type ReviewScope,
} from "@reviewgate/core";
import type { FileDetail, FileSummary, ReviewSummary } from "@reviewgate/core/api";
import { Highlighting, Palette } from "./highlight.js";

export interface SessionInput {
  git: GitClient;
  scope: ReviewScope;
  options: DiffOptions;
}

/**
 * Eén review-sessie: de ingelezen diff plus alles wat de UI erover mag opvragen.
 *
 * In M1 leeft dit alleen in het geheugen. De persistente `Review` uit §5 komt in M2;
 * de vorm van `id` is nu al stabiel zodat de URL's dan niet veranderen.
 */
export class Session {
  readonly id = randomUUID();
  /** In de review-URL; requests zonder dit token krijgen 403 (§3). */
  readonly token = randomBytes(24).toString("base64url");
  readonly createdAt = new Date().toISOString();

  #detailCache = new Map<number, FileDetail>();

  private constructor(
    readonly git: GitClient,
    readonly scope: ReviewScope,
    readonly options: DiffOptions,
    readonly diff: Diff,
    readonly branch: string | null,
    readonly repoRoot: string,
    readonly highlighting: Highlighting,
  ) {}

  static async create(input: SessionInput, highlighting: Highlighting): Promise<Session> {
    const [info, diff] = await Promise.all([
      input.git.info(),
      input.git.diff(input.scope, input.options),
    ]);
    return new Session(
      input.git,
      input.scope,
      input.options,
      diff,
      info.branch,
      info.root,
      highlighting,
    );
  }

  summary(): ReviewSummary {
    const files: FileSummary[] = this.diff.files.map((f, index) => ({
      index,
      path: f.path,
      oldPath: f.oldPath,
      newPath: f.newPath,
      status: f.status,
      binary: f.binary,
      submodule: f.submodule,
      similarity: f.similarity,
      additions: f.additions,
      deletions: f.deletions,
      hunkCount: f.hunks.length,
    }));

    return {
      id: this.id,
      scope: this.scope,
      repo: { root: this.repoRoot, branch: this.branch },
      createdAt: this.createdAt,
      files,
      additions: this.diff.additions,
      deletions: this.diff.deletions,
      changedLines: this.diff.changedLines,
    };
  }

  /**
   * Detail van één bestand: hunks, intraline-segmenten en de tokens van beide kanten.
   * Per bestand opgevraagd, zodat een diff van duizenden regels niet in één
   * response hoeft (§12) en de UI meteen kan renderen wat in beeld staat.
   */
  async fileDetail(index: number): Promise<FileDetail | null> {
    const cached = this.#detailCache.get(index);
    if (cached) return cached;

    const file = this.diff.files[index];
    if (!file) return null;

    const [oldContent, newContent] = await Promise.all([
      file.binary || file.oldPath === null
        ? Promise.resolve(null)
        : this.git.fileContent(file.oldPath, "old", this.scope),
      file.binary || file.newPath === null
        ? Promise.resolve(null)
        : this.git.fileContent(file.newPath, "new", this.scope),
    ]);

    // Eén palet per bestand, gedeeld door beide kanten.
    const palette = new Palette();
    const [oldTok, newTok] = await Promise.all([
      oldContent === null
        ? Promise.resolve(null)
        : this.highlighting.tokenize(oldContent, file.oldPath ?? file.path, palette),
      newContent === null
        ? Promise.resolve(null)
        : this.highlighting.tokenize(newContent, file.newPath ?? file.path, palette),
    ]);

    const detail: FileDetail = {
      index,
      file,
      intraline: file.hunks.map((h) => intralineDiff(h)),
      highlight: {
        old: oldTok?.lines ?? null,
        new: newTok?.lines ?? null,
        palette: palette.entries(),
        lang: newTok?.lang ?? oldTok?.lang ?? "text",
        skipped: (oldTok?.skipped ?? false) || (newTok?.skipped ?? false),
      },
      oldLineCount: oldContent === null ? 0 : countLines(oldContent),
      newLineCount: newContent === null ? 0 : countLines(newContent),
    };

    this.#detailCache.set(index, detail);
    return detail;
  }
}

/** Aantal regels; een afsluitende newline telt niet als extra lege regel. */
function countLines(s: string): number {
  if (s === "") return 0;
  const withoutTrailing = s.endsWith("\n") ? s.slice(0, -1) : s;
  let n = 1;
  for (let i = 0; i < withoutTrailing.length; i++) {
    if (withoutTrailing.charCodeAt(i) === 10) n++;
  }
  return n;
}
