#!/usr/bin/env node
/**
 * Dunne wrapper om `reviewgate hook`.
 *
 * Node-script, geen shellscript, en expliciet met `node` gestart in hooks.json:
 * zo hangt de gate niet af van een POSIX-shell of van het exec-bit, en werkt hij
 * op macOS, Linux en Windows gelijk (§4, §15.9).
 *
 * Bij élke fout eindigen we stil met exit 0. Een kapotte gate mag nooit het werk
 * blokkeren, alleen niet reviewen (§11).
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * De CLI-entry direct met `node` starten, niet de bin-shim: die heet op Windows
 * `reviewgate.cmd` en dan zou het commando per platform verschillen (§11).
 */
function findCli() {
  const fromEnv = process.env.REVIEWGATE_CLI;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates = [
    // Naast de plugin, in een monorepo-checkout.
    resolve(here, "../../packages/cli/bin/reviewgate.mjs"),
    // Meegeleverd in de plugin zelf.
    resolve(here, "../node_modules/@reviewgate/cli/bin/reviewgate.mjs"),
    // Geïnstalleerd in het project.
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
    // Stil falen is hier het enige goede antwoord.
  }
}

const cli = findCli();
if (!cli) {
  logFailure("reviewgate CLI niet gevonden; commit ongehinderd doorgelaten");
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
  // Ook bij een niet-nul exit laten we de commit door.
  process.exit(0);
});
