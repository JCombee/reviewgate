import { describe, expect, it } from "vitest";
import { diffHash, normalizePatch } from "./hash.js";

const patch = [
  "diff --git a/a.ts b/a.ts",
  "index 83db48f..bf269f4 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "",
].join("\n");

describe("diffHash", () => {
  it("is stable for the same patch", () => {
    expect(diffHash(patch)).toBe(diffHash(patch));
  });

  it("ignores the index line with its blob hashes", () => {
    const other = patch.replace("index 83db48f..bf269f4 100644", "index 1111111..2222222 100644");
    expect(diffHash(other)).toBe(diffHash(patch));
  });

  it("ignores CRLF and trailing empty lines", () => {
    expect(diffHash(patch.replace(/\n/g, "\r\n"))).toBe(diffHash(patch));
    expect(diffHash(`${patch}\n\n\n`)).toBe(diffHash(patch));
  });

  it("does change when the content changes", () => {
    expect(diffHash(patch.replace("+after", "+something else"))).not.toBe(diffHash(patch));
  });

  it("strips index lines only, not the rest", () => {
    expect(normalizePatch(patch).split("\n")).toEqual([
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ]);
  });
});
