import { diffHash, NodeGitClient, readApproval, TestRepo } from "@reviewgate/core";
import type { Review, ReviewSummary } from "@reviewgate/core/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, SessionStore } from "./app.js";
import { Session } from "./session.js";

/**
 * Integratietests tegen een echte tijdelijke git-repo (§14). We praten met de app
 * via `app.fetch` in plaats van over een socket: dat is dezelfde code als in
 * productie, zonder poorten en wachttijden.
 */

const SERVER_TOKEN = "server-token-voor-tests";

let repo: TestRepo;
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
  await repo.commit("basis");
  await repo.write("src/service.ts", "export const a = 1;\nexport const b = 22;\n");
  await repo.addAll();

  store = new SessionStore();
  app = createApp({ serverToken: SERVER_TOKEN, repoRoot: repo.root, version: "test" }, store);
  session = await Session.create(
    { git: await NodeGitClient.open(repo.root), scope: "staged", options: {} },
    store.highlighting,
  );
  store.add(session);
});

afterEach(async () => {
  await repo.cleanup();
});

describe("toegang", () => {
  it("weigert een request zonder token", async () => {
    const res = await app.fetch(new Request(`http://127.0.0.1/api/review/${session.id}`));
    expect(res.status).toBe(403);
  });

  it("weigert een verkeerd token", async () => {
    const res = await req(`/api/review/${session.id}`, {}, "fout-token");
    expect(res.status).toBe(403);
  });

  it("accepteert het token uit de query, zoals in de review-URL", async () => {
    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/review/${session.id}?token=${session.token}`),
    );
    expect(res.status).toBe(200);
  });

  it("geeft 404 voor een onbekende sessie", async () => {
    const res = await req("/api/review/bestaat-niet");
    expect(res.status).toBe(404);
  });

  it("laat alleen het beheerstoken sessies aanmaken", async () => {
    const bad = await post("/api/sessions", { scope: "staged" });
    expect(bad.status).toBe(403);

    const good = await req("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ scope: "staged", cwd: repo.root }),
    }, SERVER_TOKEN);
    expect(good.status).toBe(200);
  });
});

describe("samenvatting", () => {
  it("bevat de diff en de persistente review", async () => {
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
    body: "hier ontbreekt de tag-variant",
    path: "src/service.ts",
    side: "new",
    startLine: 2,
    anchorSnippet: "export const b = 22;",
  };

  it("plaatst een regel-comment en geeft de review terug", async () => {
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

  it("weigert een comment zonder tekst", async () => {
    const res = await post(`/api/review/${session.id}/comments`, { ...lineComment, body: " " });
    expect(res.status).toBe(400);
  });

  it("weigert een regel-comment zonder regelnummer", async () => {
    const { startLine: _drop, ...zonder } = lineComment;
    const res = await post(`/api/review/${session.id}/comments`, zonder);
    expect(res.status).toBe(400);
  });

  it("bewerkt, beantwoordt, resolvet en verwijdert", async () => {
    const created = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/comments`, lineComment),
    );
    const id = created.review.comments[0]?.id as string;

    const edited = await json<{ review: Review }>(
      await req(`/api/review/${session.id}/comments/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ body: "aangepast" }),
      }),
    );
    expect(edited.review.comments[0]?.body).toBe("aangepast");

    const replied = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/comments/${id}/replies`, { body: "klopt" }),
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

  it("geeft 404 voor een onbekende comment", async () => {
    const res = await req(`/api/review/${session.id}/comments/onbekend`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("bewaart comments op schijf, zodat ze een herstart overleven", async () => {
    await post(`/api/review/${session.id}/comments`, lineComment);

    // Een nieuwe sessie op dezelfde diff staat gelijk aan een herstart van de server.
    const tweede = await Session.create(
      { git: await NodeGitClient.open(repo.root), scope: "staged", options: {} },
      new SessionStore().highlighting,
    );
    expect(tweede.review.id).toBe(session.review.id);
    expect(tweede.review.comments).toHaveLength(1);
    expect(tweede.review.comments[0]).toMatchObject({
      path: "src/service.ts",
      startLine: 2,
      body: "hier ontbreekt de tag-variant",
    });
  });
});

describe("commit message", () => {
  it("slaat een aangepaste message op", async () => {
    const res = await req(`/api/review/${session.id}/commit-message`, {
      method: "PUT",
      body: JSON.stringify({ message: "fix(service): tags invalideren" }),
    });
    const { review } = await json<{ review: Review }>(res);
    expect(review.rounds[0]?.editedCommitMessage).toBe("fix(service): tags invalideren");
  });
});

describe("events", () => {
  it("stuurt de huidige review meteen bij het openen van de stream", async () => {
    const res = await req(`/api/review/${session.id}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("event: review");
    expect(text).toContain(session.review.id);
    await reader.cancel();
  });

  it("stuurt een nieuwe stand na een mutatie", async () => {
    const res = await req(`/api/review/${session.id}/events`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // de eerste stand

    await post(`/api/review/${session.id}/comments`, {
      scope: "global",
      body: "hoort in Services",
    });

    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("hoort in Services");
    await reader.cancel();
  });
});

describe("beslissing", () => {
  const lineComment = {
    scope: "line",
    body: "hier ontbreekt iets",
    path: "src/service.ts",
    side: "new",
    startLine: 2,
  };

  it("weigert approve zolang er een comment open staat", async () => {
    await post(`/api/review/${session.id}/comments`, lineComment);

    const res = await post(`/api/review/${session.id}/decision`, { decision: "approve" });
    expect(res.status).toBe(409);
    const body = await json<{ openCommentIds: string[] }>(res);
    expect(body.openCommentIds).toHaveLength(1);
  });

  it("staat approve toe zodra de comment opgelost is", async () => {
    const created = await json<{ review: Review }>(
      await post(`/api/review/${session.id}/comments`, lineComment),
    );
    const id = created.review.comments[0]?.id as string;
    await post(`/api/review/${session.id}/comments/${id}/resolve`, { resolved: true });

    const res = await post(`/api/review/${session.id}/decision`, {
      decision: "approve",
      summary: "opzet klopt",
    });
    expect(res.status).toBe(200);
    const { review } = await json<{ review: Review }>(res);
    expect(review.status).toBe("approved");
    expect(review.rounds[0]).toMatchObject({ decision: "approve", summary: "opzet klopt" });
  });

  it("schrijft bij approve een artifact voor precies deze diff", async () => {
    await post(`/api/review/${session.id}/decision`, { decision: "approve" });

    const patch = await session.git.rawDiff("staged", {});
    const approval = await readApproval(`${repo.root}/.git`, diffHash(patch));
    expect(approval).not.toBeNull();
    expect(approval?.reviewId).toBe(session.review.id);

    // Een andere diff heeft geen goedkeuring.
    expect(await readApproval(`${repo.root}/.git`, diffHash("iets anders"))).toBeNull();
  });

  it("laat request_changes wél toe met openstaande comments", async () => {
    await post(`/api/review/${session.id}/comments`, lineComment);
    const res = await post(`/api/review/${session.id}/decision`, {
      decision: "request_changes",
      summary: "eerst de invalidatie",
    });
    expect(res.status).toBe(200);
    const { review } = await json<{ review: Review }>(res);
    expect(review.status).toBe("changes_requested");
  });

  it("weigert een onbekende beslissing", async () => {
    const res = await post(`/api/review/${session.id}/decision`, { decision: "misschien" });
    expect(res.status).toBe(400);
  });

  it("bewaart een lege samenvatting als null", async () => {
    const res = await post(`/api/review/${session.id}/decision`, {
      decision: "approve",
      summary: "   ",
    });
    const { review } = await json<{ review: Review }>(res);
    expect(review.rounds[0]?.summary).toBeNull();
  });
});
