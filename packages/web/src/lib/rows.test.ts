import type { DiffHunk } from "@reviewgate/core/api";
import { describe, expect, it } from "vitest";
import { buildRows, computeGaps, expand, toSplitRows, type LineRow, type Row } from "./rows.js";

const line = (
  type: "context" | "add" | "del",
  content: string,
  oldLine: number | null,
  newLine: number | null,
) => ({ type, content, oldLine, newLine, noNewlineAtEof: false });

/** Bestand van 30 regels met één hunk rond regel 11. */
const hunk: DiffHunk = {
  oldStart: 11,
  oldLines: 3,
  newStart: 11,
  newLines: 3,
  section: "function f()",
  lines: [
    line("context", "regel 11", 11, 11),
    line("del", "oud", 12, null),
    line("add", "nieuw", null, 12),
    line("context", "regel 13", 13, 13),
  ],
};

const fileLines = (n: number, prefix = "regel ") =>
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
  it("vindt het gat vóór en na de hunk", () => {
    const gaps = computeGaps({ hunks: [hunk], oldLineCount: 30, newLineCount: 30 });
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({ index: 0, oldStart: 1, oldEnd: 10, hidden: 10, hasAbove: false });
    expect(gaps[1]).toMatchObject({ index: 1, oldStart: 14, oldEnd: 30, hidden: 17, hasBelow: false });
  });

  it("telt een hunk zonder oude regels niet mee aan de oude kant", () => {
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

  it("geeft geen gat als de hunk het hele bestand beslaat", () => {
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
  it("toont per gat een expander en de regels van de hunk", () => {
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

  it("onthult regels vanaf de onderkant van het gat en houdt de rest verborgen", () => {
    const rows = buildRows({ ...base, expansion: { 0: { top: 0, bottom: 4 } } });
    const kinds = rows.slice(0, 6).map((r) => r.kind);
    expect(kinds).toEqual(["expander", "line", "line", "line", "line", "hunk"]);
    const revealed = rows.slice(1, 5) as LineRow[];
    expect(revealed.map((r) => r.newLine)).toEqual([7, 8, 9, 10]);
    expect(revealed.map((r) => r.content)).toEqual(["regel 7", "regel 8", "regel 9", "regel 10"]);
    expect(revealed.every((r) => r.source === "expanded" && r.type === "context")).toBe(true);
  });

  it("onthult regels vanaf de bovenkant van het gat", () => {
    const rows = buildRows({ ...base, expansion: { 0: { top: 3, bottom: 0 } } });
    const revealed = rows.slice(0, 3) as LineRow[];
    expect(revealed.map((r) => r.newLine)).toEqual([1, 2, 3]);
    expect(rows[3]?.kind).toBe("expander");
    expect((rows[3] as { hidden: number }).hidden).toBe(7);
  });

  it("laat de expander weg zodra het gat volledig open staat", () => {
    const rows = buildRows({ ...base, expansion: { 0: { top: 10, bottom: 0 } } });
    expect(rows.slice(0, 10).every((r) => r.kind === "line")).toBe(true);
    expect(rows[10]?.kind).toBe("hunk");
  });

  it("laat expanders weg als er geen bestandsinhoud beschikbaar is", () => {
    const rows = buildRows({ ...base, linesOld: null, linesNew: null });
    expect(rows.some((r) => r.kind === "expander")).toBe(false);
  });

  it("houdt oude en nieuwe nummers uit elkaar na een eerdere hunk", () => {
    // De eerste hunk voegt twee regels toe; daarna lopen de nummers twee uit elkaar.
    const first: DiffHunk = {
      oldStart: 5,
      oldLines: 1,
      newStart: 5,
      newLines: 3,
      section: "",
      lines: [
        line("context", "regel 5", 5, 5),
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
      lines: [line("context", "regel 20", 20, 22)],
    };

    const rows = buildRows({
      hunks: [first, second],
      oldLineCount: 30,
      newLineCount: 32,
      linesOld: fileLines(30),
      linesNew: fileLines(32),
      // Gat 1 ligt tussen de twee hunks: oud 6..19, nieuw 8..21.
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
  it("koppelt del- en add-blokken positioneel", () => {
    const rows = buildRows(base).filter((r) => r.kind !== "expander");
    const split = toSplitRows(rows);
    expect(split[0]?.kind).toBe("hunk");
    const pairs = split.filter((r) => r.kind === "pair");
    expect(pairs).toHaveLength(3);
    expect(pairs[1]).toMatchObject({
      left: { type: "del", content: "oud" },
      right: { type: "add", content: "nieuw" },
    });
  });

  it("vult aan met lege kanten bij ongelijke blokken", () => {
    const rows: Row[] = [
      { kind: "line", source: "hunk", type: "del", content: "a", oldLine: 1, newLine: null, hunkIndex: 0, lineIndex: 0 },
      { kind: "line", source: "hunk", type: "add", content: "b", oldLine: null, newLine: 1, hunkIndex: 0, lineIndex: 1 },
      { kind: "line", source: "hunk", type: "add", content: "c", oldLine: null, newLine: 2, hunkIndex: 0, lineIndex: 2 },
    ];
    const split = toSplitRows(rows);
    expect(split).toHaveLength(2);
    expect(split[1]).toMatchObject({ left: null, right: { content: "c" } });
  });

  it("zet een contextregel aan beide kanten neer", () => {
    const rows: Row[] = [
      { kind: "line", source: "hunk", type: "context", content: "x", oldLine: 3, newLine: 3, hunkIndex: 0, lineIndex: 0 },
    ];
    const [pair] = toSplitRows(rows);
    expect(pair).toMatchObject({ kind: "pair", left: { content: "x" }, right: { content: "x" } });
  });
});

describe("expand", () => {
  it("stapt met tien regels tegelijk", () => {
    expect(expand(undefined, 25, "bottom")).toEqual({ top: 0, bottom: 10 });
    expect(expand({ top: 0, bottom: 10 }, 25, "bottom")).toEqual({ top: 0, bottom: 20 });
  });

  it("gaat nooit voorbij wat er verborgen is", () => {
    expect(expand({ top: 0, bottom: 20 }, 25, "bottom")).toEqual({ top: 0, bottom: 25 });
    expect(expand({ top: 0, bottom: 25 }, 25, "top")).toEqual({ top: 0, bottom: 25 });
  });

  it("opent het hele gat in één keer", () => {
    expect(expand({ top: 2, bottom: 3 }, 40, "all")).toEqual({ top: 40, bottom: 0 });
  });
});
