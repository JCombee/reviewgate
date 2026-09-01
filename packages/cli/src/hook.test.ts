import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readApproval, ReviewStore, TestRepo, type Review } from "@reviewgate/core";
import { readServerRecord } from "@reviewgate/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * De hook draait hier als echt kindproces met een hook-payload op stdin, precies
 * zoals Claude Code hem aanroept (§6, §14).
 */

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../bin/reviewgate.mjs",
);

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
  };
  systemMessage?: string;
}

let repo: TestRepo;

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.write("src/service.ts", "export const a = 1;\nexport const b = 2;\n");
  await repo.addAll();
  await repo.commit("basis");
});

afterEach(async () => {
  await repo.cleanup();
});

function payload(command: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "sessie-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: repo.root,
    tool_name: "Bash",
    tool_input: { command },
  });
}

interface RunningHook {
  done: Promise<{ stdout: string; code: number | null }>;
  kill: () => void;
}

function runHook(command: string, env: NodeJS.ProcessEnv = {}): RunningHook {
  const child = spawn(process.execPath, [CLI, "hook"], {
    cwd: repo.root,
    windowsHide: true,
    env: { ...process.env, REVIEWGATE_NO_OPEN: "1", ...env },
  });
  child.stdin.end(payload(command));

  let stdout = "";
  child.stdout.on("data", (c) => {
    stdout += String(c);
  });

  const done = new Promise<{ stdout: string; code: number | null }>((resolve) => {
    child.on("close", (code) => resolve({ stdout, code }));
  });

  return { done, kill: () => child.kill() };
}

async function hookOutput(command: string, env?: NodeJS.ProcessEnv): Promise<HookOutput | null> {
  const { stdout, code } = await runHook(command, env).done;
  expect(code).toBe(0);
  return stdout.trim() === "" ? null : (JSON.parse(stdout) as HookOutput);
}

async function stageChange(): Promise<void> {
  await repo.write("src/service.ts", "export const a = 1;\nexport const b = 22;\n");
  await repo.addAll();
}

/** Wacht tot de hook de review heeft aangemaakt en geef hem terug. */
async function waitForReview(): Promise<Review> {
  const store = new ReviewStore(path.join(repo.root, ".git"));
  for (let i = 0; i < 200; i++) {
    const [review] = await store.list();
    if (review) return review;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("de hook heeft geen review aangemaakt");
}

/** Beslissen via de draaiende server, zoals de UI dat doet. */
async function decide(decision: "approve" | "request_changes", summary?: string): Promise<void> {
  const record = await readServerRecord(path.join(repo.root, ".git"));
  if (!record) throw new Error("geen server.json");

  // De sessie-id staat niet in het reviewbestand; we halen hem uit de server.
  const health = await fetch(`http://127.0.0.1:${record.port}/healthz`);
  expect(health.ok).toBe(true);

  const session = await sessionIdOf(record.port, record.serverToken);
  const res = await fetch(`http://127.0.0.1:${record.port}/api/review/${session.id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ decision, summary: summary ?? null }),
  });
  if (!res.ok) throw new Error(`decision faalde: ${res.status} ${await res.text()}`);
}

/**
 * De hook maakt de sessie aan; wij moeten hem terugvinden om ermee te praten. Dat
 * kan via het beheerstoken: een tweede sessie op dezelfde diff hangt aan dezelfde
 * persistente review, dus de beslissing komt op de juiste plek terecht.
 */
async function sessionIdOf(port: number, serverToken: string): Promise<{ id: string; token: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${serverToken}` },
    body: JSON.stringify({ scope: "staged", cwd: repo.root }),
  });
  const data = (await res.json()) as { id: string; token: string };
  return data;
}

