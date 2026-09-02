import { randomUUID, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  addSuggestions,
  closeOpenSuggestions,
  diffHash,
  intralineDiff,
  loadConfig,
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
  type GitClient,
  type Review,
  type ReviewGateConfig,
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
  /** Passed in by the hook in M3; empty for a manual review. */
  commitMessage?: string | null;
  claudeSessionId?: string | null;
  transcriptPath?: string | null;
}

type Listener = (event: ReviewEvent) => void;

/**
 * One review session: the parsed diff, the persistent review, and everything the UI
 * may ask about it or change on it.
 */
export class Session {
  readonly id = randomUUID();
  /** Part of the review URL; requests without this token get a 403 (§3). */
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

    // On a new round the line numbers shift; comments from earlier rounds have to move
    // to their new place, or go outdated (§5). The store deliberately has not written
    // the round yet, so the new round and the moved comments land on disk together.
    const anchored = newRound
      ? await store.save(await reanchor(review, input.git, input.scope))
      : review;

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
   * Saves a mutated review and pushes it to every open SSE connection, so a second
   * tab catches up straight away.
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
        // A broken connection must not drag the other listeners down with it.
      }
    }
  }

  /**
   * Closes the round. The rule that approve is impossible with open comments is
   * enforced here, not only in the UI (§8): the UI is not the only place that rule
   * gets to live.
   */
  async decide(decision: Decision, summary: string | null): Promise<Review> {
    const open = openComments(this.#review);
    if (decision === "approve" && open.length > 0) {
      throw new DecisionConflict(open.map((c) => c.id));
    }

    const rounds = [...this.#review.rounds];
    const last = rounds[rounds.length - 1];
    if (!last) throw new Error("this review has no round");

    const trimmed = summary?.trim();
    rounds[rounds.length - 1] = {
      ...last,
      decision,
      decidedAt: new Date().toISOString(),
      summary: trimmed ? trimmed : null,
    };

    // Open suggestions close with reason round_closed: you never judged them, so they
    // suppress no repetition later on (§9).
    const next: Review = {
      ...closeOpenSuggestions({ ...this.#review, rounds }),
      status: decision === "approve" ? "approved" : "changes_requested",
    };

    // The approval artifact first, only then save the review: the hook watches the
    // review and may not proceed until the artifact is already there (§2).
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

  // --- chat and the automatic pass (§9) ------------------------------------

  get passStatus(): PassStatus {
    return this.#passStatus;
  }

  #agentOrThrow(): ReviewAgent {
    if (!this.#agent) throw new AgentUnavailable("the reviewer assistant is not available");
    return this.#agent;
  }

  /**
   * One question in the chat panel. The answer streams to the UI token by token; only
   * once it is complete does it land in the review, so an aborted answer leaves no
   * half message behind.
   */
  async chat(message: string): Promise<Review> {
    const trimmed = message.trim();
    if (trimmed === "") throw new Error("an empty question yields nothing");

    const agent = this.#agentOrThrow();
    const withQuestion: Review = {
      ...this.#review,
      chat: [
        ...this.#review.chat,
        { id: randomUUID(), role: "user", body: trimmed, at: new Date().toISOString() },
      ],
    };
    await this.commit(withQuestion);

    // The first question carries the context; after that the SDK resumes the session.
    const prompt =
      this.#review.chat.length <= 1
        ? `${await agent.contextPrompt()}\n\n# Question\n\n${trimmed}`
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
   * The automatic first pass. It blocks nothing: it runs alongside your reading, and
   * its state sits in the header bar. It yields suggestions, not comments.
   */
  async runReviewPass(): Promise<void> {
    if (this.#passStatus.state === "running") return;
    if (!this.#agent) {
      this.#setPassStatus({ state: "failed", error: "the reviewer assistant is not available" });
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
   * Every automatic dismissal with its score goes to `dedupe.log`, so the thresholds
   * can be adjusted after real use (§15).
   */
  async #logDedupe(
    duplicates: ReadonlyArray<{ suggestion: Suggestion; score: number }>,
  ): Promise<void> {
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
      // Logging must never hold up the review.
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
   * Detail of one file: hunks, intraline segments and the tokens of both sides.
   * Requested per file, so a diff of thousands of lines need not fit in a single
   * response (§12) and the UI can render what is on screen right away.
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

    // One palette per file, shared by both sides.
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

/** Line count; a trailing newline does not count as an extra empty line. */
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
 * Approve while comments are still open. The UI is supposed to prevent this, but the
 * server refuses it either way — with the ids in question attached (§8).
 */
export class DecisionConflict extends Error {
  constructor(readonly openCommentIds: string[]) {
    super("there are still open comments");
    this.name = "DecisionConflict";
  }
}

/**
 * Carries a review's comments over to the new round. File content is fetched once per
 * path and cached: a review can hold dozens of comments in the same file.
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
