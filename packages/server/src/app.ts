import { timingSafeEqual } from "node:crypto";
import {
  acceptSuggestion,
  addComment,
  addReply,
  deleteComment,
  dismissSuggestion,
  editComment,
  NodeGitClient,
  reopenSuggestion,
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
import { hasWebAssets, loadAsset } from "./assets.js";
import { Highlighting } from "./highlight.js";
import { DecisionConflict, Session } from "./session.js";

export interface AppDeps {
  /** Admin token from server.json; only the CLI may create sessions with it. */
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

/** Constant-time comparison, so the token cannot be guessed from response timing. */
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

  // --- admin: creating a session ------------------------------------------
  app.post("/api/sessions", async (c) => {
    if (!tokenMatches(deps.serverToken, bearer(c.req.header("authorization")))) {
      return c.json({ error: "forbidden" }, 403);
    }

    let body: CreateSessionBody;
    try {
      body = (await c.req.json()) as CreateSessionBody;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
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

    // The automatic pass runs alongside your reading and blocks nothing (§9).
    if (session.config.autoReview && process.env["REVIEWGATE_AUTO_REVIEW"] !== "0") {
      void session.runReviewPass();
    }

    return c.json({
      id: session.id,
      token: session.token,
      path: `/r/${session.id}`,
      reviewId: session.review.id,
    });
  });

  // --- review API ----------------------------------------------------------
  /** Fetch the session and check the token; otherwise answer straight away. */
  function resolve(c: Context): Session | Response {
    const id = c.req.param("id");
    const session = id ? store.get(id) : undefined;
    if (!session) return c.json({ error: "unknown review" }, 404);
    const given = bearer(c.req.header("authorization")) ?? c.req.query("token");
    if (!tokenMatches(session.token, given)) return c.json({ error: "forbidden" }, 403);
    return session;
  }

  const isSession = (v: Session | Response): v is Session => v instanceof Session;

  /** Run the mutation, save it, broadcast it and return the new review. */
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
    if (Number.isNaN(index)) return c.json({ error: "invalid index" }, 400);

    const detail = await s.fileDetail(index);
    if (!detail) return c.json({ error: "unknown file" }, 404);
    return c.json(detail);
  });

  // Full file content, for context expansion when highlighting was skipped and the
  // tokens therefore carry no text (§7, §12).
  app.get("/api/review/:id/file", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;

    const path = c.req.query("path");
    const side = c.req.query("side");
    if (!path || (side !== "old" && side !== "new")) {
      return c.json({ error: "path and side are required" }, 400);
    }
    const content = await s.git.fileContent(path, side, s.scope);
    if (content === null) return c.json({ error: "file not found" }, 404);
    return c.json({ path, side, content });
  });

  app.post("/api/review/:id/comments", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const body = (await c.req.json().catch(() => null)) as CreateCommentBody | null;
    if (!body) return c.json({ error: "invalid JSON" }, 400);
    return mutate(c, s, () => addComment(s.review, body));
  });

  app.patch("/api/review/:id/comments/:cid", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const cid = c.req.param("cid") ?? "";
    const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
    const text = body?.body;
    if (typeof text !== "string") return c.json({ error: "body is missing" }, 400);
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
    if (typeof text !== "string") return c.json({ error: "body is missing" }, 400);
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


  // --- chat and suggestions (§9) -------------------------------------------
  app.post("/api/review/:id/chat", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const body = (await c.req.json().catch(() => null)) as { message?: string } | null;
    const message = body?.message;
    if (typeof message !== "string" || message.trim() === "") {
      return c.json({ error: "message is missing" }, 400);
    }
    try {
      const review = await s.chat(message);
      return c.json({ review });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 503);
    }
  });

  // The pass runs in the background: the response comes back at once, the findings
  // trickle in over SSE (§9).
  app.post("/api/review/:id/pass", (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    void s.runReviewPass();
    return c.json({ started: true });
  });

  app.post("/api/review/:id/suggestions/:sid/accept", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const sid = c.req.param("sid") ?? "";
    const body = (await c.req.json().catch(() => null)) as { body?: string } | null;

    const suggestion = s.review.suggestions.find((x) => x.id === sid);
    if (!suggestion) return c.json({ error: "unknown suggestion" }, 404);

    try {
      // The comment that comes out has author "user": you approved it, so you are
      // the author. Only then does it count and go to Claude (§9).
      const { review, comment } = addComment(s.review, {
        scope: suggestion.scope,
        body: body?.body ?? suggestion.body,
        fromSuggestion: suggestion.id,
        ...(suggestion.path !== undefined ? { path: suggestion.path } : {}),
        ...(suggestion.side !== undefined ? { side: suggestion.side } : {}),
        ...(suggestion.startLine !== undefined ? { startLine: suggestion.startLine } : {}),
        ...(suggestion.endLine !== undefined ? { endLine: suggestion.endLine } : {}),
        ...(suggestion.anchorSnippet !== undefined
          ? { anchorSnippet: suggestion.anchorSnippet }
          : {}),
      });
      const saved = await s.commit(acceptSuggestion(review, sid, comment.id));
      return c.json({ review: saved });
    } catch (err) {
      if (err instanceof ReviewError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.post("/api/review/:id/suggestions/:sid/dismiss", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const sid = c.req.param("sid") ?? "";
    return c.json({ review: await s.commit(dismissSuggestion(s.review, sid)) });
  });

  app.post("/api/review/:id/suggestions/:sid/reopen", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;
    const sid = c.req.param("sid") ?? "";
    return c.json({ review: await s.commit(reopenSuggestion(s.review, sid)) });
  });

  app.post("/api/review/:id/decision", async (c) => {
    const s = resolve(c);
    if (!isSession(s)) return s;

    const body = (await c.req.json().catch(() => null)) as {
      decision?: string;
      summary?: string | null;
    } | null;
    const decision = body?.decision;
    if (decision !== "approve" && decision !== "request_changes") {
      return c.json({ error: 'decision must be "approve" or "request_changes"' }, 400);
    }

    try {
      const review = await s.decide(decision, body?.summary ?? null);
      return c.json({ review });
    } catch (err) {
      if (err instanceof DecisionConflict) {
        return c.json({ error: err.message, openCommentIds: err.openCommentIds }, 409);
      }
      throw err;
    }
  });

  // SSE: every mutation sends the whole review along. It is small enough, and it
  // saves a whole protocol of partial mutations that would drift out of step anyway.
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

      // Send the current state right away, so a late connection misses nothing.
      await stream.writeSSE({
        event: "review",
        data: JSON.stringify({ type: "review", review: s.review }),
      });

      while (running) {
        if (queue.length === 0) {
          // Wait for the next mutation, or for a heartbeat so a dead connection
          // does not hang around forever. The timer is unref'd and cleared on wake:
          // the hook runs this server in its own process, and a pending 25s timer
          // would keep that process alive long after the verdict was printed.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 25_000);
            timer.unref?.();
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
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

  // --- web UI ---------------------------------------------------------------
  app.get("/r/:id", async (c) => {
    const id = c.req.param("id");
    if (!id || !store.get(id)) return c.text("unknown review", 404);
    if (!(await hasWebAssets())) {
      return c.text("The web UI has not been built. Run `npm run build:web`.", 503);
    }
    const asset = await loadAsset("index.html");
    if (!asset) return c.text("index.html is missing from the web build", 503);
    return c.body(asset.body, 200, { "content-type": asset.contentType });
  });

  app.get("/assets/*", async (c) => {
    const asset = await loadAsset(new URL(c.req.url).pathname);
    if (!asset) return c.text("not found", 404);
    return c.body(asset.body, 200, {
      "content-type": asset.contentType,
      // Vite hashes asset names, so caching them for a long time is fine.
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  app.get("/favicon.svg", async (c) => {
    const asset = await loadAsset("favicon.svg");
    if (!asset) return c.body(null, 204);
    return c.body(asset.body, 200, { "content-type": asset.contentType });
  });

  return app;
}
