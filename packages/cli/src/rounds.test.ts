import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewStore, TestRepo, type Review } from "@reviewgate/core";
import { readServerRecord } from "@reviewgate/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Several rounds per review (§13, M5). The acceptance requirement: a comment from
 * round 1 that Claude's fix shifted sits on the right line in round 2.
 */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/reviewgate.mjs");

let repo: TestRepo;

const ROUND_1 = [
  "export function handle(order) {",
  "  const key = `order:${order.id}`;",
  "  cache.forget(key);",
  "  return order;",
  "}",
  "",
].join("\n");

/** The fix adds five lines above the commented line. */
const ROUND_2 = [
  "function guard(order) {",
  "  if (!order) throw new Error('no order');",
  "  return order;",
  "}",
  "",
  "export function handle(order) {",
  "  const key = `order:${order.id}`;",
  "  cache.forget(key);",
  "  return order;",
  "}",
  "",
].join("\n");

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.write("service.ts", "export const leeg = true;\n");
  await repo.addAll();
  await repo.commit("base");
});

afterEach(async () => {
  await repo.cleanup();
});

function runHook(command: string): Promise<string> {
  const child = spawn(process.execPath, [CLI, "hook"], {
    cwd: repo.root,
    windowsHide: true,
    env: { ...process.env, REVIEWGATE_NO_OPEN: "1", REVIEWGATE_AUTO_REVIEW: "0" },
  });
  child.stdin.end(
    JSON.stringify({
      tool_name: "Bash",
      cwd: repo.root,
      tool_input: { command },
    }),
  );
  let stdout = "";
  child.stdout.on("data", (c) => {
    stdout += String(c);
  });
  return new Promise((resolve) => child.on("close", () => resolve(stdout)));
}

const store = () => new ReviewStore(path.join(repo.root, ".git"));

async function waitForRound(n: number): Promise<Review> {
  // Generously sized: under a full test suite several hooks run at once.
  for (let i = 0; i < 600; i++) {
    const [review] = await store().list();
    if (review && review.rounds.length >= n) return review;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`round ${n} never arrived`);
}

async function session(): Promise<{ port: number; id: string; token: string }> {
  const record = await readServerRecord(path.join(repo.root, ".git"));
  if (!record) throw new Error("no server.json");
  const res = await fetch(`http://127.0.0.1:${record.port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${record.serverToken}` },
    body: JSON.stringify({ scope: "staged", cwd: repo.root }),
  });
  const data = (await res.json()) as { id: string; token: string };
  return { port: record.port, ...data };
}

async function call(path: string, body: unknown): Promise<Response> {
  const s = await session();
  return fetch(`http://127.0.0.1:${s.port}/api/review/${s.id}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
    body: JSON.stringify(body),
  });
}

describe("rounds", () => {
  it("moves a comment from round 1 along to its new line in round 2", async () => {
    // Round 1: a comment on line 3, then changes requested.
    await repo.write("service.ts", ROUND_1);
    await repo.addAll();
    const first = runHook('git commit -m "fix: cache"');
    await waitForRound(1);

    const created = await call("/comments", {
      scope: "line",
      body: "the tag variant is missing here",
      path: "service.ts",
      side: "new",
      startLine: 3,
      anchorSnippet: "  cache.forget(key);",
    });
    expect(created.status).toBe(200);
    await call("/decision", { decision: "request_changes", summary: "the invalidation first" });

    const verdict = JSON.parse(await first) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(verdict.hookSpecificOutput.permissionDecision).toBe("deny");

    // Round 2: the fix pushes the line five down.
    await repo.write("service.ts", ROUND_2);
    await repo.addAll();
    const second = runHook('git commit -m "fix: cache, with a guard"');
    const review = await waitForRound(2);

    expect(review.rounds).toHaveLength(2);
    expect(review.rounds[1]?.n).toBe(2);
    expect(review.comments).toHaveLength(1);
    // Line 3 has become line 8, and the comment now sits there too.
    expect(review.comments[0]).toMatchObject({ startLine: 8, status: "open", round: 1 });

    await call("/decision", { decision: "request_changes" });
    const secondVerdict = JSON.parse(await second) as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    const reason = secondVerdict.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("(round 2)");
    expect(reason).toContain("L8: the tag variant is missing here");
    expect(reason).toContain("## Still open from earlier rounds");
  }, 120_000);

  it("marks a comment as outdated when the line is gone", async () => {
    await repo.write("service.ts", ROUND_1);
    await repo.addAll();
    const first = runHook('git commit -m "fix: cache"');
    await waitForRound(1);

    await call("/comments", {
      scope: "line",
      body: "this line is wrong",
      path: "service.ts",
      side: "new",
      startLine: 3,
      anchorSnippet: "  cache.forget(key);",
    });
    await call("/decision", { decision: "request_changes" });
    await first;

    // The line is gone entirely in round 2.
    await repo.write("service.ts", "export function handle(order) {\n  return order;\n}\n");
    await repo.addAll();
    const second = runHook('git commit -m "fix: line removed"');
    const review = await waitForRound(2);

    expect(review.comments[0]?.status).toBe("outdated");

    // Outdated no longer counts, so approve is allowed again.
    const res = await call("/decision", { decision: "approve" });
    expect(res.status).toBe(200);
    const verdict = JSON.parse(await second) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(verdict.hookSpecificOutput.permissionDecision).toBe("allow");
  }, 120_000);
});
