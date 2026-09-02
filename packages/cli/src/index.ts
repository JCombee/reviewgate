import { GitError, VERSION } from "@reviewgate/core";
import { UsageError } from "./args.js";
import { cmdHook } from "./commands/hook.js";
import { cmdOpen } from "./commands/open.js";
import { cmdServe, cmdStatus } from "./commands/serve.js";
import { cmdUpdate, sweepOldBinary } from "./commands/update.js";

const USAGE = `reviewgate — a local code review gate

Usage:
  reviewgate open [revision]  read in a review scope and open it
      --staged                (default) the staged changes
      --working               index plus working tree against HEAD
      --amend                 the changes of an amend
      <rev>                   a revision expression, e.g. main...HEAD
      --json                  print the typed diff structure and stop
      -U, --context <n>       context lines (default 5)
      --no-untracked          skip untracked files
      --no-open               do not open the browser, just print the URL
      --port <n>              a fixed port instead of a free one
      -C, --cwd <path>        work in another repo

  reviewgate serve            start the server without a review
  reviewgate status           the running server and open reviews
  reviewgate hook             PreToolUse hook: reads hook JSON from stdin and blocks
  reviewgate update           replace this binary with the newest release
      --check                 only report whether a newer release exists
      --version <tag>         install exactly this tag
  reviewgate --version        the version of this build
`;

export async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const cwd = process.cwd();

  // A Windows update leaves the previous binary next to this one; drop it here rather
  // than in the updater, which cannot delete a file it is still running from.
  await sweepOldBinary();

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
        process.stdout.write(`reviewgate ${VERSION}\n`);
        return 0;
      case "serve":
        return await cmdServe(rest, cwd);
      case "status":
        return await cmdStatus(rest, cwd);
      case "hook":
        return await cmdHook(cwd);
      case "update":
        return await cmdUpdate(rest);
      default:
        process.stderr.write(`reviewgate: unknown command "${cmd}"\n\n${USAGE}`);
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
