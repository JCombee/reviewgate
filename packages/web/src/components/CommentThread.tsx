import type { Comment } from "@reviewgate/core/api";
import { useState } from "react";
import type { ReviewApi } from "../lib/reviewClient.js";
import { CommentForm } from "./CommentForm.jsx";

const STATUS_LABEL: Record<Comment["status"], string> = {
  open: "open",
  resolved: "opgelost",
  outdated: "verouderd",
};

/**
 * Eén discussie: de comment, zijn reacties, en de acties erop. Vorm en toon volgen
 * GitLab-discussions: compact, met de status en de ronde als context.
 */
export function CommentThread({ comment, api }: { comment: Comment; api: ReviewApi }) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const muted = comment.status !== "open";

  return (
    <div
      className={`border-y border-[var(--rg-border)] bg-[var(--rg-bg-raised)] px-3 py-2 ${
        muted ? "opacity-70" : ""
      }`}
      data-comment-id={comment.id}
    >
      <div className="flex items-center gap-2 text-[var(--rg-text-faint)]">
        <span>{comment.author === "user" ? "jij" : "agent"}</span>
        <span>·</span>
        <span>ronde {comment.round}</span>
        <span>·</span>
        <span>{STATUS_LABEL[comment.status]}</span>
        {comment.kind === "question" && (
          <span
            className="rounded px-1"
            style={{ color: "var(--rg-status-renamed)" }}
            title="Een vraag; Claude beantwoordt hem in plaats van hem te fixen"
          >
            vraag
          </span>
        )}
        {comment.scope === "line" && comment.startLine !== undefined && (
          <span className="rg-code">
            {comment.endLine && comment.endLine !== comment.startLine
              ? `L${comment.startLine}-${comment.endLine}`
              : `L${comment.startLine}`}
          </span>
        )}
      </div>

      {editing ? (
        <div className="mt-1">
          <CommentForm
            initialBody={comment.body}
            submitLabel="Bewaar"
            withKind={false}
            onSubmit={async (body) => {
              await api.editComment(comment.id, body);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap">{comment.body}</p>
      )}

      {comment.replies.map((reply, i) => (
        <div key={i} className="mt-2 border-l-2 border-[var(--rg-border)] pl-2">
          <p className="text-[var(--rg-text-faint)]">
            {reply.author === "user" ? "jij" : "agent"}
          </p>
          <p className="whitespace-pre-wrap">{reply.body}</p>
        </div>
      ))}

      {replying ? (
        <div className="mt-2">
          <CommentForm
            submitLabel="Reageer"
            withKind={false}
            placeholder="Reactie…"
            onSubmit={async (body) => {
              await api.reply(comment.id, body);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
          />
        </div>
      ) : (
        <div className="mt-2 flex gap-3 text-[var(--rg-text-muted)]">
          <button type="button" onClick={() => setReplying(true)}>
            Reageer
          </button>
          {comment.status !== "outdated" && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() => api.setResolved(comment.id, comment.status !== "resolved"))
              }
            >
              {comment.status === "resolved" ? "Heropen" : "Resolve"}
            </button>
          )}
          <button type="button" onClick={() => setEditing(true)}>
            Bewerk
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => api.deleteComment(comment.id))}
          >
            Verwijder
          </button>
        </div>
      )}
    </div>
  );
}
