import type { ReviewScope } from "../types.js";

/**
 * Ontleden van het Bash-commando dat de hook onderschept.
 *
 * De hook krijgt één string, geen argv. Die moet je zelf uit elkaar halen, want
 * `git add -A && git commit -m "..."` is de meest voorkomende vorm en betekent dat
 * er op hook-tijd nog niets gestaged is (§2).
 */

export interface CommitAnalysis {
  /** Bevat het commando een `git commit`? Zo niet, dan laat de hook het door. */
  isCommit: boolean;
  /** De scope waarop gereviewd moet worden. */
  scope: ReviewScope;
  /** `--amend` staat in het commando. */
  amend: boolean;
  /** `--no-verify` of `-n`: de gate omzeilen. Blokkeren met uitleg (§2). */
  noVerify: boolean;
  /** De message uit `-m`, of null als hij er niet in staat (bijv. bij `-F`). */
  message: string | null;
  /** `-F <pad>` of `--file=<pad>`: de message komt uit een bestand. */
  messageFile: string | null;
  /** De ontlede segmenten, voor logging en foutmeldingen. */
  segments: string[][];
}

/**
 * Splitst een shell-commando in segmenten en elk segment in argv.
 *
 * Bewust een kleine, eigen tokenizer: we hoeven geen shell te zijn, alleen goed
 * genoeg om `git commit` te herkennen inclusief quoting. Wat we niet begrijpen
 * behandelen we conservatief — liever een review te veel dan een gemiste commit.
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
      // Een lege string is ook een token: `git commit -m ""`.
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      token += command[++i] as string;
      hasToken = true;
      continue;
    }
    if (ch === "&" || ch === "|") {
      // && , || en | scheiden allemaal commando's.
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

/** Is dit segment een `git`-aanroep van dit subcommando? */
function isGitSubcommand(argv: readonly string[], sub: string): boolean {
  const first = argv[0];
  if (first !== "git" && first !== "git.exe" && !first?.endsWith("/git")) return false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    // Globale opties vóór het subcommando overslaan: `git -c x=y commit`.
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
      // Samengevoegde korte vlaggen: -am, -an, enzovoort.
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

  // Een `git add` eerder in de keten stageert ook alles wat er nu ligt.
  const addsBefore = segments.some((s) => isGitSubcommand(s, "add"));

  const scope: ReviewScope = amend ? "amend" : stagesAll || addsBefore ? "working" : "staged";

  return {
    isCommit: true,
    scope,
    amend,
    noVerify,
    // git plakt meerdere -m aan elkaar met een lege regel ertussen.
    message: messages.length > 0 ? messages.join("\n\n") : null,
    messageFile,
    segments,
  };
}

/**
 * Herschrijft het commando zodat het de bewerkte message uit een bestand leest.
 *
 * Dit is het enige moment waarop ReviewGate het commando van de agent aanpast
 * (§10). `-F <pad>` in plaats van `-m "..."` vermijdt alle quoting-ellende met
 * meerregelige messages en aanhalingstekens. Alle overige vlaggen blijven staan.
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
        // -am wordt -a; de message komt uit het bestand.
        const rest = arg.slice(1, -1);
        if (rest.length > 0) out.push(`-${rest}`);
        i++;
        replaced = true;
        continue;
      }
      out.push(arg);
    }

    if (!replaced) {
      // Geen -m in het commando: git zou een editor openen. Ook dan geven we de
      // message mee, want de reviewer heeft hem net vastgesteld.
    }
    out.push("-F", messagePath);
    return out;
  });

  return rewritten.map((argv) => argv.map(quoteArg).join(" ")).join(" && ");
}

/** Quoot een argument voor een POSIX-shell; git-bash draait ook op Windows. */
function quoteArg(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.split("'").join(`'\\''`)}'`;
}
