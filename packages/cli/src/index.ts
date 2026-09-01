import { GitError } from "@reviewgate/core";
import { UsageError } from "./args.js";
import { cmdOpen } from "./commands/open.js";

const USAGE = `reviewgate — lokale code review gate

Gebruik:
  reviewgate open [revisie]   review-scope inlezen
      --staged                (default) de gestagede wijzigingen
      --working               index + working tree tegen HEAD
      --amend                 de wijzigingen van een amend
      <rev>                   een revisie-expressie, bijv. main...HEAD
      --json                  print de getypeerde diffstructuur
      -U, --context <n>       contextregels (default 5)
      --no-untracked          untracked bestanden overslaan
      -C, --cwd <pad>         werk in een andere repo

  reviewgate serve            (M1)
  reviewgate status           (M3)
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
      case "status":
      case "hook":
        process.stderr.write(
          `reviewgate: "${cmd}" bestaat nog niet — dit komt in een latere milestone.\n`,
        );
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
