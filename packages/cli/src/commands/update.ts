import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isNewer, latestTag, REPO, VERSION } from "@reviewgate/core";
import { ClaudePathInvalid, resolveClaudePath } from "@reviewgate/server";
import { UsageError } from "../args.js";

const execFileAsync = promisify(execFile);

/**
 * `reviewgate update` — replaces this binary with the newest release, then makes sure
 * the Claude Code plugin is current too.
 *
 * The same three steps the installer takes for the binary: resolve the latest tag,
 * download the asset for this platform, check its SHA-256. Only then does the running
 * binary get replaced, and never in place: the new file is written next to it and
 * moved over the old one, so a failed download leaves a working install behind.
 *
 * A build from source (`npm run build`) has no binary to replace and says so.
 *
 * The plugin is a separate thing, managed by Claude Code rather than by this binary,
 * so it is updated best-effort: a missing `claude` or a failed plugin command is
 * reported and does not turn a successful binary update into a failure.
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
  const binaryUpToDate = !wanted && !isNewer(tag, current);
  if (binaryUpToDate) process.stdout.write(`reviewgate ${current} is up to date.\n`);
  else process.stdout.write(`reviewgate ${current} -> ${tag}\n`);
  if (checkOnly) return 0;

  if (!binaryUpToDate) {
    const target = await binaryPath();
    if (!target) {
      process.stderr.write(
        "reviewgate: this is a build from source, not an installed binary.\n" +
          "Update it with git pull && npm install && npm run build.\n",
      );
      await updatePlugin();
      return 1;
    }

    const asset = assetName();
    const source = await assetSource(tag, asset, wanted);

    process.stdout.write(`Downloading ${asset}...\n`);
    const [body, expected] = await Promise.all([
      download(source.url, source.headers),
      downloadText(source.checksumUrl, source.headers),
    ]);
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
  }

  const pluginUpdated = await updatePlugin();
  if (!binaryUpToDate || pluginUpdated) {
    process.stdout.write("Restart Claude Code so the gate picks up the new version.\n");
  }
  return 0;
}

/**
 * Brings the Claude Code plugin to whatever `main` on the marketplace has, mirroring
 * `claude plugin marketplace update reviewgate && claude plugin update
 * reviewgate@reviewgate`. Best-effort: no `claude` on the machine, or a plugin command
 * failing, is reported and does not fail the update as a whole — the binary is already
 * in place by the time this runs.
 */
async function updatePlugin(): Promise<boolean> {
  let claude: string | null;
  try {
    claude = resolveClaudePath();
  } catch (err) {
    if (!(err instanceof ClaudePathInvalid)) throw err;
    process.stderr.write(`reviewgate: ${err.message}\n`);
    return false;
  }
  if (!claude) {
    process.stdout.write("No claude found on this machine; skipping the plugin update.\n");
    return false;
  }

  process.stdout.write("Updating the Claude Code plugin...\n");
  const steps = [
    ["plugin", "marketplace", "update", "reviewgate"],
    ["plugin", "update", "reviewgate@reviewgate"],
  ];
  for (const args of steps) {
    try {
      await execFileAsync(claude, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `reviewgate: could not update the plugin (claude ${args.join(" ")}): ${message}\n`,
      );
      return false;
    }
  }
  return true;
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

async function download(url: string, headers: Record<string, string> = {}): Promise<Buffer | null> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "reviewgate", ...headers } });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function downloadText(url: string, headers: Record<string, string> = {}): Promise<string | null> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "reviewgate", ...headers } });
  if (!res.ok) return null;
  return res.text();
}

interface AssetSource {
  url: string;
  checksumUrl: string;
  headers: Record<string, string>;
}

/**
 * Where to download the asset and its checksum from.
 *
 * Ordinarily the plain `releases/download` URL, which needs no auth and is all a
 * published release ever needs. A draft release's assets do not exist at that URL for
 * anyone unauthenticated, so `reviewgate update --version <tag>` also accepts a
 * `GH_TOKEN`/`GITHUB_TOKEN` — the same variable `gh` itself uses — and looks the
 * release up through the API instead, which does list a draft's assets to an
 * authenticated maintainer. This only ever runs for a tag pinned with `--version`:
 * a plain `reviewgate update` must never resolve to a release nobody else can see yet.
 */
async function assetSource(tag: string, asset: string, wanted: string | null): Promise<AssetSource> {
  const plain = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
  const fallback: AssetSource = { url: plain, checksumUrl: `${plain}.sha256`, headers: {} };

  const token = wanted ? (process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"]) : undefined;
  if (!token) return fallback;

  const release = await findReleaseByTag(tag, token);
  const bin = release?.assets.find((a) => a.name === asset);
  const checksum = release?.assets.find((a) => a.name === `${asset}.sha256`);
  if (!bin || !checksum) return fallback;

  return {
    url: bin.url,
    checksumUrl: checksum.url,
    headers: { authorization: `Bearer ${token}`, accept: "application/octet-stream" },
  };
}

interface ReleaseAsset {
  name: string;
  url: string;
}

/**
 * A release by tag, including drafts — unlike `GET /releases/tags/{tag}` and
 * `GET /releases/latest`, which both only ever return a published release even when
 * authenticated. Paginated once at 100, which comfortably covers this repo's history;
 * revisit if that ever stops being true.
 */
async function findReleaseByTag(
  tag: string,
  token: string,
): Promise<{ assets: ReleaseAsset[] } | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "reviewgate",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const releases = (await res.json()) as Array<{ tag_name?: unknown; assets?: ReleaseAsset[] }>;
    const release = releases.find((r) => r.tag_name === tag);
    return release ? { assets: release.assets ?? [] } : null;
  } catch {
    return null;
  }
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
