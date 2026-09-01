import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ReviewScope } from "../types.js";
import type { Review, Round } from "./types.js";

/**
 * Reviews op schijf. Geen database — JSON-bestanden in `.git/reviewgate/reviews/`,
 * dat pad zit al buiten versiebeheer (§4).
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
   * Schrijft atomair: eerst een tijdelijk bestand, dan rename. Een halve review op
   * schijf is erger dan een verouderde, en de server schrijft bij elke mutatie.
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
   * De open review voor deze diff, of een nieuwe. Dezelfde diff in dezelfde branch
   * levert dezelfde review op, zodat comments een herstart van de server overleven.
   * Meerdere rondes per review komen in M5; tot dan is een gewijzigde diff een
   * nieuwe review.
   */
  async findOrCreate(input: {
    repoRoot: string;
    branch: string | null;
    scope: ReviewScope;
    diffHash: string;
    commitMessage?: string | null;
    claudeSessionId?: string | null;
    transcriptPath?: string | null;
  }): Promise<Review> {
    for (const review of await this.list()) {
      if (review.status !== "open") continue;
      if (review.branch !== input.branch) continue;
      const round = review.rounds[review.rounds.length - 1];
      if (!round || round.diffHash !== input.diffHash || round.scope !== input.scope) continue;
      return review;
    }

    const now = new Date().toISOString();
    const round: Round = {
      n: 1,
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

    return this.save({
      id: randomUUID(),
      repoRoot: input.repoRoot,
      branch: input.branch,
      createdAt: now,
      updatedAt: now,
      rounds: [round],
      comments: [],
      suggestions: [],
      chat: [],
      status: "open",
    });
  }
}
