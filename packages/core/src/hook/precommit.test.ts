import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestRepo } from "../git/testRepo.js";
import { resolveHooksDir, runPreCommitHook } from "./precommit.js";

/** POSIX-only: Windows has no executable bit, and the story treats file-existence as
 * sufficient there (Git for Windows launches hook scripts through its own shell). */
const isPosix = process.platform !== "win32";

let repo: TestRepo;
let gitDir: string;

beforeEach(async () => {
  repo = await TestRepo.create();
  gitDir = path.join(repo.root, ".git");
});

afterEach(async () => {
  await repo.cleanup();
});

/** Writes an executable `pre-commit` script (or a plain file, on Windows). */
async function writeHook(relPosix: string, script: string): Promise<void> {
  await repo.write(relPosix, script);
  if (isPosix) await fs.chmod(repo.abs(relPosix), 0o755);
}

describe("resolveHooksDir", () => {
  it("defaults to <gitDir>/hooks when core.hooksPath is unset", async () => {
    expect(await resolveHooksDir(repo.root, gitDir)).toBe(path.join(gitDir, "hooks"));
  });

  it("resolves a relative core.hooksPath against the repo root", async () => {
    await repo.git("config", "core.hooksPath", ".husky");
    expect(await resolveHooksDir(repo.root, gitDir)).toBe(path.join(repo.root, ".husky"));
  });

  it("resolves an absolute core.hooksPath as-is", async () => {
    const abs = path.join(repo.root, "custom-hooks");
    await repo.git("config", "core.hooksPath", abs);
    expect(await resolveHooksDir(repo.root, gitDir)).toBe(path.resolve(abs));
  });

  it("resolves core.hooksPath set to the repo root itself", async () => {
    await repo.git("config", "core.hooksPath", ".");
    expect(await resolveHooksDir(repo.root, gitDir)).toBe(path.resolve(repo.root));
  });
});

describe("runPreCommitHook", () => {
  it("is 'none' when no hook is configured at all", async () => {
    expect(await runPreCommitHook(repo.root, gitDir)).toEqual({ kind: "none" });
  });

  it.runIf(isPosix)("is 'none' when the pre-commit file is not executable", async () => {
    await repo.write(".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
    expect(await runPreCommitHook(repo.root, gitDir)).toEqual({ kind: "none" });
  });

  it.runIf(isPosix)("is 'pass' when the hook exits zero", async () => {
    await writeHook(".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
    expect(await runPreCommitHook(repo.root, gitDir)).toEqual({ kind: "pass" });
  });

  it.runIf(isPosix)("is 'pass' with no output at all (empty hook)", async () => {
    await writeHook(".git/hooks/pre-commit", "#!/bin/sh\n");
    expect(await runPreCommitHook(repo.root, gitDir)).toEqual({ kind: "pass" });
  });

  it.runIf(isPosix)("is 'fail' with the hook's combined stdout+stderr when it exits non-zero", async () => {
    await writeHook(
      ".git/hooks/pre-commit",
      "#!/bin/sh\necho 'out message'\necho 'err message' >&2\nexit 1\n",
    );
    const outcome = await runPreCommitHook(repo.root, gitDir);
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.output).toContain("out message");
      expect(outcome.output).toContain("err message");
    }
  });

  it.runIf(isPosix)("is 'fail' with empty output when the hook exits non-zero silently", async () => {
    await writeHook(".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n");
    expect(await runPreCommitHook(repo.root, gitDir)).toEqual({ kind: "fail", output: "" });
  });

  it.runIf(isPosix)("honors a relative core.hooksPath (e.g. a Husky-style directory)", async () => {
    await repo.git("config", "core.hooksPath", ".husky");
    await writeHook(".husky/pre-commit", "#!/bin/sh\nexit 1\n");
    const outcome = await runPreCommitHook(repo.root, gitDir);
    expect(outcome).toEqual({ kind: "fail", output: "" });
  });

  it("does not throw when core.hooksPath points at a file, not a directory", async () => {
    await repo.write("not-a-dir", "just a file\n");
    await repo.git("config", "core.hooksPath", "not-a-dir");
    await expect(runPreCommitHook(repo.root, gitDir)).resolves.toEqual({ kind: "none" });
  });

  it("treats a directory named 'pre-commit' as no hook, not a crash", async () => {
    await fs.mkdir(path.join(gitDir, "hooks", "pre-commit"), { recursive: true });
    await expect(runPreCommitHook(repo.root, gitDir)).resolves.toEqual({ kind: "none" });
  });

  it("does not pick up a differently-cased or extensioned file", async () => {
    await writeHook(".git/hooks/Pre-Commit", "#!/bin/sh\nexit 1\n");
    await writeHook(".git/hooks/pre-commit.sh", "#!/bin/sh\nexit 1\n");
    expect(await runPreCommitHook(repo.root, gitDir)).toEqual({ kind: "none" });
  });

  it.runIf(isPosix)("runs with cwd at the repo root", async () => {
    await writeHook(".git/hooks/pre-commit", "#!/bin/sh\npwd\nexit 1\n");
    const outcome = await runPreCommitHook(repo.root, gitDir);
    expect(outcome.kind).toBe("fail");
    if (outcome.kind === "fail") {
      expect(outcome.output).toContain(await fs.realpath(repo.root));
    }
  });
});
