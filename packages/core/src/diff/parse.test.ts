import { describe, expect, it } from "vitest";
import { buildDiff, parseUnifiedDiff } from "./parse.js";

describe("parseUnifiedDiff", () => {
  it("leest een gewijzigd bestand met correcte regelnummers", () => {
    const patch = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 83db48f..bf269f4 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,3 +10,4 @@ export function handle() {",
      "   const a = 1;",
      "-  return a;",
      "+  const b = 2;",
      "+  return a + b;",
      "   // klaar",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file).toBeDefined();
    expect(file?.status).toBe("modified");
    expect(file?.path).toBe("src/foo.ts");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(1);

    const hunk = file?.hunks[0];
    expect(hunk?.section).toBe("export function handle() {");
    expect(hunk?.oldStart).toBe(10);
    expect(hunk?.newStart).toBe(10);
    expect(hunk?.lines.map((l) => [l.type, l.oldLine, l.newLine])).toEqual([
      ["context", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["add", null, 12],
      ["context", 12, 13],
    ]);
  });

  it("herkent een nieuw bestand", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..9daeafb",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+een",
      "+twee",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.status).toBe("added");
    expect(file?.oldPath).toBeNull();
    expect(file?.newPath).toBe("new.txt");
    expect(file?.additions).toBe(2);
    expect(file?.newMode).toBe("100644");
  });

  it("herkent een verwijderd bestand en houdt het oude pad als sleutel", () => {
    const patch = [
      "diff --git a/weg.txt b/weg.txt",
      "deleted file mode 100644",
      "index 9daeafb..0000000",
      "--- a/weg.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-een",
      "-twee",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.status).toBe("deleted");
    expect(file?.newPath).toBeNull();
    expect(file?.path).toBe("weg.txt");
    expect(file?.deletions).toBe(2);
  });

  it("herkent een pure rename zonder hunks", () => {
    const patch = [
      "diff --git a/oud.ts b/nieuw.ts",
      "similarity index 100%",
      "rename from oud.ts",
      "rename to nieuw.ts",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.status).toBe("renamed");
    expect(file?.oldPath).toBe("oud.ts");
    expect(file?.newPath).toBe("nieuw.ts");
    expect(file?.similarity).toBe(100);
    expect(file?.hunks).toHaveLength(0);
    expect(file?.path).toBe("nieuw.ts");
  });

  it("herkent een rename mét inhoudswijziging", () => {
    const patch = [
      "diff --git a/oud.ts b/nieuw.ts",
      "similarity index 87%",
      "rename from oud.ts",
      "rename to nieuw.ts",
      "index 83db48f..bf269f4 100644",
      "--- a/oud.ts",
      "+++ b/nieuw.ts",
      "@@ -1,2 +1,2 @@",
      " behouden",
      "-oud",
      "+nieuw",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.status).toBe("renamed");
    expect(file?.similarity).toBe(87);
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
  });

  it("markeert binaire bestanden en geeft ze geen hunks", () => {
    const patch = [
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "index 0000000..d1e2f3a",
      "GIT binary patch",
      "literal 8",
      "zcmZQzU|",
      "",
      "literal 0",
      "HcmV?d00001",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.binary).toBe(true);
    expect(file?.status).toBe("added");
    expect(file?.hunks).toHaveLength(0);
    expect(file?.additions).toBe(0);
  });

  it("markeert 'Binary files ... differ' ook als binair", () => {
    const patch = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.binary).toBe(true);
    expect(file?.status).toBe("modified");
  });

  it("hangt 'no newline at end of file' aan de juiste regel", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-oud",
      "\\ No newline at end of file",
      "+nieuw",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]?.noNewlineAtEof).toBe(true);
    expect(lines[1]?.noNewlineAtEof).toBe(true);
  });

  it("herkent een pure mode-wijziging", () => {
    const patch = [
      "diff --git a/script b/script",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.status).toBe("mode_changed");
    expect(file?.oldMode).toBe("100644");
    expect(file?.newMode).toBe("100755");
  });

  it("herkent een submodule aan mode 160000", () => {
    const patch = [
      "diff --git a/vendor/lib b/vendor/lib",
      "index 1111111..2222222 160000",
      "--- a/vendor/lib",
      "+++ b/vendor/lib",
      "@@ -1 +1 @@",
      "-Subproject commit 1111111111111111111111111111111111111111",
      "+Subproject commit 2222222222222222222222222222222222222222",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.submodule).toBe(true);
  });

  it("leest paden met spaties via de ---/+++ regels", () => {
    const patch = [
      "diff --git a/map met spatie/foo bar.ts b/map met spatie/foo bar.ts",
      "index 1111111..2222222 100644",
      "--- a/map met spatie/foo bar.ts",
      "+++ b/map met spatie/foo bar.ts",
      "@@ -1 +1 @@",
      "-oud",
      "+nieuw",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.path).toBe("map met spatie/foo bar.ts");
  });

  it("leest niet-ASCII paden, ook als quotePath toch aanstond", () => {
    const patch = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      "index 1111111..2222222 100644",
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      "@@ -1 +1 @@",
      "-oud",
      "+nieuw",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.path).toBe("café.ts");
  });

  it("splitst CRLF-output net zo goed als LF-output", () => {
    const patch =
      [
        "diff --git a/a.txt b/a.txt",
        "index 1111111..2222222 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-oud",
        "+nieuw",
      ].join("\r\n") + "\r\n";

    const [file] = parseUnifiedDiff(patch);
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    expect(file?.hunks[0]?.lines[1]?.content).toBe("nieuw");
  });

  it("leest meerdere bestanden en meerdere hunks in één patch", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      " x",
      "-1",
      "+2",
      "@@ -20,2 +20,3 @@",
      " y",
      "+3",
      " z",
      "diff --git a/b.ts b/b.ts",
      "index 3333333..4444444 100644",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -5 +5 @@",
      "-a",
      "+b",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(patch);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(files[0]?.hunks).toHaveLength(2);
    expect(files[0]?.hunks[1]?.oldStart).toBe(20);

    const diff = buildDiff("staged", files);
    expect(diff.additions).toBe(3);
    expect(diff.deletions).toBe(2);
    expect(diff.changedLines).toBe(5);
  });

  it("geeft een lege lijst voor een lege diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(buildDiff("staged", [])).toEqual({
      scope: "staged",
      files: [],
      additions: 0,
      deletions: 0,
      changedLines: 0,
    });
  });
});
