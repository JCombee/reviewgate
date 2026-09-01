import { execFile } from "node:child_process";

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface RunGitOptions {
  cwd: string;
  /** Exitcodes die geen fout zijn. `git diff --exit-code` en `--no-index` gebruiken 1. */
  okCodes?: readonly number[];
  /** Grote diffs passen niet in de node-default van 1 MB. */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Elke git-aanroep loopt hierlangs: `execFile` met een argv-array en `shell: false`,
 * nooit een samengestelde commandostring. Daarmee spelen quoting, spaties in paden en
 * shellverschillen tussen platforms geen rol (§4).
 */
export function runGit(
  args: readonly string[],
  opts: RunGitOptions,
): Promise<GitExecResult> {
  const okCodes = opts.okCodes ?? [0];
  // -c overrides gaan vóór het subcommando en gelden voor elke aanroep:
  // quotePath uit zodat niet-ASCII paden niet als \xxx-escapes terugkomen,
  // renamedetectie aan zodat de parser renames als rename ziet.
  const full = [
    "-c",
    "core.quotePath=false",
    "-c",
    "diff.renames=true",
    ...args,
  ];

  return new Promise((resolve, reject) => {
    execFile(
      "git",
      full,
      {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
        encoding: "buffer",
        ...(opts.env ? { env: opts.env } : {}),
      },
      (err, stdoutBuf, stderrBuf) => {
        const stdout = stdoutBuf.toString("utf8");
        const stderr = stderrBuf.toString("utf8");
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : err
              ? 1
              : 0;

        if (err && (err as { code?: unknown }).code === "ENOENT") {
          reject(
            new GitError(
              "git is niet gevonden op PATH",
              full,
              127,
              stderr || String(err),
            ),
          );
          return;
        }
        if (!okCodes.includes(code)) {
          reject(
            new GitError(
              `git ${args.join(" ")} faalde met code ${code}: ${stderr.trim()}`,
              full,
              code,
              stderr,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, code });
      },
    );
  });
}

/** Splitst git-output in regels, CRLF-veilig en zonder lege slotregel. */
export function splitLines(out: string): string[] {
  const lines = out.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Splitst NUL-gescheiden output (`-z`), zonder lege slotwaarde. */
export function splitNul(out: string): string[] {
  const parts = out.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