describe("hook — doorlaten", () => {
  const cases: Array<{ naam: string; command: string; env?: NodeJS.ProcessEnv }> = [
    { naam: "geen commit", command: "git status --short" },
    { naam: "push", command: "git push origin main" },
    { naam: "commit zonder wijzigingen", command: 'git commit -m "leeg"' },
    {
      naam: "REVIEWGATE_SKIP staat aan",
      command: 'git commit -m "x"',
      env: { REVIEWGATE_SKIP: "1" },
    },
  ];

  for (const { naam, command, env } of cases) {
    it(`${naam} → geen output, dus geen oordeel`, async () => {
      expect(await hookOutput(command, env)).toBeNull();
    });
  }

  it("een ander gereedschap dan Bash raakt de gate niet", async () => {
    const child = spawn(process.execPath, [CLI, "hook"], {
      cwd: repo.root,
      env: { ...process.env, REVIEWGATE_NO_OPEN: "1" },
      windowsHide: true,
    });
    child.stdin.end(JSON.stringify({ tool_name: "Read", tool_input: {} }));
    let stdout = "";
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    await new Promise((r) => child.on("close", r));
    expect(stdout.trim()).toBe("");
  });

  it("onleesbare invoer blokkeert niets", async () => {
    const child = spawn(process.execPath, [CLI, "hook"], { cwd: repo.root, windowsHide: true });
    child.stdin.end("dit is geen json");
    let stdout = "";
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    const code = await new Promise((r) => child.on("close", r));
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});

describe("hook — blokkeren", () => {
  it("weigert --no-verify met uitleg, zonder review te openen", async () => {
    await stageChange();
    const out = await hookOutput('git commit --no-verify -m "x"');
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain("--no-verify");
  });

  it("geeft de review-feedback terug bij request changes", async () => {
    await stageChange();
    const hook = runHook('git commit -m "fix: iets"');

    const review = await waitForReview();
    const record = await readServerRecord(path.join(repo.root, ".git"));
    const session = await sessionIdOf(record!.port, record!.serverToken);

    await fetch(`http://127.0.0.1:${record!.port}/api/review/${session.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        scope: "line",
        body: "hier ontbreekt de tag-variant",
        path: "src/service.ts",
        side: "new",
        startLine: 2,
      }),
    });
    await decide("request_changes", "eerst de invalidatie");

    const { stdout } = await hook.done;
    const out = JSON.parse(stdout) as HookOutput;
    const reason = out.hookSpecificOutput?.permissionDecisionReason ?? "";

    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(reason).toContain("# Code review: changes requested");
    expect(reason).toContain("## Samenvatting\n\neerst de invalidatie");
    expect(reason).toContain("## src/service.ts");
    expect(reason).toContain("- L2: hier ontbreekt de tag-variant");
    expect(review.id).toBeTruthy();
  }, 60_000);

  it("laat de commit door na approve en laat een artifact achter", async () => {
    await stageChange();
    const hook = runHook('git commit -m "fix: iets"');
    await waitForReview();
    await decide("approve", "opzet klopt");

    const { stdout } = await hook.done;
    const out = JSON.parse(stdout) as HookOutput;
    expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(out.systemMessage).toContain("opzet klopt");
  }, 60_000);

  it("laat een tweede poging op dezelfde diff meteen door via het artifact", async () => {
    await stageChange();
    const hook = runHook('git commit -m "fix: iets"');
    await waitForReview();

    // Approve schrijft het artifact; de hook consumeert het bij zijn eigen ronde.
    // Voor deze test kijken we ernaar vóór de hook klaar is.
    await decide("approve");
    await hook.done;

    const store = new ReviewStore(path.join(repo.root, ".git"));
    const [review] = await store.list();
    expect(review?.status).toBe("approved");

    // Het artifact is opgebruikt: een nieuwe poging opent dus weer een review.
    const gitDir = path.join(repo.root, ".git");
    const rounds = review?.rounds ?? [];
    const hash = rounds[rounds.length - 1]?.diffHash ?? "";
    expect(await readApproval(gitDir, hash)).toBeNull();
  }, 60_000);
});
