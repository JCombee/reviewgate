import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiffFile } from "../types.js";
import { NodeGitClient } from "./NodeGitClient.js";
import { TestRepo } from "./testRepo.js";

/** A tiny but genuine PNG file, so git sees it as binary. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01,
]);

const byPath = (files: readonly DiffFile[], p: string): DiffFile | undefined =>
  files.find((f) => f.path === p);

describe("NodeGitClient — staged scope with every kind of file", () => {
  let repo: TestRepo;
  let git: NodeGitClient;

  beforeAll(async () => {
    repo = await TestRepo.create();

    // Round 0: the base we diff against.
    await repo.write("src/kept.ts", "export const a = 1;\nexport const b = 2;\n");
    await repo.write("src/rename-me.ts", ["one", "two", "three", "four", "five"].join("\n") + "\n");
    await repo.write("src/gone.ts", "disappears\n");
    await repo.write("dir with space/café.ts", "before\n");
    await repo.addAll();
    await repo.commit("base");

    // Round 1: addition, deletion, modification, rename, binary, untracked.
    await repo.write("src/kept.ts", "export const a = 1;\nexport const b = 22;\nexport const c = 3;\n");
    await repo.write("src/added.ts", "export const added = true;\n");
    await repo.remove("src/gone.ts");
    await repo.rename("src/rename-me.ts", "src/renamed.ts");
    await repo.write("dir with space/café.ts", "after\n");
    await repo.writeBinary("assets/logo.png", PNG);
    await repo.addAll();
    await repo.write("untracked.txt", "not staged yet\n");

    git = await NodeGitClient.open(repo.root);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("reports the repo correctly", async () => {
    const info = await git.info();
    expect(info.root).toBe(repo.root);
    expect(info.hasHead).toBe(true);
    expect(info.branch).toBe("main");
    expect(info.inMergeOrRebase).toBe(false);
  });

  it("yields a modified file with correct counts", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "src/kept.ts");
    expect(f?.status).toBe("modified");
    expect(f?.additions).toBe(2);
    expect(f?.deletions).toBe(1);
    expect(f?.hunks.length).toBeGreaterThan(0);
  });

  it("yields an added file", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "src/added.ts");
    expect(f?.status).toBe("added");
    expect(f?.oldPath).toBeNull();
    expect(f?.additions).toBe(1);
  });

  it("yields a deleted file under its old path", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "src/gone.ts");
    expect(f?.status).toBe("deleted");
    expect(f?.newPath).toBeNull();
    expect(f?.deletions).toBe(1);
  });

  it("detects the rename instead of an add plus a delete", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "src/renamed.ts");
    expect(f?.status).toBe("renamed");
    expect(f?.oldPath).toBe("src/rename-me.ts");
    expect(f?.newPath).toBe("src/renamed.ts");
    expect(byPath(diff.files, "src/rename-me.ts")).toBeUndefined();
  });

  it("marks the binary file and gives it no hunks", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "assets/logo.png");
    expect(f?.binary).toBe(true);
    expect(f?.status).toBe("added");
    expect(f?.hunks).toHaveLength(0);
  });

  it("keeps paths with spaces and non-ASCII characters intact, in POSIX form", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "dir with space/café.ts");
    expect(f).toBeDefined();
    expect(f?.path).not.toContain("\\");
  });

  it("includes untracked files in the working scope only", async () => {
    const staged = await git.diff("staged");
    expect(byPath(staged.files, "untracked.txt")).toBeUndefined();

    const working = await git.diff("working", { includeUntracked: true });
    const f = byPath(working.files, "untracked.txt");
    expect(f?.status).toBe("added");
    expect(f?.additions).toBe(1);

    const without = await git.diff("working", { includeUntracked: false });
    expect(byPath(without.files, "untracked.txt")).toBeUndefined();
  });

  it("totals up the whole diff", async () => {
    const diff = await git.diff("staged");
    const sum = diff.files.reduce(
      (acc, f) => ({ a: acc.a + f.additions, d: acc.d + f.deletions }),
      { a: 0, d: 0 },
    );
    expect(diff.additions).toBe(sum.a);
    expect(diff.deletions).toBe(sum.d);
    expect(diff.changedLines).toBe(sum.a + sum.d);
  });

  it("honours the number of context lines", async () => {
    const wide = await git.diff("staged", { context: 5 });
    const narrow = await git.diff("staged", { context: 0 });
    const wideLines = byPath(wide.files, "src/kept.ts")?.hunks[0]?.lines.length ?? 0;
    const narrowLines = byPath(narrow.files, "src/kept.ts")?.hunks[0]?.lines.length ?? 0;
    expect(wideLines).toBeGreaterThan(narrowLines);
    expect(narrowLines).toBe(3);
  });

  it("yields file content on both sides of the diff", async () => {
    const before = await git.fileContent("src/kept.ts", "old", "staged");
    const after = await git.fileContent("src/kept.ts", "new", "staged");
    expect(before).toContain("export const b = 2;");
    expect(after).toContain("export const b = 22;");
    expect(await git.fileContent("does/not/exist.ts", "old", "staged")).toBeNull();
  });

  it("yields an empty diff when nothing is staged", async () => {
    const clean = await TestRepo.create();
    try {
      await clean.write("a.txt", "x\n");
      await clean.addAll();
      await clean.commit("init");
      const g = await NodeGitClient.open(clean.root);
      const diff = await g.diff("staged");
      expect(diff.files).toEqual([]);
      expect(diff.changedLines).toBe(0);
    } finally {
      await clean.cleanup();
    }
  });
});

describe("NodeGitClient — repo without commits", () => {
  it("diffs against the empty tree", async () => {
    const repo = await TestRepo.create();
    try {
      await repo.write("first.ts", "export const x = 1;\n");
      await repo.addAll();

      const git = await NodeGitClient.open(repo.root);
      const info = await git.info();
      expect(info.hasHead).toBe(false);

      const diff = await git.diff("staged");
      const f = byPath(diff.files, "first.ts");
      expect(f?.status).toBe("added");
      expect(f?.additions).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("NodeGitClient — amend scope", () => {
  it("diffs against the commit before HEAD", async () => {
    const repo = await TestRepo.create();
    try {
      await repo.write("a.txt", "one\n");
      await repo.addAll();
      await repo.commit("first");
      await repo.write("a.txt", "one\ntwo\n");
      await repo.addAll();
      await repo.commit("second");
      // An extra change that the amend would carry along.
      await repo.write("a.txt", "one\ntwo\nthree\n");
      await repo.addAll();

      const git = await NodeGitClient.open(repo.root);
      const diff = await git.diff("amend");
      const f = byPath(diff.files, "a.txt");
      // Both the second commit and the new change are in scope.
      expect(f?.additions).toBe(2);
      expect(f?.deletions).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });
});
