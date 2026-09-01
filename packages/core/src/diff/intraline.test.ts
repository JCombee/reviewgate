import { describe, expect, it } from "vitest";
import { intralineDiff, segmentsFor } from "./intraline.js";
import { parseUnifiedDiff } from "./parse.js";

const slice = (s: string, seg: { start: number; end: number }) => s.slice(seg.start, seg.end);

describe("segmentsFor", () => {
  it("markeert alleen het gewijzigde woord", () => {
    const before = "export const b = 2;";
    const after = "export const b = 22;";
    const res = segmentsFor(before, after);
    expect(res).not.toBeNull();
    expect(res?.delSegments.map((s) => slice(before, s))).toEqual(["2"]);
    expect(res?.addSegments.map((s) => slice(after, s))).toEqual(["22"]);
  });

  it("markeert een toevoeging aan het eind zonder de rest aan te raken", () => {
    const before = "foo(a)";
    const after = "foo(a, b)";
    const res = segmentsFor(before, after);
    expect(res?.delSegments).toEqual([]);
    expect(res?.addSegments.map((s) => slice(after, s))).toEqual([", b"]);
  });

  it("markeert een verwijdering in het midden", () => {
    const before = "if (a && b && c) {";
    const after = "if (a && c) {";
    const res = segmentsFor(before, after);
    expect(res?.delSegments.map((s) => slice(before, s))).toEqual(["b && "]);
    expect(res?.addSegments).toEqual([]);
  });

  it("houdt gemeenschappelijke inspringing buiten de highlight", () => {
    const before = "    return oud;";
    const after = "    return nieuw;";
    const res = segmentsFor(before, after);
    expect(res?.delSegments.map((s) => slice(before, s))).toEqual(["oud"]);
    expect(res?.addSegments.map((s) => slice(after, s))).toEqual(["nieuw"]);
  });

  it("geeft null bij identieke regels", () => {
    expect(segmentsFor("gelijk", "gelijk")).toBeNull();
  });

  it("geeft null als de regel volledig vervangen is", () => {
    // Alles highlighten is hetzelfde als niets highlighten, maar dan met ruis.
    expect(segmentsFor("const a = 1;", "throw new Error('boem');")).toBeNull();
  });

  it("geeft null bij extreem lange regels", () => {
    const long = "x".repeat(3000);
    expect(segmentsFor(long, `${long}y`)).toBeNull();
  });
});

describe("intralineDiff", () => {
  const hunkOf = (patch: string) => {
    const hunk = parseUnifiedDiff(patch)[0]?.hunks[0];
    if (!hunk) throw new Error("geen hunk in fixture");
    return hunk;
  };

  it("koppelt een min-blok aan het bijbehorende plus-blok", () => {
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

  it("koppelt niets bij blokken van ongelijke lengte", () => {
    const hunk = hunkOf(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,2 +1,3 @@",
        " context",
        "-oud",
        "+nieuw een",
        "+nieuw twee",
        "",
      ].join("\n"),
    );
    expect(intralineDiff(hunk)).toEqual([]);
  });

  it("koppelt niets in een hunk met alleen toevoegingen", () => {
    const hunk = hunkOf(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,2 @@",
        " context",
        "+erbij",
        "",
      ].join("\n"),
    );
    expect(intralineDiff(hunk)).toEqual([]);
  });
});
