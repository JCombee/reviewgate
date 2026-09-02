import { describe, expect, it } from "vitest";
import { intralineDiff, segmentsFor } from "./intraline.js";
import { parseUnifiedDiff } from "./parse.js";

const slice = (s: string, seg: { start: number; end: number }) => s.slice(seg.start, seg.end);

describe("segmentsFor", () => {
  it("marks only the changed word", () => {
    const before = "export const b = 2;";
    const after = "export const b = 22;";
    const res = segmentsFor(before, after);
    expect(res).not.toBeNull();
    expect(res?.delSegments.map((s) => slice(before, s))).toEqual(["2"]);
    expect(res?.addSegments.map((s) => slice(after, s))).toEqual(["22"]);
  });

  it("marks an addition at the end without touching the rest", () => {
    const before = "foo(a)";
    const after = "foo(a, b)";
    const res = segmentsFor(before, after);
    expect(res?.delSegments).toEqual([]);
    expect(res?.addSegments.map((s) => slice(after, s))).toEqual([", b"]);
  });

  it("marks a removal in the middle", () => {
    const before = "if (a && b && c) {";
    const after = "if (a && c) {";
    const res = segmentsFor(before, after);
    expect(res?.delSegments.map((s) => slice(before, s))).toEqual(["b && "]);
    expect(res?.addSegments).toEqual([]);
  });

  it("keeps shared indentation out of the highlight", () => {
    const before = "    return before;";
    const after = "    return after;";
    const res = segmentsFor(before, after);
    expect(res?.delSegments.map((s) => slice(before, s))).toEqual(["before"]);
    expect(res?.addSegments.map((s) => slice(after, s))).toEqual(["after"]);
  });

  it("returns null for identical lines", () => {
    expect(segmentsFor("same", "same")).toBeNull();
  });

  it("returns null when the line is replaced wholesale", () => {
    // Highlighting everything is the same as highlighting nothing, only noisier.
    expect(segmentsFor("const a = 1;", "throw new Error('boom');")).toBeNull();
  });

  it("returns null for extremely long lines", () => {
    const long = "x".repeat(3000);
    expect(segmentsFor(long, `${long}y`)).toBeNull();
  });
});

describe("intralineDiff", () => {
  const hunkOf = (patch: string) => {
    const hunk = parseUnifiedDiff(patch)[0]?.hunks[0];
    if (!hunk) throw new Error("no hunk in fixture");
    return hunk;
  };

  it("pairs a minus block with the matching plus block", () => {
    const hunk = hunkOf(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,3 +1,3 @@",
        " context",
        "-const a = 1;",
        "-const b = 2;",
        "+const a = 11;",
        "+const b = 22;",
        "",
      ].join("\n"),
    );

    const pairs = intralineDiff(hunk);
    expect(pairs.map((p) => [p.delIndex, p.addIndex])).toEqual([
      [1, 3],
      [2, 4],
    ]);
    const del = hunk.lines[1]?.content ?? "";
    const add = hunk.lines[3]?.content ?? "";
    expect(pairs[0]?.delSegments.map((s) => slice(del, s))).toEqual(["1"]);
    expect(pairs[0]?.addSegments.map((s) => slice(add, s))).toEqual(["11"]);
  });

  it("pairs nothing when the blocks have different lengths", () => {
    const hunk = hunkOf(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,2 +1,3 @@",
        " context",
        "-before",
        "+after one",
        "+after two",
        "",
      ].join("\n"),
    );
    expect(intralineDiff(hunk)).toEqual([]);
  });

  it("pairs nothing in a hunk with only additions", () => {
    const hunk = hunkOf(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,2 @@",
        " context",
        "+added",
        "",
      ].join("\n"),
    );
    expect(intralineDiff(hunk)).toEqual([]);
  });
});
