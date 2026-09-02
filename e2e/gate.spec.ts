import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * End to end over the whole chain (§14): a real repo, the blocking hook, the browser
 * UI, and the verdict the hook hands back on stdout.
 *
 * One happy path (comment → the button switches → request changes → deny with the
 * right markdown) and one approve path.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "packages", "cli", "bin", "reviewgate.mjs");

const BASE = [
  "export function handle(order) {",
  "  const key = `order:${order.id}`;",
  "  cache.forget(key);",
  "  return order;",
  "}",
  "",
].join("\n");

const CHANGED = [
  "export function handle(order) {",
  "  const key = `order:${order.id}`;",
  "  cache.forget(key);",
  '  cache.tags(["orders"]).forget(key);',
  "  return order;",
  "}",
  "",
].join("\n");

interface Gate {
  repo: string;
  url: string;
  verdict: Promise<{ permissionDecision: string; permissionDecisionReason: string }>;
  cleanup: () => Promise<void>;
}

async function git(repo: string, ...args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd: repo, windowsHide: true });
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args[0]} → ${code}`)),
    );
    child.on("error", reject);
  });
}

/** Sets up a repo with a staged change and starts the hook on it. */
async function openGate(): Promise<Gate> {
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reviewgate-e2e-")));

  await git(repo, "init", "--initial-branch=main", ".");
  await git(repo, "config", "user.name", "ReviewGate E2E");
  await git(repo, "config", "user.email", "e2e@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");

  await fs.writeFile(path.join(repo, "service.ts"), BASE, "utf8");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "base");

  await fs.writeFile(path.join(repo, "service.ts"), CHANGED, "utf8");
  await git(repo, "add", "-A");

  const child: ChildProcess = spawn(process.execPath, [CLI, "hook"], {
    cwd: repo,
    windowsHide: true,
    env: {
      ...process.env,
      REVIEWGATE_NO_OPEN: "1",
      // The automatic pass needs auth and is not part of this path.
      REVIEWGATE_AUTO_REVIEW: "0",
      REVIEWGATE_TIMEOUT_MS: "90000",
    },
  });
  child.stdin?.end(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "e2e",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "fix: invalidate the cache"' },
    }),
  );

  let stdout = "";
  child.stdout?.on("data", (c) => {
    stdout += String(c);
  });
  const verdict = new Promise<{ permissionDecision: string; permissionDecisionReason: string }>(
    (resolve, reject) => {
      child.on("close", () => {
        try {
          resolve(JSON.parse(stdout).hookSpecificOutput);
        } catch (err) {
          reject(new Error(`unexpected hook output: ${stdout}\n${String(err)}`));
        }
      });
    },
  );

  // The hook starts the server and only then writes the review; wait for server.json.
  const record = await waitForServerRecord(repo);
  const session = await createSession(record, repo);

  return {
    repo,
    url: `http://127.0.0.1:${record.port}/r/${session.id}?token=${session.token}`,
    verdict,
    cleanup: async () => {
      // A test that makes no decision leaves the hook waiting in its timeout; we finish
      // it off and then ignore the verdict that no longer matters.
      verdict.catch(() => {});
      child.kill();
      await fs.rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

async function waitForServerRecord(
  repo: string,
): Promise<{ port: number; serverToken: string }> {
  const file = path.join(repo, ".git", "reviewgate", "server.json");
  for (let i = 0; i < 300; i++) {
    try {
      const rec = JSON.parse(await fs.readFile(file, "utf8")) as {
        port: number;
        serverToken: string;
      };
      const res = await fetch(`http://127.0.0.1:${rec.port}/healthz`).catch(() => null);
      if (res?.ok) return rec;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the hook started no server");
}

/**
 * The hook creates its own session; we open a second one on the same diff. That hangs
 * off the same persistent review, so the decision lands in the right place.
 */
async function createSession(
  record: { port: number; serverToken: string },
  repo: string,
): Promise<{ id: string; token: string }> {
  const res = await fetch(`http://127.0.0.1:${record.port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${record.serverToken}` },
    body: JSON.stringify({ scope: "staged", cwd: repo }),
  });
  return (await res.json()) as { id: string; token: string };
}

const primary = (page: Page) => page.locator("button[data-decision]");

test("happy path: place a comment, the button switches, request changes reaches the hook", async ({
  page,
}) => {
  const gate = await openGate();
  try {
    await page.goto(gate.url);
    await page.waitForSelector("[data-file-index]");

    // Without comments, Approve is the primary action.
    await expect(primary(page)).toHaveAttribute("data-decision", "approve");
    await expect(primary(page)).toHaveText("Approve");

    // A comment on the added line.
    await page.locator('.rg-gutter-clickable[data-side="new"][data-line="4"]').click();
    await page
      .locator("[data-comment-form] textarea")
      .fill("this invalidation path misses the tag variant");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.waitForSelector("[data-comment-id]");

    // The button switches role live.
    await expect(primary(page)).toHaveAttribute("data-decision", "request_changes");
    await expect(primary(page)).toHaveText("Request changes");

    await page.locator("input[aria-label='Summary']").fill("sort out the cache invalidation first");
    await primary(page).click();
    await expect(page.locator("footer")).toContainText("Changes requested");

    const verdict = await gate.verdict;
    expect(verdict.permissionDecision).toBe("deny");
    expect(verdict.permissionDecisionReason).toContain("# Code review: changes requested (round 1)");
    expect(verdict.permissionDecisionReason).toContain(
      "## Summary\n\nsort out the cache invalidation first",
    );
    expect(verdict.permissionDecisionReason).toContain("## service.ts");
    expect(verdict.permissionDecisionReason).toContain(
      "- L4: this invalidation path misses the tag variant",
    );
  } finally {
    await gate.cleanup();
  }
});

test("approve path: without open comments the hook lets the commit through", async ({ page }) => {
  const gate = await openGate();
  try {
    await page.goto(gate.url);
    await page.waitForSelector("[data-file-index]");

    await page.locator("input[aria-label='Summary']").fill("the shape holds");
    await primary(page).click();
    await expect(page.locator("footer")).toContainText("Approved");

    const verdict = await gate.verdict;
    expect(verdict.permissionDecision).toBe("allow");

    // No artifact is left: the hook has spent its approval.
    const approved = path.join(gate.repo, ".git", "reviewgate", "approved");
    const rest = await fs.readdir(approved).catch(() => []);
    expect(rest).toEqual([]);
  } finally {
    await gate.cleanup();
  }
});

test("approve is impossible while a comment is open", async ({ page }) => {
  const gate = await openGate();
  try {
    await page.goto(gate.url);
    await page.waitForSelector("[data-file-index]");

    await page.locator('.rg-gutter-clickable[data-side="new"][data-line="4"]').click();
    await page.locator("[data-comment-form] textarea").fill("something is off here");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.waitForSelector("[data-comment-id]");

    // There is no second button and no escape hatch: Request changes is the only thing
    // you can do (§8).
    await expect(page.locator("button[data-decision]")).toHaveCount(1);
    await expect(primary(page)).toHaveText("Request changes");

    // The server refuses an approve directly as well.
    const url = new URL(gate.url);
    const id = url.pathname.split("/").pop() as string;
    const token = url.searchParams.get("token") as string;
    const res = await fetch(`${url.origin}/api/review/${id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { openCommentIds: string[] };
    expect(body.openCommentIds).toHaveLength(1);

    // Resolving puts the button back on Approve.
    await page.getByRole("button", { name: "Resolve" }).click();
    await expect(primary(page)).toHaveAttribute("data-decision", "approve");
  } finally {
    await gate.cleanup();
  }
});
