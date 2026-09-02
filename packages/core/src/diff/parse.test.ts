import { describe, expect, it } from "vitest";
import { buildDiff, parseUnifiedDiff } from "./parse.js";

describe("parseUnifiedDiff", () => {
  it("reads a modified file with correct line numbers", () => {
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
      "   // done",
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

  it("recognises a new file", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..9daeafb",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.status).toBe("added");
    expect(file?.oldPath).toBeNull();
    expect(file?.newPath).toBe("new.txt");
    expect(file?.additions).toBe(2);
    expect(file?.newMode).toBe("100644");
  });

  it("recognises a deleted file and keeps the old path as its key", () => {
    const patch = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 9daeafb..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.status).toBe("deleted");
    expect(file?.newPath).toBeNull();
    expect(file?.path).toBe("gone.txt");
    expect(file?.deletions).toBe(2);
  });

  it("recognises a pure rename without hunks", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.status).toBe("renamed");
    expect(file?.oldPath).toBe("old.ts");
    expect(file?.newPath).toBe("new.ts");
    expect(file?.similarity).toBe(100);
    expect(file?.hunks).toHaveLength(0);
    expect(file?.path).toBe("new.ts");
  });

  it("recognises a rename that also changes content", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 87%",
      "rename from old.ts",
      "rename to new.ts",
      "index 83db48f..bf269f4 100644",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,2 +1,2 @@",
      " kept",
      "-before",
      "+after",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.status).toBe("renamed");
    expect(file?.similarity).toBe(87);
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
  });

  it("marks binary files and gives them no hunks", () => {
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

  it("treats 'Binary files ... differ' as binary too", () => {
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

  it("attaches 'no newline at end of file' to the right line", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-before",
      "\\ No newline at end of file",
      "+after",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]?.noNewlineAtEof).toBe(true);
    expect(lines[1]?.noNewlineAtEof).toBe(true);
  });

  it("recognises a mode-only change", () => {
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

  it("recognises a submodule by mode 160000", () => {
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

  it("reads paths with spaces from the ---/+++ lines", () => {
    const patch = [
      "diff --git a/dir with space/foo bar.ts b/dir with space/foo bar.ts",
      "index 1111111..2222222 100644",
      "--- a/dir with space/foo bar.ts",
      "+++ b/dir with space/foo bar.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.path).toBe("dir with space/foo bar.ts");
  });

  it("reads non-ASCII paths, even when quotePath was on after all", () => {
    const patch = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      "index 1111111..2222222 100644",
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch);
    expect(file?.path).toBe("café.ts");
  });

  it("splits CRLF output just as well as LF output", () => {
    const patch =
      [
        "diff --git a/a.txt b/a.txt",
        "index 1111111..2222222 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ].join("\r\n") + "\r\n";

    const [file] = parseUnifiedDiff(patch);
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    expect(file?.hunks[0]?.lines[1]?.content).toBe("after");
  });

  it("reads several files and several hunks from one patch", () => {
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

  it("returns an empty list for an empty diff", () => {
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
