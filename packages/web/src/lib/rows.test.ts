import type { DiffHunk } from "@reviewgate/core/api";
import { describe, expect, it } from "vitest";
import { buildRows, computeGaps, expand, toSplitRows, type LineRow, type Row } from "./rows.js";

const line = (
  type: "context" | "add" | "del",
  content: string,
  oldLine: number | null,
  newLine: number | null,
) => ({ type, content, oldLine, newLine, noNewlineAtEof: false });

/** A file of 30 lines with one hunk around line 11. */
const hunk: DiffHunk = {
  oldStart: 11,
  oldLines: 3,
  newStart: 11,
  newLines: 3,
  section: "function f()",
  lines: [
    line("context", "line 11", 11, 11),
    line("del", "before", 12, null),
    line("add", "after", null, 12),
    line("context", "line 13", 13, 13),
  ],
};

const fileLines = (n: number, prefix = "line ") =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

const base = {
  hunks: [hunk],
  oldLineCount: 30,
  newLineCount: 30,
  linesOld: fileLines(30),
  linesNew: fileLines(30),
  expansion: {},
};

describe("computeGaps", () => {
  it("finds the gap before and after the hunk", () => {
    const gaps = computeGaps({ hunks: [hunk], oldLineCount: 30, newLineCount: 30 });
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({ index: 0, oldStart: 1, oldEnd: 10, hidden: 10, hasAbove: false });
    expect(gaps[1]).toMatchObject({ index: 1, oldStart: 14, oldEnd: 30, hidden: 17, hasBelow: false });
  });

  it("does not count a hunk without old lines on the old side", () => {
    const added: DiffHunk = {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      section: "",
      lines: [line("add", "a", null, 1), line("add", "b", null, 2)],
    };
    const gaps = computeGaps({ hunks: [added], oldLineCount: 0, newLineCount: 2 });
    expect(gaps[0]?.hidden).toBe(0);
    expect(gaps[1]).toMatchObject({ oldStart: 1, newStart: 3, hidden: 0 });
  });

  it("reports no gap when the hunk spans the whole file", () => {
    const whole: DiffHunk = {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      section: "",
      lines: [line("context", "a", 1, 1), line("context", "b", 2, 2)],
    };
    const gaps = computeGaps({ hunks: [whole], oldLineCount: 2, newLineCount: 2 });
    expect(gaps.every((g) => g.hidden === 0)).toBe(true);
  });
});

