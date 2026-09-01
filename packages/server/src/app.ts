import { timingSafeEqual } from "node:crypto";
import {
  addComment,
  addReply,
  deleteComment,
  editComment,
  NodeGitClient,
  ReviewError,
  setCommentStatus,
  setEditedCommitMessage,
  type DiffOptions,
  type Review,
  type ReviewScope,
} from "@reviewgate/core";
import type { CreateCommentBody } from "@reviewgate/core/api";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { findWebDist, readAsset } from "./assets.js";
import { Highlighting } from "./highlight.js";
import { Session } from "./session.js";

export interface AppDeps {
  /** Beheerstoken uit server.json; alleen de CLI mag hiermee sessies aanmaken. */
  serverToken: string;
  repoRoot: string;
  version: string;
}

export interface CreateSessionBody {
  scope: ReviewScope;
  options?: DiffOptions;
  cwd?: string;
  commitMessage?: string | null;
  claudeSessionId?: string | null;
  transcriptPath?: string | null;
}

export class SessionStore {
  #sessions = new Map<string, Session>();
  readonly highlighting = new Highlighting();

  add(session: Session): void {
    this.#sessions.set(session.id, session);
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  get size(): number {
    return this.#sessions.size;
  }
}

/** Vergelijking in constante tijd, zodat het token niet te raden is per response-tijd. */
function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1];
}

