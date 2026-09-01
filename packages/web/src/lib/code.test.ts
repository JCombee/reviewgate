import type { HighlightLine, PaletteEntry } from "@reviewgate/core/api";
import { describe, expect, it } from "vitest";
import { linesFromTokens, toPieces } from "./code.js";

/** Palet zoals de server het meestuurt: [licht, donker] per index. */
const palette: PaletteEntry[] = [
  ["#333", "#ccc"],
  ["#00f", "#88f"],
  ["#e50", "#fa6"],
];

const tok = (t: string, c = 0) => ({ t, c });

describe("toPieces", () => {
  it("valt terug op platte tekst zonder tokens", () => {
    expect(toPieces("const a = 1;", null, palette)).toEqual([
      { text: "const a = 1;", light: "", dark: "", changed: false },
    ]);
  });

  it("zoekt de kleuren op in het palet", () => {
    const tokens: HighlightLine = [tok("const", 1), tok(" a", 0)];
    const pieces = toPieces("const a", tokens, palette);
    expect(pieces.map((p) => [p.text, p.light, p.dark, p.changed])).toEqual([
      ["const", "#00f", "#88f", false],
      [" a", "#333", "#ccc", false],
    ]);
  });

  it("geeft lege kleuren bij een onbekende palet-index", () => {
    const pieces = toPieces("x", [tok("x", 99)], palette);
    expect(pieces[0]).toMatchObject({ light: "", dark: "" });
  });

  it("knipt een token op de segmentgrens", () => {
    // "const a = 22;" met alleen "22" gewijzigd, terwijl shiki "22;" als één token ziet.
    const tokens: HighlightLine = [tok("const a = ", 0), tok("22;", 2)];
    const pieces = toPieces("const a = 22;", tokens, palette, [{ start: 10, end: 12 }]);
    expect(pieces.map((p) => [p.text, p.changed])).toEqual([
      ["const a = ", false],
      ["22", true],
      [";", false],
    ]);
    expect(pieces[1]?.light).toBe("#e50");
  });

  it("markeert een segment dat meerdere tokens beslaat", () => {
    const tokens: HighlightLine = [tok("foo"), tok("("), tok("a"), tok(")")];
    const pieces = toPieces("foo(a)", tokens, palette, [{ start: 3, end: 6 }]);
    expect(pieces.map((p) => [p.text, p.changed])).toEqual([
      ["foo", false],
      ["(", true],
      ["a", true],
      [")", true],
    ]);
  });

  it("werkt ook zonder tokens", () => {
    const pieces = toPieces("abcdef", null, palette, [{ start: 2, end: 4 }]);
    expect(pieces.map((p) => [p.text, p.changed])).toEqual([
      ["ab", false],
      ["cd", true],
      ["ef", false],
    ]);
  });

  it("laat lege stukken weg", () => {
    const tokens: HighlightLine = [tok(""), tok("x")];
    expect(toPieces("x", tokens, palette)).toHaveLength(1);
  });
});

describe("linesFromTokens", () => {
  it("plakt de tokens per regel weer aan elkaar", () => {
    const lines: HighlightLine[] = [[tok("const "), tok("a")], [tok("")], [tok("b")]];
    expect(linesFromTokens(lines)).toEqual(["const a", "", "b"]);
  });

  it("geeft null door", () => {
    expect(linesFromTokens(null)).toBeNull();
  });
});