describe("buildRows", () => {
  it("shows an expander per gap plus the lines of the hunk", () => {
    const rows = buildRows(base);
    expect(rows.map((r) => r.kind)).toEqual([
      "expander",
      "hunk",
      "line",
      "line",
      "line",
      "line",
      "expander",
    ]);
    expect((rows[0] as { hidden: number }).hidden).toBe(10);
    expect((rows[6] as { hidden: number }).hidden).toBe(17);
  });

  it("reveals lines from the bottom of the gap and keeps the rest hidden", () => {
    const rows = buildRows({ ...base, expansion: { 0: { top: 0, bottom: 4 } } });
    const kinds = rows.slice(0, 6).map((r) => r.kind);
    expect(kinds).toEqual(["expander", "line", "line", "line", "line", "hunk"]);
    const revealed = rows.slice(1, 5) as LineRow[];
    expect(revealed.map((r) => r.newLine)).toEqual([7, 8, 9, 10]);
    expect(revealed.map((r) => r.content)).toEqual(["line 7", "line 8", "line 9", "line 10"]);
    expect(revealed.every((r) => r.source === "expanded" && r.type === "context")).toBe(true);
  });

  it("reveals lines from the top of the gap", () => {
    const rows = buildRows({ ...base, expansion: { 0: { top: 3, bottom: 0 } } });
    const revealed = rows.slice(0, 3) as LineRow[];
    expect(revealed.map((r) => r.newLine)).toEqual([1, 2, 3]);
    expect(rows[3]?.kind).toBe("expander");
    expect((rows[3] as { hidden: number }).hidden).toBe(7);
  });

  it("drops the expander once the gap is fully open", () => {
    const rows = buildRows({ ...base, expansion: { 0: { top: 10, bottom: 0 } } });
    expect(rows.slice(0, 10).every((r) => r.kind === "line")).toBe(true);
    expect(rows[10]?.kind).toBe("hunk");
  });

  it("drops expanders when no file content is available", () => {
    const rows = buildRows({ ...base, linesOld: null, linesNew: null });
    expect(rows.some((r) => r.kind === "expander")).toBe(false);
  });

  it("keeps old and new numbers apart after an earlier hunk", () => {
    // The first hunk adds two lines; after that the numbers run two apart.
    const first: DiffHunk = {
      oldStart: 5,
      oldLines: 1,
      newStart: 5,
      newLines: 3,
      section: "",
      lines: [
        line("context", "line 5", 5, 5),
        line("add", "extra a", null, 6),
        line("add", "extra b", null, 7),
      ],
    };
    const second: DiffHunk = {
      oldStart: 20,
      oldLines: 1,
      newStart: 22,
      newLines: 1,
      section: "",
      lines: [line("context", "line 20", 20, 22)],
    };

    const rows = buildRows({
      hunks: [first, second],
      oldLineCount: 30,
      newLineCount: 32,
      linesOld: fileLines(30),
      linesNew: fileLines(32),
      // Gap 1 sits between the two hunks: old 6..19, new 8..21.
      expansion: { 1: { top: 2, bottom: 2 } },
    });

    const revealed = rows.filter((r): r is LineRow => r.kind === "line" && r.source === "expanded");
    expect(revealed.map((r) => [r.oldLine, r.newLine])).toEqual([
      [6, 8],
      [7, 9],
      [18, 20],
      [19, 21],
    ]);
  });
});

describe("toSplitRows", () => {
  it("pairs del and add blocks positionally", () => {
    const rows = buildRows(base).filter((r) => r.kind !== "expander");
    const split = toSplitRows(rows);
    expect(split[0]?.kind).toBe("hunk");
    const pairs = split.filter((r) => r.kind === "pair");
    expect(pairs).toHaveLength(3);
    expect(pairs[1]).toMatchObject({
      left: { type: "del", content: "before" },
      right: { type: "add", content: "after" },
    });
  });

  it("pads with empty sides for unequal blocks", () => {
    const rows: Row[] = [
      { kind: "line", source: "hunk", type: "del", content: "a", oldLine: 1, newLine: null, hunkIndex: 0, lineIndex: 0 },
      { kind: "line", source: "hunk", type: "add", content: "b", oldLine: null, newLine: 1, hunkIndex: 0, lineIndex: 1 },
      { kind: "line", source: "hunk", type: "add", content: "c", oldLine: null, newLine: 2, hunkIndex: 0, lineIndex: 2 },
    ];
    const split = toSplitRows(rows);
    expect(split).toHaveLength(2);
    expect(split[1]).toMatchObject({ left: null, right: { content: "c" } });
  });

  it("puts a context line on both sides", () => {
    const rows: Row[] = [
      { kind: "line", source: "hunk", type: "context", content: "x", oldLine: 3, newLine: 3, hunkIndex: 0, lineIndex: 0 },
    ];
    const [pair] = toSplitRows(rows);
    expect(pair).toMatchObject({ kind: "pair", left: { content: "x" }, right: { content: "x" } });
  });
});

describe("expand", () => {
  it("steps ten lines at a time", () => {
    expect(expand(undefined, 25, "bottom")).toEqual({ top: 0, bottom: 10 });
    expect(expand({ top: 0, bottom: 10 }, 25, "bottom")).toEqual({ top: 0, bottom: 20 });
  });

  it("never goes past what is hidden", () => {
    expect(expand({ top: 0, bottom: 20 }, 25, "bottom")).toEqual({ top: 0, bottom: 25 });
    expect(expand({ top: 0, bottom: 25 }, 25, "top")).toEqual({ top: 0, bottom: 25 });
  });

  it("opens the whole gap at once", () => {
    expect(expand({ top: 2, bottom: 3 }, 40, "all")).toEqual({ top: 40, bottom: 0 });
  });
});