export function createApp(deps: AppDeps, store: SessionStore): Hono {
  const app = new Hono();

  app.get("/healthz", (c) =>
    c.json({ ok: true, version: deps.version, repoRoot: deps.repoRoot, sessions: store.size }),
  );

  // --- beheer: sessie aanmaken -------------------------------------------
  app.post("/api/sessions", async (c) => {
    if (!tokenMatches(deps.serverToken, bearer(c.req.header("authorization")))) {
      return c.json({ error: "forbidden" }, 403);
    }

    let body: CreateSessionBody;
    try {
      body = (await c.req.json()) as CreateSessionBody;
    } catch {
      return c.json({ error: "ongeldige JSON" }, 400);
    }

    const git = await NodeGitClient.open(body.cwd ?? deps.repoRoot);
    const session = await Session.create(
      {
        git,
        scope: body.scope ?? "staged",
        options: body.options ?? {},
        commitMessage: body.commitMessage ?? null,
        claudeSessionId: body.claudeSessionId ?? null,
        transcriptPath: body.transcriptPath ?? null,
      },
      store.highlighting,
    );
    store.add(session);

    return c.json({
      id: session.id,
      token: session.token,
      path: `/r/${session.id}`,
      reviewId: session.review.id,
    });
  });

  // --- review-API ---------------------------------------------------------
  /** Sessie ophalen en het token controleren; anders meteen het juiste antwoord. */
  function resolve(c: Context): Session | Response {
    const id = c.req.param("id");
    const session = id ? store.get(id) : undefined;
    if (!session) return c.json({ error: "onbekende review" }, 404);
    const given = bearer(c.req.header("authorization")) ?? c.req.query("token");
    if (!tokenMatches(session.token, given)) return c.json({ error: "forbidden" }, 403);
    return session;
  }

  const isSession = (v: Session | Response): v is Session => v instanceof Session;

  /** Mutatie uitvoeren, opslaan, uitzenden en de nieuwe review teruggeven. */
  async function mutate(
    c: Context,
    session: Session,
    fn: () => Review | { review: Review },
  ): Promise<Response> {
    try {
      const result = fn();
      const next = "review" in result ? result.review : result;
      const saved = await session.commit(next);
      return c.json({ review: saved });
    } catch (err) {
      if (err instanceof ReviewError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  }

  app.get("/api/review/:id", (c) => {
    const s = resolve(c);
    return isSession(s) ? c.json(s.summary()) : s;
  });

  app.get("/api/review/:id/files/:index", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;

    const index = Number.parseInt(c.req.param("index") ?? "", 10);
    if (Number.isNaN(index)) return c.json({ error: "ongeldige index" }, 400);

    const detail = await s.fileDetail(index);
    if (!detail) return c.json({ error: "onbekend bestand" }, 404);
    return c.json(detail);
  });

  // Volledige bestandsinhoud, voor context-expansie wanneer highlighting is
  // overgeslagen en de tokens dus geen tekst bevatten (§7, §12).
  app.get("/api/review/:id/file", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;

    const path = c.req.query("path");
    const side = c.req.query("side");
    if (!path || (side !== "old" && side !== "new")) {
      return c.json({ error: "path en side zijn verplicht" }, 400);
    }
    const content = await s.git.fileContent(path, side, s.scope);
    if (content === null) return c.json({ error: "bestand niet gevonden" }, 404);
    return c.json({ path, side, content });
  });

  app.post("/api/review/:id/comments", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const body = (await c.req.json().catch(() => null)) as CreateCommentBody | null;
    if (!body) return c.json({ error: "ongeldige JSON" }, 400);
    return mutate(c, s, () => addComment(s.review, body));
  });

  app.patch("/api/review/:id/comments/:cid", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const cid = c.req.param("cid") ?? "";
    const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
    const text = body?.body;
    if (typeof text !== "string") return c.json({ error: "body ontbreekt" }, 400);
    return mutate(c, s, () => editComment(s.review, cid, text));
  });

  app.delete("/api/review/:id/comments/:cid", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const cid = c.req.param("cid") ?? "";
    return mutate(c, s, () => deleteComment(s.review, cid));
  });

  app.post("/api/review/:id/comments/:cid/replies", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const cid = c.req.param("cid") ?? "";
    const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
    const text = body?.body;
    if (typeof text !== "string") return c.json({ error: "body ontbreekt" }, 400);
    return mutate(c, s, () => addReply(s.review, cid, text));
  });

  app.post("/api/review/:id/comments/:cid/resolve", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const cid = c.req.param("cid") ?? "";
    const body = (await c.req.json().catch(() => null)) as { resolved?: boolean } | null;
    const resolved = body?.resolved ?? true;
    return mutate(c, s, () => setCommentStatus(s.review, cid, resolved));
  });

  app.put("/api/review/:id/commit-message", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const body = (await c.req.json().catch(() => null)) as { message?: string | null } | null;
    const message = body?.message ?? null;
    return mutate(c, s, () => setEditedCommitMessage(s.review, message));
  });

  // SSE: elke mutatie stuurt de hele review na. Die is klein genoeg, en het
  // scheelt een heel protocol aan deelmutaties dat toch weer uit de pas loopt.
  app.get("/api/review/:id/events", (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;

    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      let running = true;

      const unsubscribe = s.subscribe((event) => {
        queue.push(JSON.stringify(event));
        wake?.();
      });

      stream.onAbort(() => {
        running = false;
        unsubscribe();
        wake?.();
      });

      // Direct de huidige stand sturen, zodat een verlate verbinding niets mist.
      await stream.writeSSE({
        event: "review",
        data: JSON.stringify({ type: "review", review: s.review }),
      });

      while (running) {
        if (queue.length === 0) {
          // Wachten op de volgende mutatie, of op een hartslag zodat een dode
          // verbinding niet eindeloos blijft hangen.
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 25_000);
          });
          wake = null;
          if (!running) break;
          if (queue.length === 0) {
            await stream.writeSSE({ event: "ping", data: JSON.stringify({ type: "ping" }) });
            continue;
          }
        }
        const data = queue.shift();
        if (data) await stream.writeSSE({ event: "review", data });
      }

      unsubscribe();
    });
  });

  // --- web-UI -------------------------------------------------------------
  app.get("/r/:id", async (c) => {
    const id = c.req.param("id");
    if (!id || !store.get(id)) return c.text("onbekende review", 404);
    const dist = await findWebDist();
    if (!dist) {
      return c.text(
        "De web-UI is niet gebouwd. Draai `pnpm --filter @reviewgate/web build`.",
        503,
      );
    }
    const asset = await readAsset(dist, "index.html");
    if (!asset) return c.text("index.html ontbreekt in de web-build", 503);
    return c.body(asset.body, 200, { "content-type": asset.contentType });
  });

  app.get("/assets/*", async (c) => {
    const dist = await findWebDist();
    if (!dist) return c.text("niet gevonden", 404);
    const asset = await readAsset(dist, new URL(c.req.url).pathname);
    if (!asset) return c.text("niet gevonden", 404);
    return c.body(asset.body, 200, {
      "content-type": asset.contentType,
      // Vite hasht assetnamen, dus lang cachen mag.
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  app.get("/favicon.svg", async (c) => {
    const dist = await findWebDist();
    const asset = dist ? await readAsset(dist, "favicon.svg") : null;
    if (!asset) return c.body(null, 204);
    return c.body(asset.body, 200, { "content-type": asset.contentType });
  });

  return app;
}
