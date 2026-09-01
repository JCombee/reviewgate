import type { CreateCommentBody, Review, ReviewEvent } from "@reviewgate/core/api";
import type { Ctx } from "../api.js";

/** Alle mutaties op de review, in één object dat door de componenten gaat. */
export interface ReviewApi {
  addComment: (body: CreateCommentBody) => Promise<void>;
  editComment: (id: string, body: string) => Promise<void>;
  deleteComment: (id: string) => Promise<void>;
  reply: (id: string, body: string) => Promise<void>;
  setResolved: (id: string, resolved: boolean) => Promise<void>;
  setCommitMessage: (message: string | null) => Promise<void>;
}

async function send(
  ctx: Ctx,
  path: string,
  method: string,
  body?: unknown,
): Promise<Review> {
  const res = await fetch(`/api/review/${ctx.id}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { review: Review };
  return data.review;
}

export function createReviewApi(ctx: Ctx, onReview: (review: Review) => void): ReviewApi {
  const run = async (path: string, method: string, body?: unknown): Promise<void> => {
    onReview(await send(ctx, path, method, body));
  };

  return {
    addComment: (body) => run("/comments", "POST", body),
    editComment: (id, body) => run(`/comments/${id}`, "PATCH", { body }),
    deleteComment: (id) => run(`/comments/${id}`, "DELETE"),
    reply: (id, body) => run(`/comments/${id}/replies`, "POST", { body }),
    setResolved: (id, resolved) => run(`/comments/${id}/resolve`, "POST", { resolved }),
    setCommitMessage: (message) => run("/commit-message", "PUT", { message }),
  };
}

/**
 * Luistert op de SSE-stream en geeft elke nieuwe stand door. Zo loopt een tweede
 * tabblad mee, en straks ook de suggesties die tijdens de automatische pass
 * binnendruppelen (§9).
 */
export function subscribeToReview(ctx: Ctx, onReview: (review: Review) => void): () => void {
  const source = new EventSource(
    `/api/review/${ctx.id}/events?token=${encodeURIComponent(ctx.token)}`,
  );
  const handle = (e: MessageEvent<string>) => {
    try {
      const event = JSON.parse(e.data) as ReviewEvent;
      if (event.type === "review") onReview(event.review);
    } catch {
      // Een onleesbaar bericht overslaan is beter dan de stream opgeven.
    }
  };
  source.addEventListener("review", handle as EventListener);
  return () => source.close();
}
