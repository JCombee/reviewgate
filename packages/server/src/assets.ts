import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Finds the built web assets. In the monorepo they sit next to this package; in a
 * published install they live inside the package itself. `REVIEWGATE_WEB_DIST`
 * overrides both, which is handy during development.
 */
export async function findWebDist(): Promise<string | null> {
  const fromEnv = process.env["REVIEWGATE_WEB_DIST"];
  if (fromEnv) return (await isDir(fromEnv)) ? path.resolve(fromEnv) : null;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../web/dist"),
    path.resolve(here, "../web/dist"),
    path.resolve(here, "../../../web/dist"),
  ];
  for (const c of candidates) if (await isDir(c)) return c;
  return null;
}

export interface Asset {
  /** A separate copy on an ordinary ArrayBuffer, so Hono's body() accepts it. */
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
}

/**
 * Reads an asset, but never outside the dist directory: the path from the request is
 * resolved and then checked, so `../` can reach nothing.
 */
export async function readAsset(dist: string, urlPath: string): Promise<Asset | null> {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const abs = path.resolve(dist, rel);
  const within = abs === dist || abs.startsWith(dist + path.sep);
  if (!within) return null;

  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
    const buf = await fs.readFile(abs);
    const body = new Uint8Array(buf.byteLength);
    body.set(buf);
    return {
      body,
      contentType: MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
