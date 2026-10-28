import type { ReviewScope } from "../types.js";

/**
 * Parsing the Bash command the hook intercepts.
 *
 * The hook gets a single string, not an argv. You have to take it apart yourself,
 * because `git add -A && git commit -m "..."` is the most common shape and it means
 * nothing is staged yet at hook time (§2).
 */

export interface CommitAnalysis {
  /** Does the command contain a `git commit`? If not, the hook lets it through. */
  isCommit: boolean;
  /**
   * The scope to review when `stage` cannot be replayed: the whole working tree once
   * anything gets staged in the chain, as the safe overestimate.
   */
  scope: ReviewScope;
  /**
   * The commands in the chain that stage something before the commit, as git argv
   * without the leading `git`, in order; `commit -a` contributes `add -u`. They have
   * not run yet at hook time. Null when the chain stages in a way that cannot be
   * replayed safely, such as `git add -p` or a `cd` first.
   */
  stage: string[][] | null;
  /** `--amend` is in the command. */
  amend: boolean;
  /** `--no-verify` or `-n`: bypassing the gate. Block it with an explanation (§2). */
  noVerify: boolean;
  /** The message from `-m`, or null when it is not there (with `-F`, for instance). */
  message: string | null;
  /** `-F <path>` or `--file=<path>`: the message comes from a file. */
  messageFile: string | null;
  /** The parsed segments, for logging and error messages. */
  segments: string[][];
}

/**
 * Splits a shell command into segments and each segment into argv.
 *
 * Deliberately a small, hand-written tokenizer: we do not need to be a shell, only
 * good enough to recognise `git commit` including quoting. Anything we do not
 * understand we treat conservatively — better one review too many than a missed
 * commit.
 */
export function splitCommand(command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let hasToken = false;
  let quote: '"' | "'" | null = null;

  const endToken = (): void => {
    if (hasToken) {
      current.push(token);
      token = "";
      hasToken = false;
    }
  };
  const endSegment = (): void => {
    endToken();
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        token += command[++i] as string;
        hasToken = true;
      } else {
        token += ch;
        hasToken = true;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      // An empty string is a token too: `git commit -m ""`.
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      token += command[++i] as string;
      hasToken = true;
      continue;
    }
    if (ch === "&" || ch === "|") {
      // &&, || and | all separate commands.
      if (command[i + 1] === ch) i++;
      endSegment();
      continue;
    }
    if (ch === ";" || ch === "\n") {
      endSegment();
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endToken();
      continue;
    }
    token += ch;
    hasToken = true;
  }
  endSegment();
  return segments;
}

/** Index of the subcommand in a `git` invocation, or -1 when this is not git. */
function gitSubcommandIndex(argv: readonly string[]): number {
  const first = argv[0];
  if (first !== "git" && first !== "git.exe" && !first?.endsWith("/git")) return -1;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    // Skip global options before the subcommand: `git -c x=y commit`.
    if (arg === "-c" || arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return i;
  }
  return -1;
}

/** Is this segment a `git` invocation of this subcommand? */
function isGitSubcommand(argv: readonly string[], sub: string): boolean {
  const i = gitSubcommandIndex(argv);
  return i !== -1 && argv[i] === sub;
}

/**
 * Does this `git add` prompt for input or read stdin? Replaying it in the hook would
 * hang, so the chain counts as not replayable.
 */
function addIsInteractive(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (["-p", "--patch", "-i", "--interactive", "-e", "--edit"].includes(arg)) return true;
    if (arg.startsWith("--pathspec-from-file")) return true;
    if (/^-[a-zA-Z]{2,}$/.test(arg) && /[pie]/.test(arg)) return true;
  }
  return false;
}

/**
 * The staging commands that run before the commit, replayable against a copy of the
 * index. `git rm` gets `--cached`, so the replay never deletes a file from disk.
 */
function stagingSteps(before: readonly string[][]): string[][] | null {
  const steps: string[][] = [];
  for (const argv of before) {
    // Relative paths after a `cd` no longer resolve from the hook's directory.
    if (argv[0] === "cd" || argv[0] === "pushd" || argv[0] === "popd") return null;

    const i = gitSubcommandIndex(argv);
    if (i === -1) continue;
    const sub = argv[i];
    const args = argv.slice(i + 1);

    if (sub === "add") {
      if (addIsInteractive(args)) return null;
      steps.push(argv.slice(1));
    } else if (sub === "rm") {
      steps.push([...argv.slice(1, i + 1), "--cached", ...args]);
    } else if (sub === "mv") {
      // Moves files on disk; there is no index-only variant to replay.
      return null;
    }
  }
  return steps;
}

