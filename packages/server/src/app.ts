import { timingSafeEqual } from "node:crypto";
import { NodeGitClient, type DiffOptions, type ReviewScope } from "@reviewgate/core";
import { Hono } from "hono";
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

    const scope = body.scope ?? "staged";
    const git = await NodeGitClient.open(body.cwd ?? deps.repoRoot);
    const session = await Session.create(
      { git, scope, options: body.options ?? {} },
      store.highlighting,
    );
    store.add(session);

    return c.json({ id: session.id, token: session.token, path: `/r/${session.id}` });
  });

  // --- review-API ---------------------------------------------------------
  const withSession = (c: {
    req: { param: (k: string) => string | undefined; header: (k: string) => string | undefined; query: (k: string) => string | undefined };
  }): Session | "notfound" | "forbidden" => {
    const id = c.req.param("id");
    if (!id) return "notfound";
    const session = store.get(id);
    if (!session) return "notfound";
    const given = bearer(c.req.header("authorization")) ?? c.req.query("token");
    return tokenMatches(session.token, given) ? session : "forbidden";
  };

  app.get("/api/review/:id", (c) => {
    const s = withSession(c);
    if (s === "notfound") return c.json({ error: "onbekende review" }, 404);
    if (s === "forbidden") return c.json({ error: "forbidden" }, 403);
    return c.json(s.summary());
  });

  app.get("/api/review/:id/files/:index", async (c) => {
    const s = withSession(c);
    if (s === "notfound") return c.json({ error: "onbekende review" }, 404);
    if (s === "forbidden") return c.json({ error: "forbidden" }, 403);

    const index = Number.parseInt(c.req.param("index") ?? "", 10);
    if (Number.isNaN(index)) return c.json({ error: "ongeldige index" }, 400);

    const detail = await s.fileDetail(index);
    if (!detail) return c.json({ error: "onbekend bestand" }, 404);
    return c.json(detail);
  });

  // Volledige bestandsinhoud, voor context-expansie wanneer highlighting is
  // overgeslagen en de tokens dus geen tekst bevatten (§7, §12).
  app.get("/api/review/:id/file", async (c) => {
    const s = withSession(c);
    if (s === "notfound") return c.json({ error: "onbekende review" }, 404);
    if (s === "forbidden") return c.json({ error: "forbidden" }, 403);

    const path = c.req.query("path");
    const side = c.req.query("side");
    if (!path || (side !== "old" && side !== "new")) {
      return c.json({ error: "path en side zijn verplicht" }, 400);
    }
    const content = await s.git.fileContent(path, side, s.scope);
    if (content === null) return c.json({ error: "bestand niet gevonden" }, 404);
    return c.json({ path, side, content });
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
