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
  /** Exit codes that are not failures. `git diff --exit-code` and `--no-index` use 1. */
  okCodes?: readonly number[];
  /** Large diffs do not fit in node's 1 MB default. */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Every git call goes through here: `execFile` with an argv array and `shell: false`,
 * never a composed command string. That way quoting, spaces in paths and shell
 * differences between platforms play no part (§4).
 */
export function runGit(
  args: readonly string[],
  opts: RunGitOptions,
): Promise<GitExecResult> {
  const okCodes = opts.okCodes ?? [0];
  // The -c overrides go before the subcommand and apply to every call: quotePath off
  // so non-ASCII paths do not come back as \xxx escapes, rename detection on so the
  // parser sees renames as renames.
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
            new GitError("git was not found on PATH", full, 127, stderr || String(err)),
          );
          return;
        }
        if (!okCodes.includes(code)) {
          reject(
            new GitError(
              `git ${args.join(" ")} failed with code ${code}: ${stderr.trim()}`,
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

/** Splits git output into lines, CRLF-safe and without a trailing empty line. */
export function splitLines(out: string): string[] {
  const lines = out.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Splits NUL-separated output (`-z`), without a trailing empty value. */
export function splitNul(out: string): string[] {
  const parts = out.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
