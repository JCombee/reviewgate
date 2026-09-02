import type { Comment, Review, Suggestion } from "@reviewgate/core/api";
import { useEffect, useState } from "react";
import type { ReviewApi } from "../lib/reviewClient.js";
import { CommentForm } from "./CommentForm.jsx";
import { CommentThread } from "./CommentThread.jsx";
import { DismissedSuggestions, SuggestionCard } from "./SuggestionCard.jsx";

/**
 * The overview above the file list: the commit message and the global comments.
 *
 * The message is both editable and commentable, and those two are independent (§8):
 * you can set it right yourself, or ask Claude to revise it, or both.
 */
export function Overview({
  review,
  api,
  onDiscuss,
}: {
  review: Review;
  api: ReviewApi;
  onDiscuss: (suggestion: Suggestion) => void;
}) {
  const round = review.rounds[review.rounds.length - 1];
  const original = round?.commitMessage ?? null;
  const edited = round?.editedCommitMessage ?? null;

  const [draft, setDraft] = useState(edited ?? original ?? "");
  const [showOriginal, setShowOriginal] = useState(false);
  const [adding, setAdding] = useState<"global" | "commit_message" | null>(null);
  const [saved, setSaved] = useState(false);

  // The review can change from the outside too (SSE); the field then follows along as
  // long as you are not typing in it yourself.
  useEffect(() => {
    setDraft(edited ?? original ?? "");
  }, [edited, original]);

  const globals = review.comments.filter((c) => c.scope === "global");
  const globalSuggestions = review.suggestions.filter((s) => s.scope === "global");
  const pendingSuggestions = globalSuggestions.filter((s) => s.status === "pending");
  const dismissedSuggestions = globalSuggestions.filter((s) => s.status === "dismissed");
  const messageComments = review.comments.filter((c) => c.scope === "commit_message");
  const outdated = review.comments.filter((c) => c.status === "outdated");

  const saveMessage = async () => {
    await api.setCommitMessage(draft);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="border-b border-[var(--rg-border)] px-3 py-2">
      <h2 className="mb-1 text-[11px] uppercase tracking-wide text-[var(--rg-text-faint)]">
        Commit message
      </h2>

      {original === null ? (
        <p className="text-[var(--rg-text-faint)]">
          Manual review — no commit message was intercepted.
        </p>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void saveMessage()}
            rows={3}
            aria-label="Commit message"
            className="rg-code w-full resize-y rounded border border-[var(--rg-border)] bg-[var(--rg-bg-raised)] px-2 py-1"
          />
          <div className="mt-1 flex items-center gap-3 text-[var(--rg-text-muted)]">
            <button type="button" onClick={() => setAdding("commit_message")}>
              Comment on the message
            </button>
            {edited !== null && (
              <button type="button" onClick={() => setShowOriginal((v) => !v)}>
                {showOriginal ? "hide original" : "show original"}
              </button>
            )}
            {saved && <span className="text-[var(--rg-text-faint)]">saved</span>}
          </div>
          {showOriginal && (
            <pre className="rg-code mt-1 whitespace-pre-wrap rounded bg-[var(--rg-bg-sunken)] px-2 py-1 text-[var(--rg-text-muted)]">
              {original}
            </pre>
          )}
        </>
      )}

      {messageComments.length > 0 && (
        <div className="mt-2">
          {edited !== null && (
            <p className="mb-1 text-[var(--rg-text-faint)]">
              Note: the message itself has been adjusted as well.
            </p>
          )}
          {messageComments.map((c) => (
            <CommentThread key={c.id} comment={c} api={api} />
          ))}
        </div>
      )}

      <h2 className="mt-4 mb-1 text-[11px] uppercase tracking-wide text-[var(--rg-text-faint)]">
        General
      </h2>
      {globals.length === 0 && adding !== "global" && (
        <p className="text-[var(--rg-text-faint)]">No general remarks yet.</p>
      )}
      {globals.map((c) => (
        <CommentThread key={c.id} comment={c} api={api} />
      ))}

      {pendingSuggestions.map((s) => (
        <SuggestionCard key={s.id} suggestion={s} api={api} onDiscuss={onDiscuss} />
      ))}
      <DismissedSuggestions suggestions={dismissedSuggestions} api={api} onDiscuss={onDiscuss} />

      <OutdatedComments comments={outdated} api={api} />

      {adding !== null ? (
        <CommentForm
          placeholder={
            adding === "global"
              ? "Something about the change as a whole…"
              : "Something about the message…"
          }
          onSubmit={async (body, kind) => {
            await api.addComment({ scope: adding, kind, body });
            setAdding(null);
          }}
          onCancel={() => setAdding(null)}
        />
      ) : (
        <button
          type="button"
          className="mt-1 text-[var(--rg-text-muted)]"
          onClick={() => setAdding("global")}
        >
          + general remark
        </button>
      )}
    </div>
  );
}

/**
 * Comments whose line can no longer be found in this round (§5). They stay visible —
 * you want to see what you remarked on earlier — but no longer count as open.
 */
function OutdatedComments({ comments, api }: { comments: readonly Comment[]; api: ReviewApi }) {
  const [open, setOpen] = useState(false);
  if (comments.length === 0) return null;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[var(--rg-text-faint)]"
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Outdated ({comments.length})
      </button>
      {open && comments.map((c) => <CommentThread key={c.id} comment={c} api={api} />)}
    </div>
  );
}
