import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REPO, VERSION } from "@reviewgate/core";
import { UsageError } from "../args.js";

/**
 * `reviewgate update` — replaces this binary with the newest release.
 *
 * The same three steps the installer takes: resolve the latest tag, download the
 * asset for this platform, check its SHA-256. Only then does the running binary get
 * replaced, and never in place: the new file is written next to it and moved over the
 * old one, so a failed download leaves a working install behind.
 *
 * A build from source (`npm run build`) has no binary to replace and says so.
 */
export async function cmdUpdate(argv: readonly string[]): Promise<number> {
  let checkOnly = false;
  let wanted: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") checkOnly = true;
    else if (arg === "--version") {
      const next = argv[i + 1];
      if (!next) throw new UsageError("--version needs a tag, e.g. --version v0.2.0");
      wanted = next.startsWith("v") ? next : `v${next}`;
      i++;
    } else throw new UsageError(`unknown option "${arg}"`);
  }

  let tag = wanted;
  if (!tag) {
    const latest = await latestTag();
    if (latest.reason === "none") {
      process.stderr.write(`reviewgate: ${REPO} has no releases yet.\n`);
      return 1;
    }
    if (!latest.tag) {
      process.stderr.write(`reviewgate: could not reach the releases of ${REPO}.\n`);
      return 1;
    }
    tag = latest.tag;
  }

  const current = VERSION;
  if (!wanted && !isNewer(tag, current)) {
    process.stdout.write(`reviewgate ${current} is up to date.\n`);
    return 0;
  }

  process.stdout.write(`reviewgate ${current} -> ${tag}\n`);
  if (checkOnly) return 0;

  const target = await binaryPath();
  if (!target) {
    process.stderr.write(
      "reviewgate: this is a build from source, not an installed binary.\n" +
        "Update it with git pull && npm install && npm run build.\n",
    );
    return 1;
  }

  const asset = assetName();
  const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;

  process.stdout.write(`Downloading ${asset}...\n`);
  const [body, expected] = await Promise.all([download(url), downloadText(`${url}.sha256`)]);
  if (!body || expected === null) {
    process.stderr.write(`reviewgate: ${tag} has no ${asset}.\n`);
    return 1;
  }

  const actual = createHash("sha256").update(body).digest("hex");
  const want = expected.trim().split(/\s+/)[0] ?? "";
  if (actual !== want) {
    process.stderr.write(`reviewgate: checksum mismatch, refusing to install.\n`);
    return 1;
  }

  await replaceSelf(target, body);
  process.stdout.write(`reviewgate ${tag} installed at ${target}\n`);
  process.stdout.write("Restart Claude Code so the gate picks up the new version.\n");
  return 0;
}

export interface LatestTag {
  tag: string | null;
  /** `none` when the repo simply has no releases; that is not a failure to report as one. */
  reason: "ok" | "none" | "unreachable";
}

/** The newest non-prerelease tag on GitHub. */
export async function latestTag(): Promise<LatestTag> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "reviewgate" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { tag: null, reason: "none" };
    if (!res.ok) return { tag: null, reason: "unreachable" };
    const body = (await res.json()) as { tag_name?: unknown };
    if (typeof body.tag_name !== "string") return { tag: null, reason: "none" };
    return { tag: body.tag_name, reason: "ok" };
  } catch {
    return { tag: null, reason: "unreachable" };
  }
}

/** Compares vMAJOR.MINOR.PATCH tags; a build from source is always behind. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** The release asset for the platform this process runs on. */
export function assetName(platform = process.platform, arch = process.arch): string {
  const os_ = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  const cpu = arch === "arm64" ? "arm64" : "x64";
  return `reviewgate-${os_}-${cpu}${os_ === "win32" ? ".exe" : ""}`;
}

/**
 * The binary to replace, or null when this is not one.
 *
 * A compiled binary runs as itself (`process.execPath` is `.../reviewgate`); a build
 * from source runs under node or bun, whose executable must never be overwritten.
 */
async function binaryPath(): Promise<string | null> {
  const exec = process.execPath;
  const base = path.basename(exec).toLowerCase();
  if (base === "node" || base === "node.exe" || base === "bun" || base === "bun.exe") return null;
  try {
    await fs.access(exec);
    return exec;
  } catch {
    return null;
  }
}

async function download(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "reviewgate" } });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function downloadText(url: string): Promise<string | null> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "reviewgate" } });
  if (!res.ok) return null;
  return res.text();
}

/**
 * Windows refuses to overwrite a running executable but does allow renaming it, so
 * the old binary is moved aside first and cleaned up on the next run. On macOS and
 * Linux the rename over the old inode is enough.
 */
async function replaceSelf(target: string, body: Buffer): Promise<void> {
  const dir = path.dirname(target);
  const next = path.join(dir, `.${path.basename(target)}.new`);
  const old = path.join(dir, `.${path.basename(target)}.old`);

  await fs.writeFile(next, body, { mode: 0o755 });
  await fs.rm(old, { force: true });
  if (process.platform === "win32") {
    await fs.rename(target, old);
    try {
      await fs.rename(next, target);
    } catch (err) {
      await fs.rename(old, target);
      throw err;
    }
  } else {
    await fs.rename(next, target);
  }
}

/** Leftovers from an earlier Windows update; removed quietly on the next run. */
export async function sweepOldBinary(): Promise<void> {
  if (process.platform !== "win32") return;
  const exec = process.execPath;
  const old = path.join(path.dirname(exec), `.${path.basename(exec)}.old`);
  await fs.rm(old, { force: true }).catch(() => {});
  await fs.rm(path.join(os.tmpdir(), "reviewgate-update"), { force: true, recursive: true }).catch(() => {});
}
