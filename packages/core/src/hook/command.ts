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
  /** The scope that should be reviewed. */
  scope: ReviewScope;
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

/** Is this segment a `git` invocation of this subcommand? */
function isGitSubcommand(argv: readonly string[], sub: string): boolean {
  const first = argv[0];
  if (first !== "git" && first !== "git.exe" && !first?.endsWith("/git")) return false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    // Skip global options before the subcommand: `git -c x=y commit`.
    if (arg === "-c" || arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg === sub;
  }
  return false;
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

  // A `git add` earlier in the chain also stages whatever is lying around now.
  const addsBefore = segments.some((s) => isGitSubcommand(s, "add"));

  const scope: ReviewScope = amend ? "amend" : stagesAll || addsBefore ? "working" : "staged";

  return {
    isCommit: true,
    scope,
    amend,
    noVerify,
    // git joins several -m values with a blank line in between.
    message: messages.length > 0 ? messages.join("\n\n") : null,
    messageFile,
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
