import fs from "node:fs/promises";
import path from "node:path";
import { TestRepo, type LatestTag } from "@reviewgate/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateCheckPath, writeUpdateCheckCache } from "./lockfile.js";
import { checkForUpdate } from "./updateCheck.js";

let repo: TestRepo;
let gitDir: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  gitDir = path.join(repo.root, ".git");
});

afterEach(async () => {
  await repo.cleanup();
});

/** A fake `latestTag()` lookup that counts how many times it was invoked. */
function fakeLookup(tag: LatestTag, calls: { count: number }): () => Promise<LatestTag> {
  return async () => {
    calls.count++;
    return tag;
  };
}

function localDateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("checkForUpdate", () => {
  it("calls the lookup once and writes a cache file when none exists", async () => {
    const calls = { count: 0 };
    const result = await checkForUpdate(
      gitDir,
      "v1.0.0",
      fakeLookup({ tag: "v1.2.0", reason: "ok" }, calls),
    );

    expect(calls.count).toBe(1);
    expect(result).toEqual({ current: "v1.0.0", latest: "v1.2.0", updateAvailable: true });

    const raw = await fs.readFile(updateCheckPath(gitDir), "utf8");
    const parsed = JSON.parse(raw) as { date: string; latest: string | null; updateAvailable: boolean };
    expect(parsed.latest).toBe("v1.2.0");
    expect(parsed.updateAvailable).toBe(true);
    expect(parsed.date).toBe(localDateStamp(new Date()));
  });

  it("returns the cached verdict without calling the lookup again when the cache is dated today", async () => {
    await writeUpdateCheckCache(gitDir, {
      date: localDateStamp(new Date()),
      latest: "v1.2.0",
      updateAvailable: true,
    });

    const calls = { count: 0 };
    const result = await checkForUpdate(
      gitDir,
      "v1.0.0",
      fakeLookup({ tag: "v9.9.9", reason: "ok" }, calls),
    );

    expect(calls.count).toBe(0);
    expect(result).toEqual({ current: "v1.0.0", latest: "v1.2.0", updateAvailable: true });
  });

  it("performs a fresh check and overwrites the cache when it is dated a prior calendar day", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await writeUpdateCheckCache(gitDir, {
      date: localDateStamp(yesterday),
      latest: "v1.0.0",
      updateAvailable: false,
    });

    const calls = { count: 0 };
    const result = await checkForUpdate(
      gitDir,
      "v1.0.0",
      fakeLookup({ tag: "v1.5.0", reason: "ok" }, calls),
    );

    expect(calls.count).toBe(1);
    expect(result).toEqual({ current: "v1.0.0", latest: "v1.5.0", updateAvailable: true });

    const raw = await fs.readFile(updateCheckPath(gitDir), "utf8");
    const parsed = JSON.parse(raw) as { date: string };
    // A calendar-day rule, not a rolling window: "yesterday" (even a few minutes ago,
    // around a local midnight) is enough to force a fresh check.
    expect(parsed.date).toBe(localDateStamp(new Date()));
  });

  it("caches a failed/unreachable check so a second call the same day does not retry", async () => {
    const calls = { count: 0 };
    const first = await checkForUpdate(
      gitDir,
      "v1.0.0",
      fakeLookup({ tag: null, reason: "unreachable" }, calls),
    );
    expect(first).toEqual({ current: "v1.0.0", latest: null, updateAvailable: false });
    expect(calls.count).toBe(1);

    const second = await checkForUpdate(
      gitDir,
      "v1.0.0",
      fakeLookup({ tag: "v9.9.9", reason: "ok" }, calls),
    );
    expect(second).toEqual({ current: "v1.0.0", latest: null, updateAvailable: false });
    // The second lookup is never invoked: the failure from the first call was cached.
    expect(calls.count).toBe(1);
  });

  it("treats a corrupt (invalid JSON) cache file the same as no cache", async () => {
    await fs.mkdir(path.dirname(updateCheckPath(gitDir)), { recursive: true });
    await fs.writeFile(updateCheckPath(gitDir), "{ not valid json", "utf8");

    const calls = { count: 0 };
    const result = await checkForUpdate(
      gitDir,
      "v1.0.0",
      fakeLookup({ tag: "v2.0.0", reason: "ok" }, calls),
    );

    expect(calls.count).toBe(1);
    expect(result).toEqual({ current: "v1.0.0", latest: "v2.0.0", updateAvailable: true });

    const raw = await fs.readFile(updateCheckPath(gitDir), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("treats a valid-JSON cache file missing the expected fields as no cache", async () => {
    await fs.mkdir(path.dirname(updateCheckPath(gitDir)), { recursive: true });
    await fs.writeFile(updateCheckPath(gitDir), JSON.stringify({ foo: "bar" }), "utf8");

    const calls = { count: 0 };
    const result = await checkForUpdate(
      gitDir,
      "v1.0.0",
      fakeLookup({ tag: "v2.0.0", reason: "ok" }, calls),
    );

    expect(calls.count).toBe(1);
    expect(result.latest).toBe("v2.0.0");
  });

  it("creates the state directory on first run", async () => {
    await expect(fs.access(path.dirname(updateCheckPath(gitDir)))).rejects.toThrow();

    await checkForUpdate(gitDir, "v1.0.0", fakeLookup({ tag: "v2.0.0", reason: "ok" }, { count: 0 }));

    await expect(fs.access(path.dirname(updateCheckPath(gitDir)))).resolves.toBeUndefined();
  });

  it("does not crash on concurrent calls before any cache exists (a race may call the lookup more than once)", async () => {
    const calls = { count: 0 };
    const lookup = fakeLookup({ tag: "v3.0.0", reason: "ok" }, calls);

    const [a, b] = await Promise.all([
      checkForUpdate(gitDir, "v1.0.0", lookup),
      checkForUpdate(gitDir, "v1.0.0", lookup),
    ]);

    expect(a).toEqual({ current: "v1.0.0", latest: "v3.0.0", updateAvailable: true });
    expect(b).toEqual({ current: "v1.0.0", latest: "v3.0.0", updateAvailable: true });
    expect(calls.count).toBeGreaterThanOrEqual(1);
  });
});
