#!/usr/bin/env node
/**
 * Installs the working tree over the reviewgate you already have.
 *
 * `scripts/install.sh` and `scripts/install.ps1` fetch a published release; this one
 * compiles what is checked out and drops it on top of the existing install, so the
 * gate you hit on your next commit is the code in front of you. One script for every
 * platform on purpose: anyone with a checkout has Node, and a single file cannot drift
 * between a shell and a PowerShell version the way a pair does.
 *
 * By default it overwrites the binary you already have — the one your PATH resolves
 * `reviewgate` to, or, on WSL, the Windows install on that same PATH, which bash walks
 * past because the file is called reviewgate.exe. Without an existing install it falls
 * back to the directory the native installer uses.
 *
 * Usage: node scripts/install-local.mjs [--target <bun target>] [--dir <path>]
 *                                       [--version <v>] [--wrapper] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The bun target for the platform this script runs on. */
const NATIVE_TARGETS = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64",
  "win32-x64": "bun-windows-x64",
};

/** The file each target produces, mirroring build-binaries.mjs. */
const ASSETS = {
  "bun-darwin-arm64": "reviewgate-darwin-arm64",
  "bun-darwin-x64": "reviewgate-darwin-x64",
  "bun-linux-arm64": "reviewgate-linux-arm64",
  "bun-linux-x64": "reviewgate-linux-x64",
  "bun-windows-x64": "reviewgate-win32-x64.exe",
};

const HELP = `Installs the working tree over your existing reviewgate.

Usage: node scripts/install-local.mjs [options]

  --target <name>   bun target to compile (default: this platform, or the Windows
                    target when your PATH resolves reviewgate to an .exe)
  --dir <path>      install directory (default: over the current install)
  --version <v>     version to stamp (default: <package version>-local.<sha>)
  --wrapper         install a launcher that runs this checkout, without bun
  --dry-run         print what would happen and stop
`;

const args = process.argv.slice(2);
let target = "";
let dir = "";
let version = "";
let wrapper = false;
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--target") target = value(arg, args[++i]);
  else if (arg === "--dir") dir = value(arg, args[++i]);
  else if (arg === "--version") version = value(arg, args[++i]);
  else if (arg === "--wrapper") wrapper = true;
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "-h" || arg === "--help") {
    process.stdout.write(HELP);
    process.exit(0);
  } else die(`unknown option ${arg}`);
}

function value(flag, given) {
  if (given === undefined || given.startsWith("--")) die(`${flag} needs a value`);
  return given;
}

// --- what is installed now ---------------------------------------------------

const current = whichReviewgate();

if (wrapper && target) die("--wrapper compiles nothing, so --target has no meaning here.");
if (wrapper && version) die("--wrapper compiles nothing, so there is no version to stamp.");

if (!target && !wrapper) {
  // WSL is the awkward one: the shell is Linux, but the reviewgate on the PATH can be
  // the Windows install, and a Linux binary would never be the one that runs.
  target =
    current?.toLowerCase().endsWith(".exe") && process.platform !== "win32"
      ? "bun-windows-x64"
      : (NATIVE_TARGETS[`${process.platform}-${process.arch}`] ?? "");
  if (!target) die(`no binary target for ${process.platform}-${process.arch}. Pass --target.`);
}
const asset = wrapper ? "" : ASSETS[target];
if (!wrapper && !asset) die(`unknown target ${target}. Known: ${Object.keys(ASSETS).join(", ")}`);

const dest = destination();

if (!version) version = `${pkgVersion()}-local${gitSuffix()}`;

say(`target      ${wrapper ? `a launcher for ${root}` : target}`);
// A launcher stamps nothing: the version is compiled in, and running from source has
// none, so `reviewgate --version` keeps saying 0.0.0-dev there.
if (!wrapper) say(`version     ${version}`);
say(`installing  ${dest}${current === dest ? " (replacing the install on your PATH)" : ""}`);
if (current && current !== dest) warn(`your PATH resolves reviewgate to ${current}`);

if (dryRun) {
  say("dry run — nothing built, nothing written.");
  process.exit(0);
}

// --- build -------------------------------------------------------------------

