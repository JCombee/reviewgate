import { afterEach, describe, expect, it } from "vitest";
import { TestRepo } from "../git/testRepo.js";
import { addComment } from "./mutations.js";
import { ReviewStore } from "./store.js";

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

describe("ReviewStore", () => {
  it("maakt een review met een eerste ronde", async () => {
    const { store } = await storeInTempRepo();
    const review = await store.findOrCreate(input);
    expect(review.rounds).toHaveLength(1);
    expect(review.rounds[0]).toMatchObject({ n: 1, diffHash: "hash-1", scope: "staged" });
    expect(review.status).toBe("open");
  });

  it("hergebruikt de review voor dezelfde diff, zodat comments een herstart overleven", async () => {
    const { store, gitDir } = await storeInTempRepo();
    const first = await store.findOrCreate(input);
    const { review } = addComment(first, { scope: "global", body: "blijft bestaan" });
    await store.save(review);

    // Een nieuwe store staat gelijk aan een herstart van de server.
    const fresh = new ReviewStore(gitDir);
    const again = await fresh.findOrCreate(input);
    expect(again.id).toBe(first.id);
    expect(again.comments).toHaveLength(1);
    expect(again.comments[0]?.body).toBe("blijft bestaan");
  });

  it("begint een nieuwe review bij een andere diff", async () => {
    const { store } = await storeInTempRepo();
    const first = await store.findOrCreate(input);
    const second = await store.findOrCreate({ ...input, diffHash: "hash-2" });
    expect(second.id).not.toBe(first.id);
  });

  it("begint een nieuwe review op een andere branch", async () => {
    const { store } = await storeInTempRepo();
    const first = await store.findOrCreate(input);
    const other = await store.findOrCreate({ ...input, branch: "feature/x" });
    expect(other.id).not.toBe(first.id);
  });

  it("hergebruikt een afgesloten review niet", async () => {
    const { store } = await storeInTempRepo();
    const first = await store.findOrCreate(input);
    await store.save({ ...first, status: "approved" });
    const next = await store.findOrCreate(input);
    expect(next.id).not.toBe(first.id);
  });

  it("werkt updatedAt bij en laat createdAt staan", async () => {
    const { store } = await storeInTempRepo();
    const review = await store.findOrCreate(input);
    const saved = await store.save({ ...review, status: "abandoned" });
    expect(saved.createdAt).toBe(review.createdAt);
    expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(Date.parse(review.updatedAt));
  });
});
