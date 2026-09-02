import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, isIgnored, matchesPattern, mergeConfig } from "./config.js";

describe("mergeConfig", () => {
  it("yields the defaults for an empty or invalid file", () => {
    expect(mergeConfig({})).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig("no")).toEqual(DEFAULT_CONFIG);
  });

  it("takes over individual values and leaves the rest", () => {
    const c = mergeConfig({ minLines: 20, theme: "dark" });
    expect(c.minLines).toBe(20);
    expect(c.theme).toBe("dark");
    expect(c.timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs);
  });

  it("ignores nonsensical values rather than working with them", () => {
    const c = mergeConfig({ timeoutMs: -5, minLines: "lots", theme: "purple" });
    expect(c.timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs);
    expect(c.minLines).toBe(DEFAULT_CONFIG.minLines);
    expect(c.theme).toBe("system");
  });

  it("accepts an empty ignore list as a deliberate choice", () => {
    expect(mergeConfig({ ignore: [] }).ignore).toEqual([]);
  });

  it("reads autoReview both as a switch and as an object with bounds", () => {
    expect(mergeConfig({ autoReview: false }).autoReview).toBe(false);

    const c = mergeConfig({ autoReview: { perLines: 50, max: 5 } });
    expect(c.autoReview).toBe(true);
    expect(c.autoReviewCap).toMatchObject({ perLines: 50, max: 5, min: 2 });
  });

  it("keeps dedupe thresholds between zero and one", () => {
    expect(mergeConfig({ dedupe: { overlapping: 0.4, anywhere: 9 } }).dedupe).toEqual({
      overlapping: 0.4,
      anywhere: DEFAULT_CONFIG.dedupe.anywhere,
    });
  });
});

describe("matchesPattern", () => {
  const cases: Array<[pattern: string, filePath: string, expected: boolean]> = [
    ["pnpm-lock.yaml", "pnpm-lock.yaml", true],
    // A pattern without a slash matches deep in the tree as well.
    ["pnpm-lock.yaml", "apps/web/pnpm-lock.yaml", true],
    ["dist/**", "dist/index.js", true],
    ["dist/**", "dist/nested/deep/index.js", true],
    ["dist/**", "src/dist.ts", false],
    ["**/*.min.js", "public/js/app.min.js", true],
    ["**/*.min.js", "app.min.js", true],
    ["**/*.min.js", "app.js", false],
    ["src/*.ts", "src/index.ts", true],
    // A single star stays inside one segment.
    ["src/*.ts", "src/nested/index.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    // Dots in the pattern are literal, not a wildcard.
    ["a.ts", "axts", false],
  ];

  for (const [pattern, filePath, expected] of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${filePath}`, () => {
      expect(matchesPattern(filePath, pattern)).toBe(expected);
    });
  }
});

describe("isIgnored", () => {
  it("ignores lockfiles and build output with the default list", () => {
    expect(isIgnored("pnpm-lock.yaml", DEFAULT_CONFIG.ignore)).toBe(true);
    expect(isIgnored("dist/app.js", DEFAULT_CONFIG.ignore)).toBe(true);
    expect(isIgnored("src/app.ts", DEFAULT_CONFIG.ignore)).toBe(false);
  });

  it("ignores nothing with an empty list", () => {
    expect(isIgnored("pnpm-lock.yaml", [])).toBe(false);
  });
});
