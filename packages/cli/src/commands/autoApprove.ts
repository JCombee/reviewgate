import { NodeGitClient, readAutoApprove, setAutoApprove } from "@reviewgate/core";
import { UsageError } from "../args.js";

/**
 * `reviewgate auto-approve [on|off|status]`: the switch that lets every commit in this
 * checkout through without a review.
 *
 * Switching it on is refused inside Claude Code (which sets `CLAUDECODE=1` for the
 * commands it runs), so the agent cannot lift its own gate. The hook refuses the
 * command too; this catches the forms the hook's match misses.
 */
export async function cmdAutoApprove(argv: readonly string[], cwd: string): Promise<number> {
  let action: "on" | "off" | "status" = "status";
  let dir = cwd;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "on" || a === "off" || a === "status") {
      action = a;
    } else if (a === "-C" || a === "--cwd") {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} expects a path`);
      dir = v;
    } else {
      throw new UsageError(`auto-approve: unknown argument: ${a}`);
    }
  }

  const git = await NodeGitClient.open(dir);
  const info = await git.info();

  if (action === "on") {
    if (process.env["CLAUDECODE"] === "1") {
      process.stderr.write(
        "reviewgate: auto-approve can only be switched on from your own terminal, " +
          "not from inside Claude Code.\n",
      );
      return 1;
    }
    await setAutoApprove(info.gitDir, true);
    process.stdout.write(
      `Auto-approve is on for ${info.root}: commits go through without a review.\n` +
        "Switch it off with `reviewgate auto-approve off`.\n",
    );
    return 0;
  }

  if (action === "off") {
    await setAutoApprove(info.gitDir, false);
    process.stdout.write(`Auto-approve is off for ${info.root}: commits are reviewed again.\n`);
    return 0;
  }

  const state = await readAutoApprove(info.gitDir);
  process.stdout.write(
    state
      ? `Auto-approve is on for ${info.root} (since ${state.enabledAt}).\n`
      : `Auto-approve is off for ${info.root}.\n`,
  );
  return 0;
}
