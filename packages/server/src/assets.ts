import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_WEB_ASSETS } from "./generated/web-assets.js";

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

/** Whether this build carries the web UI inside it (a released binary does). */
const embedded = Object.keys(EMBEDDED_WEB_ASSETS).length > 0;

/**
 * Finds the built web assets on disk. In the monorepo they sit next to this package;
 * in a published install they live inside the package itself. `REVIEWGATE_WEB_DIST`
 * overrides both, which is handy during development.
 *
 * A released binary has no dist directory at all and answers from the embedded copy,
 * so this returning null is not by itself a missing UI — ask `hasWebAssets()`.
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

/** Whether the UI can be served at all, from the binary or from disk. */
export async function hasWebAssets(): Promise<boolean> {
  if (embedded) return true;
  return (await findWebDist()) !== null;
}

/**
 * Reads one asset by its path inside the web build, e.g. `index.html` or
 * `assets/index-abc123.js`. The embedded copy wins: a released binary must not start
 * serving whatever happens to lie next to it.
 */
export async function loadAsset(urlPath: string): Promise<Asset | null> {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, "");

  const inline = EMBEDDED_WEB_ASSETS[rel];
  if (inline !== undefined) {
    const buf = Buffer.from(inline, "base64");
    const body = new Uint8Array(buf.byteLength);
    body.set(buf);
    return { body, contentType: contentTypeFor(rel) };
  }
  if (embedded) return null;

  const dist = await findWebDist();
  if (!dist) return null;
  return readAsset(dist, rel);
}

/**
 * Reads an asset from a dist directory, but never outside it: the path from the
 * request is resolved and then checked, so `../` can reach nothing.
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
    return { body, contentType: contentTypeFor(abs) };
  } catch {
    return null;
  }
}

function contentTypeFor(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