export function analyzeCommand(command: string): CommitAnalysis {
  const segments = splitCommand(command);
  const commit = segments.find((s) => isGitSubcommand(s, "commit"));

  if (!commit) {
    return {
      isCommit: false,
      scope: "staged",
      amend: false,
      noVerify: false,
      message: null,
      messageFile: null,
      stage: [],
      segments,
    };
  }

  let amend = false;
  let noVerify = false;
  let stagesAll = false;
  const messages: string[] = [];
  let messageFile: string | null = null;

  for (let i = 1; i < commit.length; i++) {
    const arg = commit[i] as string;

    if (arg === "--amend") amend = true;
    else if (arg === "--no-verify" || arg === "-n") noVerify = true;
    else if (arg === "--all") stagesAll = true;
    else if (arg === "-m" || arg === "--message") {
      const v = commit[++i];
      if (v !== undefined) messages.push(v);
    } else if (arg.startsWith("--message=")) {
      messages.push(arg.slice("--message=".length));
    } else if (arg === "-F" || arg === "--file") {
      const v = commit[++i];
      if (v !== undefined) messageFile = v;
    } else if (arg.startsWith("--file=")) {
      messageFile = arg.slice("--file=".length);
    } else if (/^-[a-zA-Z]{2,}$/.test(arg)) {
      // Bundled short flags: -am, -an and so on.
      const flags = arg.slice(1);
      if (flags.includes("a")) stagesAll = true;
      if (flags.includes("n")) noVerify = true;
      if (flags.endsWith("m")) {
        const v = commit[++i];
        if (v !== undefined) messages.push(v);
      }
    } else if (arg === "-a") {
      stagesAll = true;
    }
  }

  const steps = stagingSteps(segments.slice(0, segments.indexOf(commit)));
  const stage = steps && stagesAll ? [...steps, ["add", "-u"]] : steps;
  const staging = stage === null || stage.length > 0;

  const scope: ReviewScope = amend ? "amend" : staging ? "working" : "staged";

  return {
    isCommit: true,
    scope,
    amend,
    noVerify,
    // git joins several -m values with a blank line in between.
    message: messages.length > 0 ? messages.join("\n\n") : null,
    messageFile,
    stage,
    segments,
  };
}

/**
 * Rewrites the command so it reads the edited message from a file.
 *
 * This is the only moment ReviewGate touches the agent's command (§10). `-F <path>`
 * instead of `-m "..."` avoids all the quoting misery with multi-line messages and
 * quotation marks. Every other flag stays put.
 */
export function rewriteWithMessageFile(command: string, messagePath: string): string {
  const segments = splitCommand(command);
  const rewritten = segments.map((argv) => {
    if (!isGitSubcommand(argv, "commit")) return argv;

    const out: string[] = [];
    let replaced = false;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i] as string;

      if (arg === "-m" || arg === "--message" || arg === "-F" || arg === "--file") {
        i++;
        replaced = true;
        continue;
      }
      if (arg.startsWith("--message=") || arg.startsWith("--file=")) {
        replaced = true;
        continue;
      }
      if (/^-[a-zA-Z]{2,}$/.test(arg) && arg.endsWith("m")) {
        // -am becomes -a; the message comes from the file.
        const rest = arg.slice(1, -1);
        if (rest.length > 0) out.push(`-${rest}`);
        i++;
        replaced = true;
        continue;
      }
      out.push(arg);
    }

    if (!replaced) {
      // No -m in the command: git would open an editor. Even then we pass the
      // message along, because the reviewer just settled on it.
    }
    out.push("-F", messagePath);
    return out;
  });

  return rewritten.map((argv) => argv.map(quoteArg).join(" ")).join(" && ");
}

/** Quotes an argument for a POSIX shell; git-bash runs on Windows too. */
function quoteArg(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.split("'").join(`'\\''`)}'`;
}