const staging = mkdtempSync(path.join(os.tmpdir(), "reviewgate-local-"));
try {
  if (wrapper) {
    buildFromSource();
    writeFileSync(path.join(staging, "launcher"), launcher(), "utf8");
    install(path.join(staging, "launcher"), dest);
  } else {
    compile(staging);
    install(path.join(staging, asset), dest);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

// --- report ------------------------------------------------------------------

say(`installed   ${runVersion(dest) ?? "(could not run it here)"}`);
if (!onPath(path.dirname(dest))) {
  warn(`${path.dirname(dest)} is not on your PATH; the plugin runs "reviewgate hook" and would not find it.`);
}
if (wrapper) {
  say(`this launcher follows ${root}: rebuild there and it is live, no reinstall.`);
} else {
  warn("this is a build from source: `reviewgate update` replaces it with the next published release.");
}

// --- helpers -----------------------------------------------------------------

/** Compiles the single-file binary, with a word about the one place bun cannot. */
function compile(out) {
  try {
    npm(process.execPath, [
      path.join(root, "scripts", "build-binaries.mjs"),
      "--target",
      target,
      "--out",
      out,
      "--version",
      version,
    ]);
  } catch {
    // The compiler already printed why; a stack trace of our own exec call on top of
    // that only buries it.
    die(
      "the build failed; its output is above." +
        // Not every failure here is that one, so point at it rather than claim it.
        (onWindowsDrive()
          ? '\n  If that is an EINVAL on "/mnt/...", bun cannot compile a checkout that\n' +
            "  lives on a Windows drive from inside WSL. Run it from PowerShell, or\n" +
            "  install a launcher that runs the checkout instead:\n" +
            "      npm run install:local -- --wrapper"
          : ""),
    );
  }
}

/**
 * The build a launcher needs: the compiled server and CLI, and the web build the
 * server reads from `packages/web/dist`. Deliberately not the embed step — that
 * overwrites a file in the tree that is a stub on purpose, and a source build has no
 * use for it.
 */
function buildFromSource() {
  npm("npm", ["run", "build"]);
}

/** A launcher is the way in on a machine where bun will not compile the checkout. */
function launcher() {
  const entry = path.join(root, "packages", "cli", "bin", "reviewgate.mjs");
  if (process.platform === "win32") {
    return [
      "@echo off",
      ":: Written by scripts/install-local.mjs — runs the checkout it was made from.",
      `node "${entry}" %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
  }
  return [
    "#!/usr/bin/env bash",
    "# Written by scripts/install-local.mjs — runs the checkout it was made from.",
    `exec node "${entry}" "$@"`,
    "",
  ].join("\n");
}

/** A checkout under /mnt on WSL: the one place bun refuses to open the sources. */
function onWindowsDrive() {
  return process.platform === "linux" && /^\/mnt\/[a-z]\//i.test(root);
}

function npm(cmd, argv) {
  execFileSync(cmd, argv, { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
}

/**
 * Puts the freshly built binary in place. Never a plain overwrite: a running gate
 * holds the old file open on Windows, where you may rename a busy executable but not
 * write over it. So the new one lands beside it and the old one is moved aside.
 */
function install(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  const incoming = `${to}.new`;
  const previous = `${to}.old`;

  copyFileSync(from, incoming);
  if (process.platform !== "win32") chmodSync(incoming, 0o755);

  if (existsSync(to)) {
    rmSync(previous, { force: true });
    try {
      renameSync(to, previous);
    } catch (err) {
      rmSync(incoming, { force: true });
      die(`${to} is in use. Close the running review and try again.\n  ${String(err)}`);
    }
  }
  renameSync(incoming, to);
  // A binary that was running keeps its old file alive until it exits; leaving that
  // behind is better than refusing the install over it.
  try {
    unlinkSync(previous);
  } catch {
    // Still held, or never there.
  }
}

/** Where the binary goes: your choice, else over the current one, else the default. */
function destination() {
  const name = wrapper
    ? process.platform === "win32"
      ? "reviewgate.cmd"
      : "reviewgate"
    : target === "bun-windows-x64"
      ? "reviewgate.exe"
      : "reviewgate";
  // A launcher cannot take the place of an installed .exe: Windows tries .exe before
  // .cmd, so the old binary would keep winning.
  if (wrapper && current?.toLowerCase().endsWith(".exe") && !dir) {
    die(
      `${current} is an installed binary; a launcher next to it would never run.\n` +
        "  Compile instead (drop --wrapper), or pass --dir to put the launcher elsewhere.",
    );
  }
  if (dir) return path.join(path.resolve(dir), name);
  if (current) return current;

  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"];
    if (!local) die("LOCALAPPDATA is not set; pass --dir.");
    return path.join(local, "Programs", "reviewgate", name);
  }
  if (target === "bun-windows-x64") {
    die(
      "a Windows binary with no Windows install to replace: pass --dir, e.g.\n" +
        "  --dir /mnt/c/Users/<you>/AppData/Local/Programs/reviewgate",
    );
  }
  return path.join(os.homedir(), ".local", "bin", name);
}

/** The reviewgate already installed, or null when there is none. */
function whichReviewgate() {
  // npm puts node_modules/.bin in front of the PATH, and the workspace has a shim
  // named reviewgate in there. That is the checkout talking to itself, not an install,
  // so walk past it to whatever comes after.
  const found = (
    process.platform === "win32" ? lookup("where.exe", "reviewgate") : lookup("which", "-a", "reviewgate")
  ).find((candidate) => !inCheckout(candidate));
  if (found) return found;
  if (process.platform === "win32") return null;

  // WSL: the Windows install sits on the shared PATH, but bash resolves a command to a
  // file of exactly that name, so `which reviewgate` walks straight past reviewgate.exe.
  // It is still the binary Windows runs, and the one to replace.
  for (const entry of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (entry.trim() === "") continue;
    const candidate = path.join(entry, "reviewgate.exe");
    if (existsSync(candidate) && !inCheckout(candidate)) return candidate;
  }
  return null;
}

/** Is this the workspace's own bin shim rather than an installed binary? */
function inCheckout(candidate) {
  const bin = path.join(root, "node_modules");
  return !path.relative(bin, path.resolve(candidate)).startsWith("..");
}

/** Every match, in the order the shell would try them. */
function lookup(cmd, ...argv) {
  try {
    return execFileSync(cmd, argv, { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

function onPath(directory) {
  const entries = (process.env["PATH"] ?? "").split(path.delimiter);
  const same = (a, b) => {
    const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32"
      ? norm(a).toLowerCase() === norm(b).toLowerCase()
      : norm(a) === norm(b);
  };
  return entries.some((entry) => entry.trim() !== "" && same(entry, directory));
}

function runVersion(binary) {
  try {
    return execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    // A Windows binary built on macOS or Linux cannot run here, and that is fine.
    return null;
  }
}

function pkgVersion() {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version ?? "0.0.0";
}

/** `-local.<sha>` when this is a git checkout, so `--version` says which build it is. */
function gitSuffix() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha ? `.${sha}` : "";
  } catch {
    return "";
  }
}

function say(message) {
  process.stdout.write(`==> ${message}\n`);
}

function warn(message) {
  process.stderr.write(`warning: ${message}\n`);
}

function die(message) {
  process.stderr.write(`install-local: ${message}\n`);
  process.exit(1);
}
