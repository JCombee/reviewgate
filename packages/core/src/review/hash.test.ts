import { describe, expect, it } from "vitest";
import { diffHash, normalizePatch } from "./hash.js";

const patch = [
  "diff --git a/a.ts b/a.ts",
  "index 83db48f..bf269f4 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-oud",
  "+nieuw",
  "",
].join("\n");

describe("diffHash", () => {
  it("is stabiel voor dezelfde patch", () => {
    expect(diffHash(patch)).toBe(diffHash(patch));
  });

  it("negeert de index-regel met blob-hashes", () => {
    const other = patch.replace("index 83db48f..bf269f4 100644", "index 1111111..2222222 100644");
    expect(diffHash(other)).toBe(diffHash(patch));
  });

  it("negeert CRLF en afsluitende lege regels", () => {
    expect(diffHash(patch.replace(/\n/g, "\r\n"))).toBe(diffHash(patch));
    expect(diffHash(`${patch}\n\n\n`)).toBe(diffHash(patch));
  });

  it("verandert wel bij andere inhoud", () => {
    expect(diffHash(patch.replace("+nieuw", "+anders"))).not.toBe(diffHash(patch));
  });

  it("haalt alleen index-regels weg, niet de rest", () => {
    expect(normalizePatch(patch).split("\n")).toEqual([
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-oud",
      "+nieuw",
    ]);
  });
});
