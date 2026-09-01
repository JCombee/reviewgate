import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "./exec.js";

/**
 * Wegwerp-git-repo voor integratietests. Alle config staat lokaal in de repo, zodat
 * de tests niet afhangen van de globale gitconfig van de machine waarop ze draaien.
 */
export class TestRepo {
  private constructor(readonly root: string) {}

  static async create(prefix = "reviewgate-test-"): Promise<TestRepo> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    // macOS levert /var, dat een symlink naar /private/var is; git rapporteert het
    // opgeloste pad. Los het hier op zodat padvergelijkingen kloppen.
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
    // Windows houdt packfiles soms nog even vast; maxRetries vangt dat af.
    await fs.rm(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
