import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "../git/exec.js";

/**
 * Runs the repo's own `pre-commit` hook before the diff is captured, so a commit that
 * is going to fail its own hooks is denied before a human spends time reviewing it, and
 * a diff a human approves reflects whatever the hook itself rewrote.
 *
 * Resolution mirrors real git hook-invocation semantics: `core.hooksPath` (resolved
 * against the repo root when relative), falling back to `<gitDir>/hooks`. A missing or
 * non-executable `pre-commit`, or any error resolving/spawning it, is indistinguishable
 * from "no hook" — only the hook's own non-zero exit is a denial.
 */

export type PreCommitOutcome =
  | { kind: "none" }
  | { kind: "pass" }
  | { kind: "fail"; output: string };

/**
 * Resolves the directory git would look in for hooks: `core.hooksPath` (a relative
 * value resolved against `root`, matching Husky's `core.hooksPath .husky` convention),
 * or `<gitDir>/hooks` when the key is unset. Exit code 1 from `git config --get` means
 * "unset", not an error (the same `okCodes` pattern `NodeGitClient` uses elsewhere).
 */
export async function resolveHooksDir(root: string, gitDir: string): Promise<string> {
  const res = await runGit(["config", "--get", "core.hooksPath"], {
    cwd: root,
    okCodes: [0, 1],
  });
  const value = res.code === 0 ? res.stdout.trim() : "";
  if (value === "") return path.join(gitDir, "hooks");
  return path.resolve(root, value);
}

/**
 * Runs the resolved `pre-commit` hook, if there is one. Never throws: any failure
 * resolving the hooks directory or spawning the hook — as distinct from the hook's own
 * non-zero exit — is treated identically to "no hook present" (fail open, §11).
 */
export async function runPreCommitHook(root: string, gitDir: string): Promise<PreCommitOutcome> {
  try {
    const hooksDir = await resolveHooksDir(root, gitDir);
    const hookPath = path.join(hooksDir, "pre-commit");
    if (!(await isRunnableHook(hookPath))) return { kind: "none" };

    const { code, output } = await execHook(hookPath, root);
    return code === 0 ? { kind: "pass" } : { kind: "fail", output };
  } catch {
    return { kind: "none" };
  }
}

/**
 * Is there a `pre-commit` file here that git would actually run? POSIX (`darwin`,
 * `linux` — WSL's Node reports `linux`) requires the executable bit; a directory at
 * that path is never runnable regardless of its permission bits, since `X_OK` on a
 * directory only means "traversable". Windows has no POSIX exec bit — Git for Windows
 * launches hook scripts through its own bundled shell — so file-existence is enough.
 */
async function isRunnableHook(hookPath: string): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(hookPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (process.platform === "win32") return true;

  try {
    await fs.access(hookPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawns the hook directly (no shell, matching `runGit`'s `execFile`/`shell: false`
 * pattern) with cwd at the repo root and the current process environment, capturing
 * stdout+stderr and the exit code.
 *
 * A spawn-level failure (the binary itself cannot be launched — permission denied, a
 * bad shebang, and so on) surfaces from `execFile` with a non-numeric `err.code`
 * (`"ENOENT"`, `"EACCES"`, `"ENOEXEC"`, ...); that is rejected here so the caller's
 * fail-open handling applies, and is kept distinct from the hook's own numeric exit
 * code, which is never a runner error.
 */
function execHook(hookPath: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      hookPath,
      [],
      {
        cwd,
        shell: false,
        windowsHide: true,
        maxBuffer: 256 * 1024 * 1024,
        encoding: "buffer",
        env: process.env,
      },
      (err, stdoutBuf, stderrBuf) => {
        const errCode = (err as NodeJS.ErrnoException | null)?.code;
        if (err && typeof errCode !== "number") {
          reject(err);
          return;
        }

        const stdout = stdoutBuf.toString("utf8");
        const stderr = stderrBuf.toString("utf8");
        const code = typeof errCode === "number" ? errCode : 0;
        resolve({ code, output: `${stdout}${stderr}`.trim() });
      },
    );
  });
}
