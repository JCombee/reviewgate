import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiffFile } from "../types.js";
import { NodeGitClient } from "./NodeGitClient.js";
import { TestRepo } from "./testRepo.js";

/** Een klein maar echt PNG-bestand, zodat git het als binair ziet. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01,
]);

const byPath = (files: readonly DiffFile[], p: string): DiffFile | undefined =>
  files.find((f) => f.path === p);

describe("NodeGitClient — gestagede scope met alle bestandssoorten", () => {
  let repo: TestRepo;
  let git: NodeGitClient;

  beforeAll(async () => {
    repo = await TestRepo.create();

    // Ronde 0: de basis waartegen gediffd wordt.
    await repo.write("src/behouden.ts", "export const a = 1;\nexport const b = 2;\n");
    await repo.write("src/hernoem-mij.ts", ["één", "twee", "drie", "vier", "vijf"].join("\n") + "\n");
    await repo.write("src/weg.ts", "verdwijnt\n");
    await repo.write("map met spatie/café.ts", "oud\n");
    await repo.addAll();
    await repo.commit("basis");

    // Ronde 1: toevoeging, verwijdering, wijziging, rename, binair, untracked.
    await repo.write("src/behouden.ts", "export const a = 1;\nexport const b = 22;\nexport const c = 3;\n");
    await repo.write("src/nieuw.ts", "export const nieuw = true;\n");
    await repo.remove("src/weg.ts");
    await repo.rename("src/hernoem-mij.ts", "src/hernoemd.ts");
    await repo.write("map met spatie/café.ts", "nieuw\n");
    await repo.writeBinary("assets/logo.png", PNG);
    await repo.addAll();
    await repo.write("untracked.txt", "nog niet gestaged\n");

    git = await NodeGitClient.open(repo.root);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("rapporteert de repo correct", async () => {
    const info = await git.info();
    expect(info.root).toBe(repo.root);
    expect(info.hasHead).toBe(true);
    expect(info.branch).toBe("main");
    expect(info.inMergeOrRebase).toBe(false);
  });

  it("levert een gewijzigd bestand met kloppende tellingen", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "src/behouden.ts");
    expect(f?.status).toBe("modified");
    expect(f?.additions).toBe(2);
    expect(f?.deletions).toBe(1);
    expect(f?.hunks.length).toBeGreaterThan(0);
  });

  it("levert een toegevoegd bestand", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "src/nieuw.ts");
    expect(f?.status).toBe("added");
    expect(f?.oldPath).toBeNull();
    expect(f?.additions).toBe(1);
  });

  it("levert een verwijderd bestand onder zijn oude pad", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "src/weg.ts");
    expect(f?.status).toBe("deleted");
    expect(f?.newPath).toBeNull();
    expect(f?.deletions).toBe(1);
  });

  it("detecteert de rename in plaats van add + delete", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "src/hernoemd.ts");
    expect(f?.status).toBe("renamed");
    expect(f?.oldPath).toBe("src/hernoem-mij.ts");
    expect(f?.newPath).toBe("src/hernoemd.ts");
    expect(byPath(diff.files, "src/hernoem-mij.ts")).toBeUndefined();
  });

  it("markeert het binaire bestand zonder hunks", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "assets/logo.png");
    expect(f?.binary).toBe(true);
    expect(f?.status).toBe("added");
    expect(f?.hunks).toHaveLength(0);
  });

  it("houdt paden met spaties en niet-ASCII tekens intact, in POSIX-vorm", async () => {
    const diff = await git.diff("staged");
    const f = byPath(diff.files, "map met spatie/café.ts");
    expect(f).toBeDefined();
    expect(f?.path).not.toContain("\\");
  });

  it("neemt untracked bestanden alleen in de working-scope mee", async () => {
    const staged = await git.diff("staged");
    expect(byPath(staged.files, "untracked.txt")).toBeUndefined();

    const working = await git.diff("working", { includeUntracked: true });
    const f = byPath(working.files, "untracked.txt");
    expect(f?.status).toBe("added");
    expect(f?.additions).toBe(1);

    const zonder = await git.diff("working", { includeUntracked: false });
    expect(byPath(zonder.files, "untracked.txt")).toBeUndefined();
  });

  it("telt totalen over de hele diff", async () => {
    const diff = await git.diff("staged");
    const som = diff.files.reduce(
      (acc, f) => ({ a: acc.a + f.additions, d: acc.d + f.deletions }),
      { a: 0, d: 0 },
    );
    expect(diff.additions).toBe(som.a);
    expect(diff.deletions).toBe(som.d);
    expect(diff.changedLines).toBe(som.a + som.d);
  });

  it("respecteert het aantal contextregels", async () => {
    const ruim = await git.diff("staged", { context: 5 });
    const krap = await git.diff("staged", { context: 0 });
    const ruimLines = byPath(ruim.files, "src/behouden.ts")?.hunks[0]?.lines.length ?? 0;
    const krapLines = byPath(krap.files, "src/behouden.ts")?.hunks[0]?.lines.length ?? 0;
    expect(ruimLines).toBeGreaterThan(krapLines);
    expect(krapLines).toBe(3);
  });

  it("levert bestandsinhoud aan beide kanten van de diff", async () => {
    const oud = await git.fileContent("src/behouden.ts", "old", "staged");
    const nieuw = await git.fileContent("src/behouden.ts", "new", "staged");
    expect(oud).toContain("export const b = 2;");
    expect(nieuw).toContain("export const b = 22;");
    expect(await git.fileContent("bestaat/niet.ts", "old", "staged")).toBeNull();
  });

  it("levert een lege diff als er niets gestaged is", async () => {
    const schoon = await TestRepo.create();
    try {
      await schoon.write("a.txt", "x\n");
      await schoon.addAll();
      await schoon.commit("init");
      const g = await NodeGitClient.open(schoon.root);
      const diff = await g.diff("staged");
      expect(diff.files).toEqual([]);
      expect(diff.changedLines).toBe(0);
    } finally {
      await schoon.cleanup();
    }
  });
});

describe("NodeGitClient — repo zonder commits", () => {
  it("diffs tegen de lege boom", async () => {
    const repo = await TestRepo.create();
    try {
      await repo.write("eerste.ts", "export const x = 1;\n");
      await repo.addAll();

      const git = await NodeGitClient.open(repo.root);
      const info = await git.info();
      expect(info.hasHead).toBe(false);

      const diff = await git.diff("staged");
      const f = byPath(diff.files, "eerste.ts");
      expect(f?.status).toBe("added");
      expect(f?.additions).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("NodeGitClient — amend-scope", () => {
  it("diffs tegen de commit vóór HEAD", async () => {
    const repo = await TestRepo.create();
    try {
      await repo.write("a.txt", "een\n");
      await repo.addAll();
      await repo.commit("eerste");
      await repo.write("a.txt", "een\ntwee\n");
      await repo.addAll();
      await repo.commit("tweede");
      // Extra wijziging die in de amend meegaat.
      await repo.write("a.txt", "een\ntwee\ndrie\n");
      await repo.addAll();

      const git = await NodeGitClient.open(repo.root);
      const diff = await git.diff("amend");
      const f = byPath(diff.files, "a.txt");
      // Zowel de tweede commit als de nieuwe wijziging zitten in de scope.
      expect(f?.additions).toBe(2);
      expect(f?.deletions).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });
});
