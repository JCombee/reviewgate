import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "./exec.js";

/**
 * A throwaway git repo for integration tests. All config lives locally in the repo,
 * so the tests do not depend on the global gitconfig of the machine they run on.
 */
export class TestRepo {
  private constructor(readonly root: string) {}

  static async create(prefix = "reviewgate-test-"): Promise<TestRepo> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    // macOS hands out /var, which is a symlink to /private/var; git reports the
    // resolved path. Resolve it here so path comparisons hold.
    const root = await fs.realpath(dir);

    await runGit(["init", "--initial-branch=main", "."], { cwd: root });
    await runGit(["config", "user.name", "ReviewGate Test"], { cwd: root });
    await runGit(["config", "user.email", "test@example.invalid"], { cwd: root });
    await runGit(["config", "commit.gpgsign", "false"], { cwd: root });
    await runGit(["config", "core.autocrlf", "false"], { cwd: root });
    return new TestRepo(root);
  }

  async write(relPosix: string, content: string): Promise<void> {
    const abs = this.abs(relPosix);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  async writeBinary(relPosix: string, bytes: Uint8Array): Promise<void> {
    const abs = this.abs(relPosix);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
  }

  async remove(relPosix: string): Promise<void> {
    await fs.rm(this.abs(relPosix), { force: true });
  }

  async rename(fromPosix: string, toPosix: string): Promise<void> {
    const to = this.abs(toPosix);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(this.abs(fromPosix), to);
  }

  async git(...args: string[]): Promise<string> {
    const { stdout } = await runGit(args, { cwd: this.root });
    return stdout;
  }

  async add(...paths: string[]): Promise<void> {
    await this.git("add", "--", ...paths);
  }

  async addAll(): Promise<void> {
    await this.git("add", "-A");
  }

  async commit(message: string): Promise<void> {
    await this.git("commit", "-m", message);
  }

  abs(relPosix: string): string {
    return path.resolve(this.root, relPosix.split("/").join(path.sep));
  }

  async cleanup(): Promise<void> {
    // Windows sometimes holds on to packfiles for a moment; maxRetries covers that.
    await fs.rm(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
