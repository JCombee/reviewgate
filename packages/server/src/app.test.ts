import path from "node:path";
import { diffHash, NodeGitClient, readApproval, TestRepo } from "@reviewgate/core";
import type { Review, ReviewSummary, UpdateCheckResult } from "@reviewgate/core/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewAgent } from "./agent.js";
import { createApp, SessionStore } from "./app.js";
import { writeUpdateCheckCache } from "./lockfile.js";
import { Session } from "./session.js";

/**
 * Integration tests against a real temporary git repo (§14). We talk to the app
 * through `app.fetch` rather than over a socket: that is the same code as in
 * production, without ports and waiting.
 */

const SERVER_TOKEN = "server-token-for-tests";

let repo: TestRepo;
let gitDir: string;
let store: SessionStore;
let app: ReturnType<typeof createApp>;
let session: Session;

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function req(path: string, init: RequestInit = {}, token = session.token): Promise<Response> {
  return app.fetch(
    new Request(`http://127.0.0.1${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    }),
  );
}

const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });

beforeEach(async () => {
  repo = await TestRepo.create();
  await repo.write("src/service.ts", "export const a = 1;\nexport const b = 2;\n");
  await repo.addAll();
  await repo.commit("base");
  await repo.write("src/service.ts", "export const a = 1;\nexport const b = 22;\n");
  await repo.addAll();

  gitDir = path.join(repo.root, ".git");
  store = new SessionStore();
  app = createApp(
    { serverToken: SERVER_TOKEN, repoRoot: repo.root, version: "test", gitDir },
    store,
  );
  session = await Session.create(
    { git: await NodeGitClient.open(repo.root), scope: "staged", options: {} },
    store.highlighting,
  );
  store.add(session);
});

afterEach(async () => {
  await repo.cleanup();
});

describe("access", () => {
  it("refuses a request without a token", async () => {
    const res = await app.fetch(new Request(`http://127.0.0.1/api/review/${session.id}`));
    expect(res.status).toBe(403);
  });

  it("refuses a wrong token", async () => {
    const res = await req(`/api/review/${session.id}`, {}, "wrong-token");
    expect(res.status).toBe(403);
  });

  it("accepts the token from the query, the way the review URL carries it", async () => {
    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/review/${session.id}?token=${session.token}`),
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await req("/api/review/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("lets only the admin token create sessions", async () => {
    const bad = await post("/api/sessions", { scope: "staged" });
    expect(bad.status).toBe(403);

    const good = await req(
      "/api/sessions",
      {
        method: "POST",
        body: JSON.stringify({ scope: "staged", cwd: repo.root }),
      },
      SERVER_TOKEN,
    );
    expect(good.status).toBe(200);
  });
});

describe("summary", () => {
  it("carries the diff and the persistent review", async () => {
    const summary = await json<ReviewSummary>(await req(`/api/review/${session.id}`));
    expect(summary.files.map((f) => f.path)).toEqual(["src/service.ts"]);
    expect(summary.additions).toBe(1);
    expect(summary.review.rounds).toHaveLength(1);
    expect(summary.review.comments).toEqual([]);
    expect(summary.review.status).toBe("open");
  });
});

describe("comments", () => {
  const lineComment = {
    scope: "line",
    body: "the tag variant is missing here",
    path: "src/service.ts",
    side: "new",
    startLine: 2,
    anchorSnippet: "export const b = 22;",
  };

  it("places a line comment and returns the review", async () => {
    const res = await post(`/api/review/${session.id}/comments`, lineComment);
    expect(res.status).toBe(200);
    const { review } = await json<{ review: Review }>(res);
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({
      scope: "line",
      path: "src/service.ts",
      side: "new",
      startLine: 2,
      endLine: 2,
      status: "open",
      author: "user",
      round: 1,
    });
  });

  it("refuses a comment without text", async () => {
    const res = await post(`/api/review/${session.id}/comments`, { ...lineComment, body: " " });
    expect(res.status).toBe(400);
  });

  it("refuses a line comment without a line number", async () => {
    const { startLine: _drop, ...without } = lineComment;
    const res = await post(`/api/review/${session.id}/comments`, without);
    expect(res.status).toBe(400);
  });

  it("edits, replies, resolves and deletes", async () => {
    const created = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/comments`, lineComment),
    );
    const id = created.review.comments[0]?.id as string;

    const edited = await json<{ review: Review }>(
      await req(`/api/review/${session.id}/comments/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ body: "edited" }),
      }),
    );
    expect(edited.review.comments[0]?.body).toBe("edited");

    const replied = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/comments/${id}/replies`, { body: "agreed" }),
    );
    expect(replied.review.comments[0]?.replies).toHaveLength(1);

    const resolved = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/comments/${id}/resolve`, { resolved: true }),
    );
    expect(resolved.review.comments[0]?.status).toBe("resolved");

    const reopened = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/comments/${id}/resolve`, { resolved: false }),
    );
    expect(reopened.review.comments[0]?.status).toBe("open");

    const deleted = await json<{ review: Review }>(
      await req(`/api/review/${session.id}/comments/${id}`, { method: "DELETE" }),
    );
    expect(deleted.review.comments).toHaveLength(0);
  });

  it("returns 404 for an unknown comment", async () => {
    const res = await req(`/api/review/${session.id}/comments/unknown`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("keeps comments on disk, so they survive a restart", async () => {
    await post(`/api/review/${session.id}/comments`, lineComment);

    // A new session on the same diff is the same thing as a restart of the server.
    const second = await Session.create(
      { git: await NodeGitClient.open(repo.root), scope: "staged", options: {} },
      new SessionStore().highlighting,
    );
    expect(second.review.id).toBe(session.review.id);
    expect(second.review.comments).toHaveLength(1);
    expect(second.review.comments[0]).toMatchObject({
      path: "src/service.ts",
      startLine: 2,
      body: "the tag variant is missing here",
    });
  });
});

describe("commit message", () => {
  it("stores an adjusted message", async () => {
    const res = await req(`/api/review/${session.id}/commit-message`, {
      method: "PUT",
      body: JSON.stringify({ message: "fix(service): invalidate tags" }),
    });
    const { review } = await json<{ review: Review }>(res);
    expect(review.rounds[0]?.editedCommitMessage).toBe("fix(service): invalidate tags");
  });
});

describe("chat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a chat that appears in review.chats", async () => {
    const res = await post(`/api/review/${session.id}/chats`, { title: "Q&A" });
    expect(res.status).toBe(200);
    const { review } = await json<{ review: Review }>(res);
    expect(review.chats).toHaveLength(1);
    expect(review.chats[0]).toMatchObject({ title: "Q&A", model: null, messages: [] });
  });

  it("defaults the chat title and model when omitted", async () => {
    const res = await post(`/api/review/${session.id}/chats`, {});
    const { review } = await json<{ review: Review }>(res);
    expect(review.chats[0]).toMatchObject({ title: "Chat", model: null });
  });

  it("posts a message to a chat and appends it to that chat's messages", async () => {
    vi.spyOn(ReviewAgent.prototype, "ask").mockResolvedValue("42");
    const created = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/chats`, {}),
    );
    const chatId = created.review.chats[0]?.id as string;

    const res = await post(`/api/review/${session.id}/chats/${chatId}/messages`, {
      message: "what is the answer?",
    });
    expect(res.status).toBe(200);
    const { review } = await json<{ review: Review }>(res);
    const chat = review.chats.find((c) => c.id === chatId);
    expect(chat?.messages.map((m) => m.body)).toEqual(["what is the answer?", "42"]);
  });

  it("refuses a message without text", async () => {
    const created = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/chats`, {}),
    );
    const chatId = created.review.chats[0]?.id as string;
    const res = await post(`/api/review/${session.id}/chats/${chatId}/messages`, {
      message: " ",
    });
    expect(res.status).toBe(400);
  });

  it("returns an error response for an unknown chat id rather than a 500 or silent success", async () => {
    const res = await post(`/api/review/${session.id}/chats/does-not-exist/messages`, {
      message: "hi",
    });
    expect(res.status).toBe(503);
    const body = await json<{ error: string }>(res);
    expect(body.error).toContain("does-not-exist");
  });

  it("tags the chat-token SSE event with the chat id", async () => {
    vi.spyOn(ReviewAgent.prototype, "ask").mockImplementation(async function (
      this: ReviewAgent,
      _prompt: string,
      onToken?: (text: string) => void,
    ) {
      onToken?.("partial");
      return "partial";
    });
    const created = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/chats`, {}),
    );
    const chatId = created.review.chats[0]?.id as string;

    const eventsRes = await req(`/api/review/${session.id}/events`);
    const reader = (eventsRes.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // the initial review state

    const chatPromise = post(`/api/review/${session.id}/chats/${chatId}/messages`, {
      message: "hi",
    });

    // The stream multiplexes every mutation under the same SSE frame name ("review");
    // consumers tell events apart by the `type` field in the JSON payload instead.
    let text = "";
    for (let i = 0; i < 10 && !text.includes('"type":"chat-token"'); i++) {
      const chunk = await reader.read();
      if (chunk.value) text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain('"type":"chat-token"');
    expect(text).toContain(chatId);

    await chatPromise;
    await reader.cancel();
  });
});

describe("chat model (Story 2.2)", () => {
  it("sets a chat's model and reflects it in the returned review", async () => {
    const created = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/chats`, {}),
    );
    const chatId = created.review.chats[0]?.id as string;

    const res = await req(`/api/review/${session.id}/chats/${chatId}`, {
      method: "PATCH",
      body: JSON.stringify({ model: "opus" }),
    });
    expect(res.status).toBe(200);
    const { review } = await json<{ review: Review }>(res);
    expect(review.chats.find((c) => c.id === chatId)?.model).toBe("opus");
  });

  it("sets a chat back to Default (null)", async () => {
    const created = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/chats`, { model: "opus" }),
    );
    const chatId = created.review.chats[0]?.id as string;

    const res = await req(`/api/review/${session.id}/chats/${chatId}`, {
      method: "PATCH",
      body: JSON.stringify({ model: null }),
    });
    const { review } = await json<{ review: Review }>(res);
    expect(review.chats.find((c) => c.id === chatId)?.model).toBeNull();
  });

  it("does not disturb the chat's existing messages", async () => {
    vi.spyOn(ReviewAgent.prototype, "ask").mockResolvedValue("42");
    const created = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/chats`, {}),
    );
    const chatId = created.review.chats[0]?.id as string;
    await post(`/api/review/${session.id}/chats/${chatId}/messages`, { message: "hi" });

    const res = await req(`/api/review/${session.id}/chats/${chatId}`, {
      method: "PATCH",
      body: JSON.stringify({ model: "haiku" }),
    });
    const { review } = await json<{ review: Review }>(res);
    const chat = review.chats.find((c) => c.id === chatId);
    expect(chat?.model).toBe("haiku");
    expect(chat?.messages.map((m) => m.body)).toEqual(["hi", "42"]);
    vi.restoreAllMocks();
  });

  it("returns an error response for an unknown chat id", async () => {
    const res = await req(`/api/review/${session.id}/chats/does-not-exist`, {
      method: "PATCH",
      body: JSON.stringify({ model: "opus" }),
    });
    expect(res.status).toBe(404);
    const body = await json<{ error: string }>(res);
    expect(body.error).toContain("does-not-exist");
  });
});

