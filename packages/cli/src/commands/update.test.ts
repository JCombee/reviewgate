import { describe, expect, it } from "vitest";
import { assetName } from "./update.js";

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
