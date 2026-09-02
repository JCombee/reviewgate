#!/usr/bin/env node
/**
 * Point Claude Code at the built ReviewGate CLI.
 *
 * The plugin's hook wrapper looks for the CLI next to itself first, but an installed
 * plugin lives under ~/.claude/plugins, far away from the checkout that holds the
 * build. Writing REVIEWGATE_CLI into the user settings closes that gap for every
 * session and every hook.
 *
 * Usage: node set-env.mjs <absolute path to packages/cli/bin/reviewgate.mjs>
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const cliPath = process.argv[2];
if (!cliPath) {
  console.error("set-env: expected the path to reviewgate.mjs as the first argument.");
  process.exit(1);
}
if (!existsSync(cliPath)) {
  console.error(`set-env: ${cliPath} does not exist. Build the repo first.`);
  process.exit(1);
}

const settingsPath = join(homedir(), ".claude", "settings.json");
mkdirSync(dirname(settingsPath), { recursive: true });

/**
 * A settings file that does not parse is never overwritten: that would throw away
 * someone's whole configuration over a stray comma.
 */
let settings = {};
if (existsSync(settingsPath)) {
  const raw = readFileSync(settingsPath, "utf8").trim();
  if (raw) {
    try {
      settings = JSON.parse(raw);
    } catch {
      console.error(`set-env: ${settingsPath} is not valid JSON. Leaving it untouched.`);
      console.error(`Add this yourself:  "env": { "REVIEWGATE_CLI": ${JSON.stringify(cliPath)} }`);
      process.exit(1);
    }
  }
  copyFileSync(settingsPath, `${settingsPath}.reviewgate-backup`);
}

if (typeof settings.env !== "object" || settings.env === null) settings.env = {};
settings.env.REVIEWGATE_CLI = cliPath;

writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
console.log(`REVIEWGATE_CLI -> ${cliPath}  (${settingsPath})`);
