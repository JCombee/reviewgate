import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end over de hele keten (§14): een echte repo, de blokkerende hook, de
 * browser-UI, en het oordeel dat de hook op stdout teruggeeft.
 *
 * Eén happy path (comment → knop wisselt → request changes → deny met de juiste
 * markdown) en één approve path.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "packages", "cli", "bin", "reviewgate.mjs");

const BASIS = [
  "export function handle(order) {",
  "  const key = `order:${order.id}`;",
  "  cache.forget(key);",
  "  return order;",
  "}",
  "",
].join("\n");

const GEWIJZIGD = [
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
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} → ${code}`))));
    child.on("error", reject);
  });
}

/** Zet een repo op met een gestagede wijziging en start de hook erop. */
async function openGate(): Promise<Gate> {
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reviewgate-e2e-")));

  await git(repo, "init", "--initial-branch=main", ".");
  await git(repo, "config", "user.name", "ReviewGate E2E");
  await git(repo, "config", "user.email", "e2e@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");

  await fs.writeFile(path.join(repo, "service.ts"), BASIS, "utf8");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "basis");

  await fs.writeFile(path.join(repo, "service.ts"), GEWIJZIGD, "utf8");
  await git(repo, "add", "-A");

  const child: ChildProcess = spawn(process.execPath, [CLI, "hook"], {
    cwd: repo,
    windowsHide: true,
    env: {
      ...process.env,
      REVIEWGATE_NO_OPEN: "1",
      // De automatische pass heeft auth nodig en hoort niet bij dit pad.
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
      tool_input: { command: 'git commit -m "fix: cache invalideren"' },
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
          reject(new Error(`onverwachte hook-uitvoer: ${stdout}\n${String(err)}`));
        }
      });
    },
  );

  // De hook start de server en schrijft dan pas de review; wachten op server.json.
  const record = await waitForServerRecord(repo);
  const session = await createSession(record, repo);

  return {
    repo,
    url: `http://127.0.0.1:${record.port}/r/${session.id}?token=${session.token}`,
    verdict,
    cleanup: async () => {
      // Een test die geen beslissing neemt laat de hook in zijn timeout hangen; we
      // maken hem af en negeren dan het oordeel dat er niet meer toe doet.
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
      // nog niet geschreven
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("de hook heeft geen server gestart");
}

/**
 * De hook maakt zijn eigen sessie aan; wij openen een tweede op dezelfde diff. Die
 * hangt aan dezelfde persistente review, dus de beslissing komt op de juiste plek.
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

test("happy path: comment plaatsen, knop wisselt, request changes komt terug in de hook", async ({
  page,
}) => {
  const gate = await openGate();
  try {
    await page.goto(gate.url);
    await page.waitForSelector("[data-file-index]");

    // Zonder comments is Approve de primaire actie.
    await expect(primary(page)).toHaveAttribute("data-decision", "approve");
    await expect(primary(page)).toHaveText("Approve");

    // Comment op de toegevoegde regel.
    await page.locator('.rg-gutter-clickable[data-side="new"][data-line="4"]').click();
    await page.locator("[data-comment-form] textarea").fill("dit invalidatie-pad mist de tag-variant");
    await page.getByRole("button", { name: "Plaats" }).click();
    await page.waitForSelector("[data-comment-id]");

    // De knop wisselt live van rol.
    await expect(primary(page)).toHaveAttribute("data-decision", "request_changes");
    await expect(primary(page)).toHaveText("Request changes");

    await page.locator("input[aria-label='Samenvatting']").fill("los eerst de cache-invalidatie op");
    await primary(page).click();
    await expect(page.locator("footer")).toContainText("Changes requested");

    const verdict = await gate.verdict;
    expect(verdict.permissionDecision).toBe("deny");
    expect(verdict.permissionDecisionReason).toContain("# Code review: changes requested (ronde 1)");
    expect(verdict.permissionDecisionReason).toContain(
      "## Samenvatting\n\nlos eerst de cache-invalidatie op",
    );
    expect(verdict.permissionDecisionReason).toContain("## service.ts");
    expect(verdict.permissionDecisionReason).toContain(
      "- L4: dit invalidatie-pad mist de tag-variant",
    );
  } finally {
    await gate.cleanup();
  }
});

test("approve path: zonder openstaande comments laat de hook de commit door", async ({ page }) => {
  const gate = await openGate();
  try {
    await page.goto(gate.url);
    await page.waitForSelector("[data-file-index]");

    await page.locator("input[aria-label='Samenvatting']").fill("opzet klopt");
    await primary(page).click();
    await expect(page.locator("footer")).toContainText("Goedgekeurd");

    const verdict = await gate.verdict;
    expect(verdict.permissionDecision).toBe("allow");

    // Er ligt geen artifact meer: de hook heeft zijn goedkeuring opgebruikt.
    const approved = path.join(gate.repo, ".git", "reviewgate", "approved");
    const rest = await fs.readdir(approved).catch(() => []);
    expect(rest).toEqual([]);
  } finally {
    await gate.cleanup();
  }
});

test("approve is onmogelijk zolang er een comment open staat", async ({ page }) => {
  const gate = await openGate();
  try {
    await page.goto(gate.url);
    await page.waitForSelector("[data-file-index]");

    await page.locator('.rg-gutter-clickable[data-side="new"][data-line="4"]').click();
    await page.locator("[data-comment-form] textarea").fill("hier klopt iets niet");
    await page.getByRole("button", { name: "Plaats" }).click();
    await page.waitForSelector("[data-comment-id]");

    // Er is geen tweede knop en geen escape hatch: Request changes is het enige
    // dat je kunt doen (§8).
    await expect(page.locator("button[data-decision]")).toHaveCount(1);
    await expect(primary(page)).toHaveText("Request changes");

    // De server weigert een approve ook rechtstreeks.
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

    // Resolven zet de knop terug op Approve.
    await page.getByRole("button", { name: "Resolve" }).click();
    await expect(primary(page)).toHaveAttribute("data-decision", "approve");
  } finally {
    await gate.cleanup();
  }
});