describe("events", () => {
  it("sends the current review as soon as the stream opens", async () => {
    const res = await req(`/api/review/${session.id}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("event: review");
    expect(text).toContain(session.review.id);
    await reader.cancel();
  });

  it("sends a new state after a mutation", async () => {
    const res = await req(`/api/review/${session.id}/events`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // the first state

    await post(`/api/review/${session.id}/comments`, {
      scope: "global",
      body: "belongs in Services",
    });

    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("belongs in Services");
    await reader.cancel();
  });
});

describe("decision", () => {
  const lineComment = {
    scope: "line",
    body: "something is missing here",
    path: "src/service.ts",
    side: "new",
    startLine: 2,
  };

  it("refuses approve while a comment is still open", async () => {
    await post(`/api/review/${session.id}/comments`, lineComment);

    const res = await post(`/api/review/${session.id}/decision`, { decision: "approve" });
    expect(res.status).toBe(409);
    const body = await json<{ openCommentIds: string[] }>(res);
    expect(body.openCommentIds).toHaveLength(1);
  });

  it("allows approve once the comment is resolved", async () => {
    const created = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/comments`, lineComment),
    );
    const id = created.review.comments[0]?.id as string;
    await post(`/api/review/${session.id}/comments/${id}/resolve`, { resolved: true });

    const res = await post(`/api/review/${session.id}/decision`, {
      decision: "approve",
      summary: "the shape holds",
    });
    expect(res.status).toBe(200);
    const { review } = await json<{ review: Review }>(res);
    expect(review.status).toBe("approved");
    expect(review.rounds[0]).toMatchObject({ decision: "approve", summary: "the shape holds" });
  });

  it("writes an artifact for exactly this diff on approve", async () => {
    await post(`/api/review/${session.id}/decision`, { decision: "approve" });

    const patch = await session.git.rawDiff("staged", {});
    const approval = await readApproval(`${repo.root}/.git`, diffHash(patch));
    expect(approval).not.toBeNull();
    expect(approval?.reviewId).toBe(session.review.id);

    // Another diff has no approval.
    expect(await readApproval(`${repo.root}/.git`, diffHash("something else"))).toBeNull();
  });

  it("does allow request_changes with open comments", async () => {
    await post(`/api/review/${session.id}/comments`, lineComment);
    const res = await post(`/api/review/${session.id}/decision`, {
      decision: "request_changes",
      summary: "the invalidation first",
    });
    expect(res.status).toBe(200);
    const { review } = await json<{ review: Review }>(res);
    expect(review.status).toBe("changes_requested");
  });

  it("refuses an unknown decision", async () => {
    const res = await post(`/api/review/${session.id}/decision`, { decision: "maybe" });
    expect(res.status).toBe(400);
  });

  it("stores an empty summary as null", async () => {
    const res = await post(`/api/review/${session.id}/decision`, {
      decision: "approve",
      summary: "   ",
    });
    const { review } = await json<{ review: Review }>(res);
    expect(review.rounds[0]?.summary).toBeNull();
  });
});

