#!/usr/bin/env node
/**
 * Compiles the single-file binaries with Bun.
 *
 * One self-contained executable per platform: the end user downloads a file and is
 * done, with no Node, no npm and no checkout. The web build is inlined first
 * (scripts/embed-web.mjs), because a binary has no dist directory next to it.
 *
 * Usage: node scripts/build-binaries.mjs [--version <tag>] [--target <name>]... [--out <dir>]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Bun's cross-compile target -> the name the release asset carries. */
const TARGETS = {
  "bun-darwin-arm64": "reviewgate-darwin-arm64",
  "bun-darwin-x64": "reviewgate-darwin-x64",
  "bun-linux-x64": "reviewgate-linux-x64",
  "bun-linux-arm64": "reviewgate-linux-arm64",
  "bun-windows-x64": "reviewgate-win32-x64.exe",
};

const args = process.argv.slice(2);
let version = "";
let outDir = join(root, "release");
const only = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--version") version = args[++i] ?? "";
  else if (args[i] === "--target") only.push(args[++i]);
  else if (args[i] === "--out") outDir = resolve(args[++i] ?? outDir);
  else {
    console.error(`build-binaries: unknown option ${args[i]}`);
    process.exit(2);
  }
}

if (!version) {
  version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0";
}
version = version.replace(/^v/, "");
if (!/^[A-Za-z0-9.+-]+$/.test(version)) {
  console.error(`build-binaries: refusing an odd version ${version}`);
  process.exit(2);
}

const targets = only.length > 0 ? only : Object.keys(TARGETS);
for (const t of targets) {
  if (!TARGETS[t]) {
    console.error(`build-binaries: unknown target ${t}. Known: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(2);
  }
}

run("node", [join(root, "scripts", "embed-web.mjs")]);

// The CLI reaches @reviewgate/server through its package main, which is the tsc
// output. Compiling from source alone would bundle whatever dist held before the
// embed, so the UI has to travel through tsc first.
run("npm", ["run", "build:ts"]);

mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  const name = TARGETS[target];
  const outfile = join(outDir, name);
  console.log(`\n==> ${target} -> ${name}`);
  run("bun", [
    "build",
    join(root, "packages", "cli", "src", "bin.ts"),
    "--compile",
    "--no-compile-autoload-bunfig",
    `--target=${target}`,
    "--define",
    // Single quotes on purpose: cmd.exe strips double quotes on the way to bun, and
    // the version is checked above to hold nothing that needs escaping.
    `__REVIEWGATE_VERSION__='${version}'`,
    "--outfile",
    outfile,
  ]);

  const digest = createHash("sha256").update(readFileSync(outfile)).digest("hex");
  writeFileSync(`${outfile}.sha256`, `${digest}  ${name}\n`, "utf8");
  console.log(`    sha256 ${digest}`);
}

console.log(`\nBinaries for ${version} in ${outDir}`);

function run(cmd, argv) {
  try {
    execFileSync(cmd, argv, { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
  } catch (err) {
    if (err?.code === "ENOENT" && cmd === "bun") {
      console.error("build-binaries: bun not found. Install it from https://bun.sh — it is only needed to compile the binaries.");
    }
    process.exit(1);
  }
}
