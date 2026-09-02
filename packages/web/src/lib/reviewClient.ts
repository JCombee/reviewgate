import type { CreateCommentBody, PassStatus, Review, ReviewEvent } from "@reviewgate/core/api";
import type { Ctx } from "../api.js";

/** Every mutation on the review, in one object that travels through the components. */
export interface ReviewApi {
  addComment: (body: CreateCommentBody) => Promise<void>;
  editComment: (id: string, body: string) => Promise<void>;
  deleteComment: (id: string) => Promise<void>;
  reply: (id: string, body: string) => Promise<void>;
  setResolved: (id: string, resolved: boolean) => Promise<void>;
  setCommitMessage: (message: string | null) => Promise<void>;
  /** Accepting a suggestion: it becomes your comment, and only then does it count (§9). */
  acceptSuggestion: (id: string, body?: string) => Promise<void>;
  dismissSuggestion: (id: string) => Promise<void>;
  reopenSuggestion: (id: string) => Promise<void>;
  chat: (message: string) => Promise<void>;
  restartPass: () => Promise<void>;
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
    acceptSuggestion: (id, body) =>
      run(`/suggestions/${id}/accept`, "POST", body === undefined ? {} : { body }),
    dismissSuggestion: (id) => run(`/suggestions/${id}/dismiss`, "POST", {}),
    reopenSuggestion: (id) => run(`/suggestions/${id}/reopen`, "POST", {}),
    chat: (message) => run("/chat", "POST", { message }),
    restartPass: async () => {
      // The pass answers immediately and delivers its findings over SSE afterwards.
      await fetch(`/api/review/${ctx.id}/pass`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.token}` },
      });
    },
  };
}

export interface ReviewEventHandlers {
  onReview: (review: Review) => void;
  /** One piece of an answer that is still streaming. */
  onChatToken?: (text: string) => void;
  onPass?: (status: PassStatus) => void;
}

/**
 * Listens on the SSE stream and passes every new state along. That way a second tab
 * keeps up, as do the suggestions that trickle in during the automatic pass (§9).
 */
export function subscribeToReview(ctx: Ctx, handlers: ReviewEventHandlers): () => void {
  const source = new EventSource(
    `/api/review/${ctx.id}/events?token=${encodeURIComponent(ctx.token)}`,
  );

  const handle = (e: MessageEvent<string>) => {
    let event: ReviewEvent;
    try {
      event = JSON.parse(e.data) as ReviewEvent;
    } catch {
      // Skipping an unreadable message beats giving up on the stream.
      return;
    }
    if (event.type === "review") handlers.onReview(event.review);
    else if (event.type === "chat-token") handlers.onChatToken?.(event.text);
    else if (event.type === "pass") handlers.onPass?.(event.status);
  };

  for (const name of ["review", "chat-token", "pass"]) {
    source.addEventListener(name, handle as EventListener);
  }
  return () => source.close();
}
