import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasWebAssets, loadAsset, readAsset } from "./assets.js";

/**
 * Where the UI comes from (§4). A checkout must serve the dist it just built, or
 * `npm run build:web` changes nothing you can see and you end up debugging a UI that
 * was never shipped to the browser.
 */

const dirs: string[] = [];

afterEach(async () => {
  delete process.env["REVIEWGATE_WEB_DIST"];
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** A dist directory with one recognisable page in it. */
async function dist(body: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reviewgate-dist-"));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, "index.html"), body, "utf8");
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "assets", "app.js"), "export const x = 1;\n", "utf8");
  return dir;
}

const text = (body: Uint8Array): string => Buffer.from(body).toString("utf8");

describe("web assets", () => {
  it("serves the dist a source build points at", async () => {
    process.env["REVIEWGATE_WEB_DIST"] = await dist("<h1>from disk</h1>");

    const page = await loadAsset("index.html");
    expect(page).not.toBeNull();
    expect(text(page!.body)).toContain("from disk");
    expect(page!.contentType).toBe("text/html; charset=utf-8");
    expect(await hasWebAssets()).toBe(true);
  });

  /**
   * index.html names its script by content hash, so one file from the new build and
   * the next from the old one is a blank page, not a slightly stale one. Whichever
   * source answers, answers for everything.
   */
  it("does not fall back to the embedded copy for a file the dist lacks", async () => {
    process.env["REVIEWGATE_WEB_DIST"] = await dist("<h1>from disk</h1>");

    expect(await loadAsset("assets/index-fromtheembeddedbuild.js")).toBeNull();
  });

  it("reads nested assets and refuses to leave the dist", async () => {
    const dir = await dist("<h1>from disk</h1>");

    expect(text((await readAsset(dir, "assets/app.js"))!.body)).toContain("export const x");
    expect(await readAsset(dir, "../../../etc/passwd")).toBeNull();
    expect(await readAsset(dir, "assets/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });

  it("has nothing to serve when the directory it is pointed at is gone", async () => {
    process.env["REVIEWGATE_WEB_DIST"] = path.join(os.tmpdir(), "reviewgate-dist-absent");

    expect(await loadAsset("index.html")).toBeNull();
    expect(await hasWebAssets()).toBe(false);
  });
});
