import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, isIgnored, matchesPattern, mergeConfig } from "./config.js";

describe("mergeConfig", () => {
  it("geeft de standaardwaarden bij een leeg of ongeldig bestand", () => {
    expect(mergeConfig({})).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig("nee")).toEqual(DEFAULT_CONFIG);
  });

  it("neemt losse waarden over en laat de rest staan", () => {
    const c = mergeConfig({ minLines: 20, theme: "dark" });
    expect(c.minLines).toBe(20);
    expect(c.theme).toBe("dark");
    expect(c.timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs);
  });

  it("negeert onzinnige waarden in plaats van ermee te gaan werken", () => {
    const c = mergeConfig({ timeoutMs: -5, minLines: "veel", theme: "paars" });
    expect(c.timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs);
    expect(c.minLines).toBe(DEFAULT_CONFIG.minLines);
    expect(c.theme).toBe("system");
  });

  it("accepteert een lege ignore-lijst als bewuste keuze", () => {
    expect(mergeConfig({ ignore: [] }).ignore).toEqual([]);
  });

  it("leest autoReview zowel als schakelaar als als object met grenzen", () => {
    expect(mergeConfig({ autoReview: false }).autoReview).toBe(false);

    const c = mergeConfig({ autoReview: { perLines: 50, max: 5 } });
    expect(c.autoReview).toBe(true);
    expect(c.autoReviewCap).toMatchObject({ perLines: 50, max: 5, min: 2 });
  });

  it("houdt dedupe-drempels binnen nul en één", () => {
    expect(mergeConfig({ dedupe: { overlapping: 0.4, anywhere: 9 } }).dedupe).toEqual({
      overlapping: 0.4,
      anywhere: DEFAULT_CONFIG.dedupe.anywhere,
    });
  });
});

describe("matchesPattern", () => {
  const cases: Array<[pattern: string, filePath: string, expected: boolean]> = [
    ["pnpm-lock.yaml", "pnpm-lock.yaml", true],
    // Een patroon zonder slash matcht ook diep in de boom.
    ["pnpm-lock.yaml", "apps/web/pnpm-lock.yaml", true],
    ["dist/**", "dist/index.js", true],
    ["dist/**", "dist/nested/deep/index.js", true],
    ["dist/**", "src/dist.ts", false],
    ["**/*.min.js", "public/js/app.min.js", true],
    ["**/*.min.js", "app.min.js", true],
    ["**/*.min.js", "app.js", false],
    ["src/*.ts", "src/index.ts", true],
    // Eén ster blijft binnen een segment.
    ["src/*.ts", "src/nested/index.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    // Punten in het patroon zijn letterlijk, geen wildcard.
    ["a.ts", "axts", false],
  ];

  for (const [pattern, filePath, expected] of cases) {
    it(`${pattern} ${expected ? "matcht" : "matcht niet"} ${filePath}`, () => {
      expect(matchesPattern(filePath, pattern)).toBe(expected);
    });
  }
});

describe("isIgnored", () => {
  it("negeert lockfiles en buildoutput met de standaardlijst", () => {
    expect(isIgnored("pnpm-lock.yaml", DEFAULT_CONFIG.ignore)).toBe(true);
    expect(isIgnored("dist/app.js", DEFAULT_CONFIG.ignore)).toBe(true);
    expect(isIgnored("src/app.ts", DEFAULT_CONFIG.ignore)).toBe(false);
  });

  it("negeert niets bij een lege lijst", () => {
    expect(isIgnored("pnpm-lock.yaml", [])).toBe(false);
  });
});
