import { GitError } from "@reviewgate/core";
import { UsageError } from "./args.js";
import { cmdOpen } from "./commands/open.js";
import { cmdServe, cmdStatus } from "./commands/serve.js";

const USAGE = `reviewgate — lokale code review gate

Gebruik:
  reviewgate open [revisie]   review-scope inlezen
      --staged                (default) de gestagede wijzigingen
      --working               index + working tree tegen HEAD
      --amend                 de wijzigingen van een amend
      <rev>                   een revisie-expressie, bijv. main...HEAD
      --json                  print de getypeerde diffstructuur en stop
      -U, --context <n>       contextregels (default 5)
      --no-untracked          untracked bestanden overslaan
      --no-open               browser niet openen, alleen de URL printen
      --port <n>              vaste poort in plaats van een vrije poort
      -C, --cwd <pad>         werk in een andere repo

  reviewgate serve            server starten zonder review
  reviewgate status           draaiende server en open reviews
  reviewgate hook             (M3)
`;

export async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const cwd = process.cwd();

  try {
    switch (cmd) {
      case "open":
        return await cmdOpen(rest, cwd);
      case undefined:
      case "-h":
      case "--help":
      case "help":
        process.stdout.write(USAGE);
        return 0;
      case "-v":
      case "--version":
        process.stdout.write("reviewgate 0.0.0 (M0)\n");
        return 0;
      case "serve":
        return await cmdServe(rest, cwd);
      case "status":
        return await cmdStatus(rest, cwd);
      case "hook":
        process.stderr.write('reviewgate: "hook" komt in M3.\n');
        return 2;
      default:
        process.stderr.write(`reviewgate: onbekend commando "${cmd}"\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`reviewgate: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof GitError) {
      process.stderr.write(`reviewgate: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
