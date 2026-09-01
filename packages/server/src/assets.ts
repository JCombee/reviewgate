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
 * Zoekt de gebouwde web-assets. In de monorepo staan die naast dit package; in een
 * gepubliceerde install liggen ze in de package zelf. `REVIEWGATE_WEB_DIST`
 * overschrijft beide, wat handig is tijdens ontwikkeling.
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
  /** Losse kopie op een gewone ArrayBuffer, zodat Hono's body() hem accepteert. */
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
}

/**
 * Leest een asset, maar nooit buiten de dist-directory: het pad uit de request
 * wordt opgelost en daarna gecontroleerd, zodat `../` niets kan bereiken.
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
