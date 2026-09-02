#!/usr/bin/env node
/**
 * A thin wrapper around `reviewgate hook`.
 *
 * A Node script rather than a shell script, started explicitly with `node` in
 * hooks.json: that way the gate does not depend on a POSIX shell or on the exec bit,
 * and it behaves the same on macOS, Linux and Windows (§4, §15.9).
 *
 * On *any* failure we exit quietly with status 0. A broken gate must never block the
 * work, only fail to review it (§11).
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Start the CLI entry with `node` directly rather than the bin shim: on Windows that
 * shim is called `reviewgate.cmd`, which would make the command platform-specific
 * (§11).
 */
function findCli() {
  const fromEnv = process.env.REVIEWGATE_CLI;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates = [
    // Next to the plugin, in a monorepo checkout.
    resolve(here, "../../packages/cli/bin/reviewgate.mjs"),
    // Shipped inside the plugin itself.
    resolve(here, "../node_modules/@reviewgate/cli/bin/reviewgate.mjs"),
    // Installed in the project.
    resolve(process.cwd(), "node_modules/@reviewgate/cli/bin/reviewgate.mjs"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function logFailure(message) {
  try {
    const dir = join(process.cwd(), ".git", "reviewgate");
    mkdirSync(dir, { recursive: true });
    const stream = createWriteStream(join(dir, "hook.log"), { flags: "a" });
    stream.end(`${new Date().toISOString()} wrapper: ${message}\n`);
  } catch {
    // Failing silently is the only right answer here.
  }
}

const cli = findCli();
if (!cli) {
  logFailure("reviewgate CLI not found; commit let through untouched");
  process.exit(0);
}

const child = spawn(process.execPath, [cli, "hook"], {
  stdio: ["inherit", "inherit", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr?.on("data", (chunk) => {
  stderr += String(chunk);
});

child.on("error", (err) => {
  logFailure(String(err));
  process.exit(0);
});

child.on("close", (code) => {
  if (code !== 0) logFailure(`exit ${code}: ${stderr.trim()}`);
  // Even on a non-zero exit we let the commit through.
  process.exit(0);
});
