import { randomUUID, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  diffHash,
  intralineDiff,
  addSuggestions,
  loadConfig,
  closeOpenSuggestions,
  openComments,
  reanchorComments,
  ReviewStore,
  splitLines,
  suggestionCap,
  writeApproval,
  type Decision,
  type Diff,
  type DiffOptions,
  type FileLines,
  type ReviewGateConfig,
  type GitClient,
  type Review,
  type ReviewScope,
  type Side,
  type Suggestion,
} from "@reviewgate/core";
import type {
  FileDetail,
  FileSummary,
  PassStatus,
  ReviewEvent,
  ReviewSummary,
} from "@reviewgate/core/api";
import { AgentUnavailable, readProjectDocs, ReviewAgent } from "./agent.js";
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
  #agent: ReviewAgent | null = null;
  #passStatus: PassStatus = { state: "idle" };

  private constructor(
    readonly git: GitClient,
    readonly scope: ReviewScope,
    readonly options: DiffOptions,
    readonly diff: Diff,
    readonly branch: string | null,
    readonly repoRoot: string,
    readonly highlighting: Highlighting,
    readonly store: ReviewStore,
    readonly config: ReviewGateConfig,
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
    const config = await loadConfig(info.root);
    const { review, newRound } = await store.findOrCreate({
      repoRoot: info.root,
      branch: info.branch,
      scope: input.scope,
      diffHash: diffHash(patch),
      commitMessage: input.commitMessage ?? null,
      claudeSessionId: input.claudeSessionId ?? null,
      transcriptPath: input.transcriptPath ?? null,
    });

    // Bij een nieuwe ronde verschuiven de regelnummers; comments uit eerdere
    // rondes moeten mee naar hun nieuwe plek, of verouderd raken (§5). De store
    // heeft de ronde bewust nog niet weggeschreven, zodat de nieuwe ronde en de
    // verplaatste comments in één keer op schijf komen.
    const anchored = newRound ? await store.save(await reanchor(review, input.git, input.scope)) : review;

    const session = new Session(
      input.git,
      input.scope,
      input.options,
      diff,
      info.branch,
      info.root,
      highlighting,
      store,
      config,
      anchored,
    );
    session.#agent = new ReviewAgent({
      repoRoot: info.root,
      patch,
      transcriptPath: input.transcriptPath ?? null,
      projectDocs: await readProjectDocs(info.root),
    });
    return session;
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

    // Openstaande voorstellen gaan dicht met reden round_closed: die had je nooit
    // beoordeeld, dus ze onderdrukken later geen herhaling (§9).
    const next: Review = {
      ...closeOpenSuggestions({ ...this.#review, rounds }),
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


  // --- chat en de automatische pass (§9) -----------------------------------

  get passStatus(): PassStatus {
    return this.#passStatus;
  }

  #agentOrThrow(): ReviewAgent {
    if (!this.#agent) throw new AgentUnavailable("de reviewer-assistent is niet beschikbaar");
    return this.#agent;
  }

  /**
   * Eén vraag in het chatpaneel. Het antwoord streamt met tokens tegelijk naar de
   * UI; pas als het compleet is landt het in de review, zodat een afgebroken
   * antwoord geen half bericht achterlaat.
   */
  async chat(message: string): Promise<Review> {
    const trimmed = message.trim();
    if (trimmed === "") throw new Error("een lege vraag levert niets op");

    const agent = this.#agentOrThrow();
    const withQuestion: Review = {
      ...this.#review,
      chat: [
        ...this.#review.chat,
        { id: randomUUID(), role: "user", body: trimmed, at: new Date().toISOString() },
      ],
    };
    await this.commit(withQuestion);

    // Bij de eerste vraag gaat de context mee; daarna hervat de SDK de sessie.
    const prompt =
      this.#review.chat.length <= 1
        ? `${await agent.contextPrompt()}\n\n# Vraag\n\n${trimmed}`
        : trimmed;

    const answer = await agent.ask(prompt, (text) => this.#emit({ type: "chat-token", text }));

    return this.commit({
      ...this.#review,
      chat: [
        ...this.#review.chat,
        { id: randomUUID(), role: "assistant", body: answer, at: new Date().toISOString() },
      ],
    });
  }

  /**
   * De automatische eerste pass. Blokkeert niets: hij loopt naast het lezen, en de
   * stand staat in de kopbalk. Levert suggesties, geen comments.
   */
  async runReviewPass(): Promise<void> {
    if (this.#passStatus.state === "running") return;
    if (!this.#agent) {
      this.#setPassStatus({ state: "failed", error: "de reviewer-assistent is niet beschikbaar" });
      return;
    }

    this.#setPassStatus({ state: "running" });
    try {
      const cap = suggestionCap(this.diff.changedLines, this.config.autoReviewCap);
      const findings = await this.#agent.reviewPass(cap, this.#review);
      const result = addSuggestions(this.#review, findings, {
        cap,
        dedupe: this.config.dedupe,
      });

      await this.#logDedupe(result.duplicates);
      await this.commit(result.review);
      this.#setPassStatus({ state: "done", count: result.added.length });
    } catch (err) {
      this.#setPassStatus({
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #setPassStatus(status: PassStatus): void {
    this.#passStatus = status;
    this.#emit({ type: "pass", status });
  }

  /**
   * Elke automatische afwijzing met score naar `dedupe.log`, zodat de drempels na
   * echt gebruik bij te stellen zijn (§15).
   */
  async #logDedupe(duplicates: ReadonlyArray<{ suggestion: Suggestion; score: number }>): Promise<void> {
    if (duplicates.length === 0) return;
    try {
      const info = await this.git.info();
      const dir = path.join(info.gitDir, "reviewgate");
      await fs.mkdir(dir, { recursive: true });
      const lines = duplicates.map((d) =>
        JSON.stringify({
          at: new Date().toISOString(),
          path: d.suggestion.path ?? null,
          score: Number(d.score.toFixed(3)),
          body: d.suggestion.body,
          duplicateOf: d.suggestion.duplicateOf ?? null,
        }),
      );
      await fs.appendFile(path.join(dir, "dedupe.log"), `${lines.join("\n")}\n`, "utf8");
    } catch {
      // Logging mag de review nooit tegenhouden.
    }
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
      passStatus: this.#passStatus,
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

/**
 * Zet de comments van een review over naar de nieuwe ronde. De bestandsinhoud wordt
 * per pad één keer opgehaald en gecachet: een review kan tientallen comments in
 * hetzelfde bestand hebben.
 */
async function reanchor(review: Review, git: GitClient, scope: ReviewScope): Promise<Review> {
  const keys = new Set<string>();
  for (const c of review.comments) {
    if (c.scope === "line" && c.status === "open" && c.path) keys.add(`${c.side}:${c.path}`);
  }
  if (keys.size === 0) return review;

  const cache = new Map<string, string[] | null>();
  for (const key of keys) {
    const [side, ...rest] = key.split(":");
    const filePath = rest.join(":");
    const content = await git.fileContent(filePath, side as Side, scope);
    cache.set(key, content === null ? null : splitLines(content));
  }

  const files: FileLines = {
    get: (filePath, side) => cache.get(`${side}:${filePath}`) ?? null,
  };

  const { comments } = reanchorComments(review.comments, files);
  return { ...review, comments };
}
