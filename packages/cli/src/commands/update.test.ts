import { describe, expect, it } from "vitest";
import { assetName, isNewer } from "./update.js";

describe("isNewer", () => {
  it("compares numerically, not lexicographically", () => {
    expect(isNewer("v0.10.0", "v0.9.0")).toBe(true);
    expect(isNewer("v0.9.0", "v0.10.0")).toBe(false);
  });

  it("ignores a missing v and trailing parts", () => {
    expect(isNewer("0.2.0", "v0.1.9")).toBe(true);
    expect(isNewer("v0.2", "v0.2.0")).toBe(false);
  });

  it("is false for the same version", () => {
    expect(isNewer("v1.2.3", "v1.2.3")).toBe(false);
  });

  it("treats a build from source as behind every release", () => {
    expect(isNewer("v0.1.0", "0.0.0-dev")).toBe(true);
  });
});

describe("assetName", () => {
  it("names the asset per platform", () => {
    expect(assetName("darwin", "arm64")).toBe("reviewgate-darwin-arm64");
    expect(assetName("linux", "x64")).toBe("reviewgate-linux-x64");
    expect(assetName("win32", "x64")).toBe("reviewgate-win32-x64.exe");
  });

  it("falls back to x64 for an architecture we do not publish", () => {
    expect(assetName("linux", "ppc64")).toBe("reviewgate-linux-x64");
  });
});