describe("update check (Story 5.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the documented shape and calls GitHub at most once per calendar day", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "v99.0.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const first = await app.fetch(new Request("http://127.0.0.1/api/update-check"));
    expect(first.status).toBe(200);
    const firstBody = await json<UpdateCheckResult>(first);
    expect(firstBody).toEqual({ current: "test", latest: "v99.0.0", updateAvailable: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Same calendar day: the cache answers, GitHub is not called again.
    const second = await app.fetch(new Request("http://127.0.0.1/api/update-check"));
    const secondBody = await json<UpdateCheckResult>(second);
    expect(secondBody).toEqual(firstBody);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Force the cache's stored date back a day; the next call must be treated as a
    // new calendar day and make exactly one more GitHub call.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const y = yesterday.getFullYear();
    const m = String(yesterday.getMonth() + 1).padStart(2, "0");
    const d = String(yesterday.getDate()).padStart(2, "0");
    await writeUpdateCheckCache(gitDir, {
      date: `${y}-${m}-${d}`,
      latest: "v99.0.0",
      updateAvailable: true,
    });

    const third = await app.fetch(new Request("http://127.0.0.1/api/update-check"));
    expect(third.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("resolves to a non-throwing, non-5xx result when GitHub is unreachable", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    const res = await app.fetch(new Request("http://127.0.0.1/api/update-check"));
    expect(res.status).toBe(200);
    const body = await json<UpdateCheckResult>(res);
    expect(body).toEqual({ current: "test", latest: null, updateAvailable: false });
  });
});
