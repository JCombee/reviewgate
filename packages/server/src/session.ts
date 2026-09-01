import { randomUUID, randomBytes } from "node:crypto";
import {
  diffHash,
  intralineDiff,
  openComments,
  ReviewStore,
  writeApproval,
  type Decision,
  type Diff,
  type DiffOptions,
  type GitClient,
  type Review,
  type ReviewScope,
} from "@reviewgate/core";
import type { FileDetail, FileSummary, ReviewEvent, ReviewSummary } from "@reviewgate/core/api";
import { Highlighting, Palette } from "./highlight.js";

export interface SessionInput {
  git: GitClient;
  scope: ReviewScope;
  options: DiffOptions;
  /** Meegegeven door de hook in M3; bij een handmatige review leeg. */
  commitMessage?: string | null;
  claudeSessionId?: string | null;
  transcriptPath?: string | null;
}

type Listener = (event: ReviewEvent) => void;

/**
 * Eén review-sessie: de ingelezen diff, de persistente review en alles wat de UI
 * erover mag opvragen of eraan mag wijzigen.
 */
export class Session {
  readonly id = randomUUID();
  /** In de review-URL; requests zonder dit token krijgen 403 (§3). */
  readonly token = randomBytes(24).toString("base64url");
  readonly createdAt = new Date().toISOString();

  #detailCache = new Map<number, FileDetail>();
  #listeners = new Set<Listener>();
  #review: Review;

  private constructor(
    readonly git: GitClient,
    readonly scope: ReviewScope,
    readonly options: DiffOptions,
    readonly diff: Diff,
    readonly branch: string | null,
    readonly repoRoot: string,
    readonly highlighting: Highlighting,
    readonly store: ReviewStore,
    review: Review,
  ) {
    this.#review = review;
  }

  static async create(input: SessionInput, highlighting: Highlighting): Promise<Session> {
    const info = await input.git.info();
    const [diff, patch] = await Promise.all([
      input.git.diff(input.scope, input.options),
      input.git.rawDiff(input.scope, input.options),
    ]);

    const store = new ReviewStore(info.gitDir);
    const review = await store.findOrCreate({
      repoRoot: info.root,
      branch: info.branch,
      scope: input.scope,
      diffHash: diffHash(patch),
      commitMessage: input.commitMessage ?? null,
      claudeSessionId: input.claudeSessionId ?? null,
      transcriptPath: input.transcriptPath ?? null,
    });

    return new Session(
      input.git,
      input.scope,
      input.options,
      diff,
      info.branch,
      info.root,
      highlighting,
      store,
      review,
    );
  }

  get review(): Review {
    return this.#review;
  }

  /**
   * Slaat een gemuteerde review op en stuurt hem naar alle open SSE-verbindingen,
   * zodat een tweede tabblad meteen bijloopt.
   */
  async commit(next: Review): Promise<Review> {
    this.#review = await this.store.save(next);
    this.#emit({ type: "review", review: this.#review });
    return this.#review;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: ReviewEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Een kapotte verbinding mag de andere luisteraars niet meeslepen.
      }
    }
  }


  /**
   * Sluit de ronde af. De regel dat approve onmogelijk is met openstaande comments
   * wordt hier afgedwongen, niet alleen in de UI (§8): de UI is niet de enige plek
   * waar die regel mag leven.
   */
  async decide(decision: Decision, summary: string | null): Promise<Review> {
    const open = openComments(this.#review);
    if (decision === "approve" && open.length > 0) {
      throw new DecisionConflict(open.map((c) => c.id));
    }

    const rounds = [...this.#review.rounds];
    const last = rounds[rounds.length - 1];
    if (!last) throw new Error("deze review heeft geen ronde");

    const trimmed = summary?.trim();
    rounds[rounds.length - 1] = {
      ...last,
      decision,
      decidedAt: new Date().toISOString(),
      summary: trimmed ? trimmed : null,
    };

    const next: Review = {
      ...this.#review,
      rounds,
      status: decision === "approve" ? "approved" : "changes_requested",
    };

    // Eerst het approval-artifact, dan pas de review opslaan: de hook let op de
    // review en mag pas doorlopen als het artifact er al is (§2).
    if (decision === "approve") {
      const info = await this.git.info();
      await writeApproval(info.gitDir, {
        diffHash: last.diffHash,
        reviewId: next.id,
        approvedAt: new Date().toISOString(),
        claudeSessionId: last.claudeSessionId,
        editedCommitMessage: last.editedCommitMessage,
        summary: rounds[rounds.length - 1]?.summary ?? null,
      });
    }

    return this.commit(next);
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
      review: this.#review,
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

/**
 * Approve terwijl er nog comments open staan. De UI hoort dit te voorkomen, maar
 * de server weigert het hoe dan ook — met de betreffende id's erbij (§8).
 */
export class DecisionConflict extends Error {
  constructor(readonly openCommentIds: string[]) {
    super("er staan nog comments open");
    this.name = "DecisionConflict";
  }
}
