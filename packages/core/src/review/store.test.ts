import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { TestRepo } from "../git/testRepo.js";
import { addComment } from "./mutations.js";
import { ReviewStore } from "./store.js";
import type { Review } from "./types.js";

let repos: TestRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.map((r) => r.cleanup()));
  repos = [];
});

async function storeInTempRepo(): Promise<{ store: ReviewStore; gitDir: string }> {
  const repo = await TestRepo.create();
  repos.push(repo);
  const gitDir = `${repo.root}/.git`;
  return { store: new ReviewStore(gitDir), gitDir };
}

const input = {
  repoRoot: "/repo",
  branch: "main",
  scope: "staged" as const,
  diffHash: "hash-1",
};

/** Closes the current round the way `POST /decision` does. */
function withDecision(review: Review, decision: "approve" | "request_changes"): Review {
  const rounds = [...review.rounds];
  const last = rounds[rounds.length - 1];
  if (!last) throw new Error("no round");
  rounds[rounds.length - 1] = { ...last, decision, decidedAt: new Date().toISOString() };
  return {
    ...review,
    rounds,
    status: decision === "approve" ? "approved" : "changes_requested",
  };
}

describe("ReviewStore", () => {
  it("creates a review with a first round", async () => {
    const { store } = await storeInTempRepo();
    const { review, newRound } = await store.findOrCreate(input);
    expect(newRound).toBe(false);
    expect(review.rounds).toHaveLength(1);
    expect(review.rounds[0]).toMatchObject({ n: 1, diffHash: "hash-1", scope: "staged" });
    expect(review.status).toBe("open");
  });

  it("reuses the review for the same diff, so comments survive a restart", async () => {
    const { store, gitDir } = await storeInTempRepo();
    const { review: first } = await store.findOrCreate(input);
    const { review } = addComment(first, { scope: "global", body: "this sticks around" });
    await store.save(review);

    // A fresh store is the same thing as a restart of the server.
    const fresh = new ReviewStore(gitDir);
    const { review: again, newRound } = await fresh.findOrCreate(input);
    expect(again.id).toBe(first.id);
    expect(newRound).toBe(false);
    expect(again.comments).toHaveLength(1);
    expect(again.comments[0]?.body).toBe("this sticks around");
  });

  it("starts round 2 in the same review after a request changes", async () => {
    const { store } = await storeInTempRepo();
    const { review: first } = await store.findOrCreate(input);
    const { review: withComment } = addComment(first, {
      scope: "global",
      body: "point from round 1",
    });
    await store.save(withDecision(withComment, "request_changes"));

    const { review: second, newRound } = await store.findOrCreate({
      ...input,
      diffHash: "hash-2",
      commitMessage: "fix: addressed",
    });

    // Same review, so you can see whether your round 1 points were addressed.
    expect(second.id).toBe(first.id);
    expect(newRound).toBe(true);
    expect(second.rounds).toHaveLength(2);
    expect(second.rounds[1]).toMatchObject({ n: 2, diffHash: "hash-2", decision: null });
    expect(second.status).toBe("open");
    expect(second.comments).toHaveLength(1);
    expect(second.comments[0]?.round).toBe(1);
  });

  it("starts a new review after an approve", async () => {
    const { store } = await storeInTempRepo();
    const { review: first } = await store.findOrCreate(input);
    await store.save(withDecision(first, "approve"));

    const { review: next } = await store.findOrCreate({ ...input, diffHash: "hash-2" });
    expect(next.id).not.toBe(first.id);
    expect(next.rounds).toHaveLength(1);
  });

  it("starts a new review on another branch", async () => {
    const { store } = await storeInTempRepo();
    const { review: first } = await store.findOrCreate(input);
    const { review: other } = await store.findOrCreate({ ...input, branch: "feature/x" });
    expect(other.id).not.toBe(first.id);
  });

  it("updates updatedAt and leaves createdAt alone", async () => {
    const { store } = await storeInTempRepo();
    const { review } = await store.findOrCreate(input);
    const saved = await store.save({ ...review, status: "abandoned" });
    expect(saved.createdAt).toBe(review.createdAt);
    expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(review.updatedAt));
  });

  it("never touches an abandoned review again", async () => {
    const { store } = await storeInTempRepo();
    const { review: first } = await store.findOrCreate(input);
    await store.save({ ...first, status: "abandoned" });

    const { review: next } = await store.findOrCreate(input);
    expect(next.id).not.toBe(first.id);
  });

  it("initializes chats: [] for a brand-new review", async () => {
    const { store } = await storeInTempRepo();
    const { review } = await store.findOrCreate(input);
    expect(review.chats).toEqual([]);
  });

  describe("legacy chat migration", () => {
    async function writeLegacy(
      store: ReviewStore,
      body: Record<string, unknown>,
    ): Promise<string> {
      const id = "legacy-review";
      await fs.mkdir(store.dir, { recursive: true });
      await fs.writeFile(store.fileFor(id), JSON.stringify({ id, ...body }), "utf8");
      return id;
    }

    const base = {
      repoRoot: "/repo",
      branch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      rounds: [],
      comments: [],
      suggestions: [],
      status: "open",
    };

    it("migrates a legacy chat array into a single named chat", async () => {
      const { store } = await storeInTempRepo();
      const legacyMessages = [{ id: "m1", role: "user", body: "hi", at: "2026-01-01T00:00:00.000Z" }];
      const id = await writeLegacy(store, { ...base, chat: legacyMessages });

      const loaded = await store.load(id);
      expect(loaded?.chats).toHaveLength(1);
      expect(loaded?.chats[0]).toMatchObject({
        title: "Chat",
        model: null,
        messages: legacyMessages,
        createdAt: base.createdAt,
      });
      expect(loaded?.chats[0]?.id).toBeTruthy();
      expect((loaded as unknown as { chat?: unknown }).chat).toBeUndefined();
    });

    it("migrates an empty legacy chat array to chats: []", async () => {
      const { store } = await storeInTempRepo();
      const id = await writeLegacy(store, { ...base, chat: [] });

      const loaded = await store.load(id);
      expect(loaded?.chats).toEqual([]);
    });

    it("leaves an already-migrated chats array untouched", async () => {
      const { store } = await storeInTempRepo();
      const chats = [
        {
          id: "c1",
          title: "Chat",
          model: null,
          messages: [],
          createdAt: base.createdAt,
        },
      ];
      const id = await writeLegacy(store, { ...base, chats });

      const loaded = await store.load(id);
      expect(loaded?.chats).toEqual(chats);
    });

    it("defaults to chats: [] when neither chat nor chats is present", async () => {
      const { store } = await storeInTempRepo();
      const id = await writeLegacy(store, { ...base });

      const loaded = await store.load(id);
      expect(loaded?.chats).toEqual([]);
    });

    it("loads an old review file with a dismissedReason: auto_duplicate suggestion without throwing", async () => {
      const { store } = await storeInTempRepo();
      const legacySuggestion = {
        id: "s1",
        round: 1,
        scope: "line",
        body: "this fetch has no error handling",
        severity: "consideration",
        status: "dismissed",
        dismissedReason: "auto_duplicate",
        duplicateOf: "old-id",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const id = await writeLegacy(store, { ...base, suggestions: [legacySuggestion] });

      const loaded = await store.load(id);
      expect(loaded?.suggestions).toHaveLength(1);
      expect(loaded?.suggestions[0]).toMatchObject({
        dismissedReason: "auto_duplicate",
        duplicateOf: "old-id",
      });
    });
  });
});
