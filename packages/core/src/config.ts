import fs from "node:fs/promises";
import path from "node:path";

/**
 * `.reviewgate.json` in de repo-root (§13, M6). Alles is optioneel; wat ontbreekt
 * krijgt de standaardwaarde hieronder.
 */
export interface ReviewGateConfig {
  /** Hoe lang de hook maximaal blokkeert, in milliseconden. */
  timeoutMs: number;
  /** Diffs kleiner dan dit aantal gewijzigde regels gaan zonder review door. 0 = uit. */
  minLines: number;
  /** Paden die niet meetellen voor de review-scope. */
  ignore: string[];
  /** Browser automatisch openen. */
  autoOpen: boolean;
  /** De automatische eerste pass draaien (§9). */
  autoReview: boolean;
  /** Grenzen aan het aantal voorstellen (§9). */
  autoReviewCap: { perLines: number; min: number; max: number };
  /** Drempels voor duplicaatdetectie (§9). */
  dedupe: { overlapping: number; anywhere: number };
  theme: "system" | "light" | "dark";
}

export const DEFAULT_CONFIG: ReviewGateConfig = {
  timeoutMs: 55 * 60 * 1000,
  minLines: 0,
  // Lockfiles en buildoutput zeggen niets over de wijziging zelf.
  ignore: [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "composer.lock",
    "dist/**",
    "build/**",
    "**/*.min.js",
    "**/*.min.css",
  ],
  autoOpen: true,
  autoReview: true,
  autoReviewCap: { perLines: 25, min: 2, max: 20 },
  dedupe: { overlapping: 0.6, anywhere: 0.8 },
  theme: "system",
};

export const CONFIG_FILENAME = ".reviewgate.json";

/**
 * Leest de config uit de repo-root. Een ontbrekend of kapot bestand levert de
 * standaardwaarden op: een fout in de configuratie mag het werk niet blokkeren,
 * hoogstens niet reviewen zoals bedoeld (§11).
 */
export async function loadConfig(repoRoot: string): Promise<ReviewGateConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(repoRoot, CONFIG_FILENAME), "utf8");
  } catch {
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_CONFIG;
  }
  return mergeConfig(parsed);
}

export function mergeConfig(parsed: unknown): ReviewGateConfig {
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_CONFIG;
  const c = parsed as Record<string, unknown>;

  return {
    timeoutMs: positiveNumber(c["timeoutMs"], DEFAULT_CONFIG.timeoutMs),
    minLines: nonNegativeNumber(c["minLines"], DEFAULT_CONFIG.minLines),
    ignore: stringArray(c["ignore"], DEFAULT_CONFIG.ignore),
    autoOpen: boolean(c["autoOpen"], DEFAULT_CONFIG.autoOpen),
    autoReview: boolean(c["autoReview"], DEFAULT_CONFIG.autoReview),
    autoReviewCap: {
      perLines: positiveNumber(
        nested(c["autoReview"], c["autoReviewCap"], "perLines"),
        DEFAULT_CONFIG.autoReviewCap.perLines,
      ),
      min: nonNegativeNumber(
        nested(c["autoReview"], c["autoReviewCap"], "min"),
        DEFAULT_CONFIG.autoReviewCap.min,
      ),
      max: positiveNumber(
        nested(c["autoReview"], c["autoReviewCap"], "max"),
        DEFAULT_CONFIG.autoReviewCap.max,
      ),
    },
    dedupe: {
      overlapping: ratio(
        (c["dedupe"] as Record<string, unknown> | undefined)?.["overlapping"],
        DEFAULT_CONFIG.dedupe.overlapping,
      ),
      anywhere: ratio(
        (c["dedupe"] as Record<string, unknown> | undefined)?.["anywhere"],
        DEFAULT_CONFIG.dedupe.anywhere,
      ),
    },
    theme:
      c["theme"] === "light" || c["theme"] === "dark" || c["theme"] === "system"
        ? c["theme"]
        : DEFAULT_CONFIG.theme,
  };
}

/**
 * `autoReview` mag zowel een boolean zijn (aan/uit) als een object met de grenzen.
 * Zo hoef je voor alleen een andere cap geen apart blok bij te houden.
 */
function nested(autoReview: unknown, cap: unknown, key: string): unknown {
  const fromCap = (cap as Record<string, unknown> | undefined)?.[key];
  if (fromCap !== undefined) return fromCap;
  if (typeof autoReview === "object" && autoReview !== null) {
    return (autoReview as Record<string, unknown>)[key];
  }
  return undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function ratio(value: unknown, fallback: number): number {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  // `autoReview: { ... }` betekent ook gewoon "aan".
  if (typeof value === "object" && value !== null) return true;
  return fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length > 0 || value.length === 0 ? out : fallback;
}

/**
 * Matcht een repo-relatief POSIX-pad tegen een patroon.
 *
 * Klein en voorspelbaar in plaats van een volledige glob-bibliotheek: `**` staat
 * voor elk aantal padsegmenten, `*` blijft binnen één segment, `?` is één teken.
 * Een patroon zonder slash matcht ook op alleen de bestandsnaam, zodat
 * `pnpm-lock.yaml` werkt waar het bestand ook staat.
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  if (pattern === "") return false;
  if (toRegex(pattern).test(filePath)) return true;
  if (!pattern.includes("/")) {
    const base = filePath.split("/").pop() ?? filePath;
    return toRegex(pattern).test(base);
  }
  return false;
}

const regexCache = new Map<string, RegExp>();

function toRegex(pattern: string): RegExp {
  const known = regexCache.get(pattern);
  if (known) return known;

  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` mag ook nul segmenten zijn, zodat `**/*.min.js` ook in de root werkt.
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  out += "$";

  const regex = new RegExp(out);
  regexCache.set(pattern, regex);
  return regex;
}

export function isIgnored(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(filePath, p));
}
