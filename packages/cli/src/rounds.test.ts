import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewStore, TestRepo, type Review } from "@reviewgate/core";
import { readServerRecord } from "@reviewgate/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Meerdere rondes per review (§13, M5). De acceptatie-eis: een comment uit ronde 1
 * die door de fix van Claude verschoven is, staat in ronde 2 op de juiste regel.
 */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/reviewgate.mjs");

let repo: TestRepo;

const RONDE_1 = [
  "export function handle(order) {",
  "  const key = `order:${order.id}`;",
  "  cache.forget(key);",
  "  return order;",
  "}",
  "",
].join("\n");

/** De fix voegt vijf regels bóven de becommentarieerde regel toe. */
const RONDE_2 = [
  "function guard(order) {",
  "  if (!order) throw new Error('geen order');",
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
  await repo.commit("basis");
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
  // Ruim bemeten: onder een volle testsuite draaien meerdere hooks tegelijk.
  for (let i = 0; i < 600; i++) {
    const [review] = await store().list();
    if (review && review.rounds.length >= n) return review;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`ronde ${n} kwam er niet`);
}

async function session(): Promise<{ port: number; id: string; token: string }> {
  const record = await readServerRecord(path.join(repo.root, ".git"));
  if (!record) throw new Error("geen server.json");
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

describe("rondes", () => {
  it("verplaatst een comment uit ronde 1 mee naar zijn nieuwe regel in ronde 2", async () => {
    // Ronde 1: comment op regel 3, dan changes requested.
    await repo.write("service.ts", RONDE_1);
    await repo.addAll();
    const eerste = runHook('git commit -m "fix: cache"');
    await waitForRound(1);

    const created = await call("/comments", {
      scope: "line",
      body: "hier ontbreekt de tag-variant",
      path: "service.ts",
      side: "new",
      startLine: 3,
      anchorSnippet: "  cache.forget(key);",
    });
    expect(created.status).toBe(200);
    await call("/decision", { decision: "request_changes", summary: "eerst de invalidatie" });

    const verdict = JSON.parse(await eerste) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(verdict.hookSpecificOutput.permissionDecision).toBe("deny");

    // Ronde 2: de fix schuift de regel vijf omlaag.
    await repo.write("service.ts", RONDE_2);
    await repo.addAll();
    const tweede = runHook('git commit -m "fix: cache, met guard"');
    const review = await waitForRound(2);

    expect(review.rounds).toHaveLength(2);
    expect(review.rounds[1]?.n).toBe(2);
    expect(review.comments).toHaveLength(1);
    // Regel 3 is regel 8 geworden, en de comment staat daar nu ook.
    expect(review.comments[0]).toMatchObject({ startLine: 8, status: "open", round: 1 });

    await call("/decision", { decision: "request_changes" });
    const tweedeVerdict = JSON.parse(await tweede) as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    const reason = tweedeVerdict.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("(ronde 2)");
    expect(reason).toContain("L8: hier ontbreekt de tag-variant");
    expect(reason).toContain("## Nog open uit eerdere rondes");
  }, 120_000);

  it("markeert een comment als verouderd wanneer de regel verdwenen is", async () => {
    await repo.write("service.ts", RONDE_1);
    await repo.addAll();
    const eerste = runHook('git commit -m "fix: cache"');
    await waitForRound(1);

    await call("/comments", {
      scope: "line",
      body: "deze regel klopt niet",
      path: "service.ts",
      side: "new",
      startLine: 3,
      anchorSnippet: "  cache.forget(key);",
    });
    await call("/decision", { decision: "request_changes" });
    await eerste;

    // De regel is helemaal weg in ronde 2.
    await repo.write("service.ts", "export function handle(order) {\n  return order;\n}\n");
    await repo.addAll();
    const tweede = runHook('git commit -m "fix: regel weg"');
    const review = await waitForRound(2);

    expect(review.comments[0]?.status).toBe("outdated");

    // Verouderd telt niet meer mee, dus approve mag weer.
    const res = await call("/decision", { decision: "approve" });
    expect(res.status).toBe(200);
    const verdict = JSON.parse(await tweede) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(verdict.hookSpecificOutput.permissionDecision).toBe("allow");
  }, 120_000);
});
