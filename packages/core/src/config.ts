import fs from "node:fs/promises";
import path from "node:path";

/**
 * `.reviewgate.json` in the repo root (§13, M6). Everything is optional; whatever is
 * missing gets the default below.
 */
export interface ReviewGateConfig {
  /** How long the hook blocks at most, in milliseconds. */
  timeoutMs: number;
  /** Diffs smaller than this many changed lines go through unreviewed. 0 = off. */
  minLines: number;
  /** Paths that do not count towards the review scope. */
  ignore: string[];
  /** Open the browser automatically. */
  autoOpen: boolean;
  /** Run the automatic first pass (§9). */
  autoReview: boolean;
  /** Bounds on the number of suggestions (§9). */
  autoReviewCap: { perLines: number; min: number; max: number };
  /** Thresholds for duplicate detection (§9). */
  dedupe: { overlapping: number; anywhere: number };
  theme: "system" | "light" | "dark";
}

export const DEFAULT_CONFIG: ReviewGateConfig = {
  timeoutMs: 55 * 60 * 1000,
  minLines: 0,
  // Lockfiles and build output say nothing about the change itself.
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
 * Reads the config from the repo root. A missing or broken file yields the defaults:
 * a mistake in the configuration must not block the work, at most keep it from being
 * reviewed the way it was meant to be (§11).
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
 * `autoReview` may be a boolean (on/off) as well as an object with the bounds. That
 * way you need no separate block just to change the cap.
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
  // `autoReview: { ... }` simply means "on" as well.
  if (typeof value === "object" && value !== null) return true;
  return fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length > 0 || value.length === 0 ? out : fallback;
}

/**
 * Matches a repo-relative POSIX path against a pattern.
 *
 * Small and predictable instead of a full glob library: `**` stands for any number of
 * path segments, `*` stays within one segment, `?` is a single character. A pattern
 * without a slash also matches on just the file name, so `pnpm-lock.yaml` works
 * wherever the file sits.
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
        // `**/` may also be zero segments, so `**/*.min.js` works in the root too.
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
