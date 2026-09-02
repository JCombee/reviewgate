import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ReviewScope } from "../types.js";
import type { Review, Round } from "./types.js";

/**
 * Reviews on disk. No database — JSON files in `.git/reviewgate/reviews/`, a path
 * that is already outside version control (§4).
 */
export class ReviewStore {
  constructor(private readonly gitDir: string) {}

  get dir(): string {
    return path.join(this.gitDir, "reviewgate", "reviews");
  }

  fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async load(id: string): Promise<Review | null> {
    try {
      const raw = await fs.readFile(this.fileFor(id), "utf8");
      return JSON.parse(raw) as Review;
    } catch {
      return null;
    }
  }

  async list(): Promise<Review[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const reviews: Review[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const review = await this.load(name.slice(0, -".json".length));
      if (review) reviews.push(review);
    }
    return reviews;
  }

  /**
   * Writes atomically: a temporary file first, then a rename. Half a review on disk
   * is worse than a stale one, and the server writes on every mutation.
   */
  async save(review: Review): Promise<Review> {
    const next: Review = { ...review, updatedAt: new Date().toISOString() };
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.fileFor(next.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
    return next;
  }

  /**
   * The review for this branch, with the right round on it.
   *
   * The same diff yields the same review with the same round, so comments survive a
   * restart of the server. A changed diff on a review where changes were already
   * requested is round n+1 of that same review: only that way can you see, in round
   * 2, whether your points from round 1 were addressed (§5). Only after an approve
   * does a new review begin.
   */
  async findOrCreate(input: {
    repoRoot: string;
    branch: string | null;
    scope: ReviewScope;
    diffHash: string;
    commitMessage?: string | null;
    claudeSessionId?: string | null;
    transcriptPath?: string | null;
  }): Promise<{ review: Review; newRound: boolean }> {
    const candidates = (await this.list())
      .filter((r) => r.branch === input.branch && r.status !== "approved" && r.status !== "abandoned")
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    for (const review of candidates) {
      const round = review.rounds[review.rounds.length - 1];
      if (!round) continue;

      // Exactly the same round: just carry on where you were.
      if (round.diffHash === input.diffHash && round.scope === input.scope && !round.decision) {
        return { review, newRound: false };
      }

      // The code changed after a "request changes": next round.
      //
      // Deliberately not saved here. The caller first re-anchors the comments onto
      // their new lines and then saves once; otherwise there is a moment where the
      // new round is on disk carrying the line numbers of the previous one (§5).
      if (round.decision === "request_changes") {
        const next: Review = {
          ...review,
          status: "open",
          rounds: [...review.rounds, this.#newRound(round.n + 1, input)],
        };
        return { review: next, newRound: true };
      }
    }

    const now = new Date().toISOString();
    const review = await this.save({
      id: randomUUID(),
      repoRoot: input.repoRoot,
      branch: input.branch,
      createdAt: now,
      updatedAt: now,
      rounds: [this.#newRound(1, input)],
      comments: [],
      suggestions: [],
      chat: [],
      status: "open",
    });
    return { review, newRound: false };
  }

  #newRound(
    n: number,
    input: {
      scope: ReviewScope;
      diffHash: string;
      commitMessage?: string | null;
      claudeSessionId?: string | null;
      transcriptPath?: string | null;
    },
  ): Round {
    return {
      n,
      diffHash: input.diffHash,
      scope: input.scope,
      commitMessage: input.commitMessage ?? null,
      editedCommitMessage: null,
      claudeSessionId: input.claudeSessionId ?? null,
      transcriptPath: input.transcriptPath ?? null,
      decision: null,
      decidedAt: null,
      summary: null,
    };
  }
}
