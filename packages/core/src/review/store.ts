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
   * De review voor deze branch, met de juiste ronde erop.
   *
   * Dezelfde diff levert dezelfde review met dezelfde ronde op, zodat comments een
   * herstart van de server overleven. Een gewijzigde diff op een review waarin al
   * changes zijn gevraagd is ronde n+1 van diezelfde review: alleen zo kun je bij
   * ronde 2 zien of je punten uit ronde 1 zijn opgevolgd (§5). Alleen na een
   * approve begint er een nieuwe review.
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

      // Exact dezelfde ronde: gewoon verder waar je was.
      if (round.diffHash === input.diffHash && round.scope === input.scope && !round.decision) {
        return { review, newRound: false };
      }

      // De code is aangepast na een "request changes": volgende ronde.
      //
      // Bewust nog niet opslaan. De aanroeper verankert eerst de comments op hun
      // nieuwe regels en slaat dan één keer op; anders is er een moment waarop de
      // nieuwe ronde al op schijf staat met de regelnummers van de vorige (§5).
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
