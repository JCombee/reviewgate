import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readApproval, ReviewStore, TestRepo, type Review } from "@reviewgate/core";
import { readServerRecord } from "@reviewgate/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Here the hook runs as a real child process with a hook payload on stdin, exactly
 * the way Claude Code invokes it (§6, §14).
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
  await repo.commit("base");
});

afterEach(async () => {
  await repo.cleanup();
});

function payload(command: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "session-1",
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

/** Waits until the hook has created the review, then returns it. */
async function waitForReview(): Promise<Review> {
  const store = new ReviewStore(path.join(repo.root, ".git"));
  for (let i = 0; i < 200; i++) {
    const [review] = await store.list();
    if (review) return review;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the hook created no review");
}

/** Decide through the running server, the way the UI does. */
async function decide(decision: "approve" | "request_changes", summary?: string): Promise<void> {
  const record = await readServerRecord(path.join(repo.root, ".git"));
  if (!record) throw new Error("no server.json");

  // The session id is not in the review file; we get it from the server.
  const health = await fetch(`http://127.0.0.1:${record.port}/healthz`);
  expect(health.ok).toBe(true);

  const session = await sessionIdOf(record.port, record.serverToken);
  const res = await fetch(`http://127.0.0.1:${record.port}/api/review/${session.id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ decision, summary: summary ?? null }),
  });
  if (!res.ok) throw new Error(`decision failed: ${res.status} ${await res.text()}`);
}

/**
 * The hook creates the session; we have to find it again to talk to it. The admin
 * token lets us: a second session on the same diff hangs off the same persistent
 * review, so the decision lands in the right place.
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

describe("hook — letting through", () => {
  const cases: Array<{ name: string; command: string; env?: NodeJS.ProcessEnv }> = [
    { name: "not a commit", command: "git status --short" },
    { name: "push", command: "git push origin main" },
    { name: "commit with no changes", command: 'git commit -m "empty"' },
    {
      name: "REVIEWGATE_SKIP is set",
      command: 'git commit -m "x"',
      env: { REVIEWGATE_SKIP: "1" },
    },
  ];

  for (const { name, command, env } of cases) {
    it(`${name} → no output, so no verdict`, async () => {
      expect(await hookOutput(command, env)).toBeNull();
    });
  }

  it("a tool other than Bash does not touch the gate", async () => {
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

  it("unreadable input blocks nothing", async () => {
    const child = spawn(process.execPath, [CLI, "hook"], { cwd: repo.root, windowsHide: true });
    child.stdin.end("this is not json");
    let stdout = "";
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    const code = await new Promise((r) => child.on("close", r));
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});

describe("hook — blocking", () => {
  it("refuses --no-verify with an explanation, without opening a review", async () => {
    await stageChange();
    const out = await hookOutput('git commit --no-verify -m "x"');
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain("--no-verify");
  });

  it("returns the review feedback on request changes", async () => {
    await stageChange();
    const hook = runHook('git commit -m "fix: something"');

    const review = await waitForReview();
    const record = await readServerRecord(path.join(repo.root, ".git"));
    const session = await sessionIdOf(record!.port, record!.serverToken);

    await fetch(`http://127.0.0.1:${record!.port}/api/review/${session.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        scope: "line",
        body: "the tag variant is missing here",
        path: "src/service.ts",
        side: "new",
        startLine: 2,
      }),
    });
    await decide("request_changes", "the invalidation first");

    const { stdout } = await hook.done;
    const out = JSON.parse(stdout) as HookOutput;
    const reason = out.hookSpecificOutput?.permissionDecisionReason ?? "";

    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(reason).toContain("# Code review: changes requested");
    expect(reason).toContain("## Summary\n\nthe invalidation first");
    expect(reason).toContain("## src/service.ts");
    expect(reason).toContain("- L2: the tag variant is missing here");
    expect(review.id).toBeTruthy();
  }, 60_000);

  it("lets the commit through after approve and leaves an artifact behind", async () => {
    await stageChange();
    const hook = runHook('git commit -m "fix: something"');
    await waitForReview();
    await decide("approve", "the shape holds");

    const { stdout } = await hook.done;
    const out = JSON.parse(stdout) as HookOutput;
    expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(out.systemMessage).toContain("the shape holds");
  }, 60_000);

  /**
   * The real case always has a browser attached, and that browser holds an SSE stream
   * open. The verdict is on stdout long before the process ends, and Claude Code waits
   * for the process — so a socket or a heartbeat timer that outlives the review shows
   * up as a commit that hangs for half a minute after you clicked Approve.
   */
  it("ends promptly after approve while the review page is watching", async () => {
    await stageChange();
    const hook = runHook('git commit -m "fix: something"');
    await waitForReview();

    const record = await readServerRecord(path.join(repo.root, ".git"));
    if (!record) throw new Error("no server.json");
    const watcher = await sessionIdOf(record.port, record.serverToken);
    const events = await fetch(
      `http://127.0.0.1:${record.port}/api/review/${watcher.id}/events?token=${watcher.token}`,
    );
    expect(events.ok).toBe(true);

    // Read the first frame, so the stream is really open. The next read sits on the
    // heartbeat.
    const reader = events.body!.getReader();
    await reader.read();

    await decide("approve");
    const started = Date.now();
    const { stdout } = await hook.done;
    const elapsed = Date.now() - started;

    const out = JSON.parse(stdout) as HookOutput;
    expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(elapsed).toBeLessThan(10_000);

    await reader.cancel().catch(() => {});
  }, 60_000);

  it("lets a second attempt on the same diff straight through via the artifact", async () => {
    await stageChange();
    const hook = runHook('git commit -m "fix: something"');
    await waitForReview();

    // Approve writes the artifact; the hook consumes it on its own round. For this
    // test we look at it before the hook is finished.
    await decide("approve");
    await hook.done;

    const store = new ReviewStore(path.join(repo.root, ".git"));
    const [review] = await store.list();
    expect(review?.status).toBe("approved");

    // The artifact is spent, so a fresh attempt opens a review again.
    const gitDir = path.join(repo.root, ".git");
    const rounds = review?.rounds ?? [];
    const hash = rounds[rounds.length - 1]?.diffHash ?? "";
    expect(await readApproval(gitDir, hash)).toBeNull();
  }, 60_000);
});
