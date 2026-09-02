import type { PassStatus, Review } from "@reviewgate/core/api";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Ctx } from "../api.js";
import type { ReviewApi } from "../lib/reviewClient.js";

/**
 * The chat panel next to the diff (§9).
 *
 * The assistant reads along in the repo and in the transcript of the session that
 * wrote the code, but changes nothing. Answers arrive word by word over SSE.
 */
export function ChatPanel({
  ctx,
  review,
  api,
  streaming,
  passStatus,
  draft,
  onDraftUsed,
}: {
  ctx: Ctx;
  review: Review;
  api: ReviewApi;
  /** The answer currently arriving, not yet stored in the review. */
  streaming: string | null;
  passStatus: PassStatus;
  /** Text sent to the chat from a suggestion ("Discuss"). */
  draft: string | null;
  onDraftUsed: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (draft === null) return;
    setText(draft);
    inputRef.current?.focus();
    onDraftUsed();
  }, [draft, onDraftUsed]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [review.chat.length, streaming]);

  const send = async () => {
    const message = text.trim();
    if (message === "" || busy) return;
    setBusy(true);
    setError(null);
    // Clear it right away: the answer streams and that takes a while; your question is
    // already in the conversation and should not linger in the input as well.
    setText("");
    try {
      await api.chat(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // On failure you get your question back, so you need not retype it.
      setText(message);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full flex-col border-l border-[var(--rg-border)] bg-[var(--rg-bg-sunken)]">
      <div className="flex items-center gap-2 border-b border-[var(--rg-border)] px-3 py-2">
        <span className="text-[11px] uppercase tracking-wide text-[var(--rg-text-faint)]">
          Conversation
        </span>
        <PassIndicator status={passStatus} onRestart={() => void api.restartPass()} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {review.chat.length === 0 && streaming === null && (
          <p className="text-[var(--rg-text-faint)]">
            Ask something about this change. The assistant reads the repo and the transcript of
            the session that wrote the code, and changes nothing.
          </p>
        )}

        {review.chat.map((m) => (
          <div key={m.id} className="mb-3">
            <p className="text-[var(--rg-text-faint)]">{m.role === "user" ? "you" : "assistant"}</p>
            <p className="whitespace-pre-wrap">{m.body}</p>
          </div>
        ))}

        {streaming !== null && (
          <div className="mb-3">
            <p className="text-[var(--rg-text-faint)]">assistant</p>
            <p className="whitespace-pre-wrap">{streaming}</p>
          </div>
        )}

        {error && (
          <p style={{ color: "var(--rg-status-deleted)" }}>
            {error}
            <br />
            <span className="text-[var(--rg-text-faint)]">
              Without the assistant the rest of the review carries on as normal.
            </span>
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-[var(--rg-border)] p-2">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="question…"
          aria-label="Question for the assistant"
          className="w-full resize-y rounded border border-[var(--rg-border)] bg-[var(--rg-bg)] px-2 py-1"
        />
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            disabled={busy || text.trim() === ""}
            onClick={() => void send()}
            className="rounded border border-[var(--rg-border-strong)] px-2 py-0.5 disabled:opacity-40"
          >
            Ask
          </button>
          <span className="text-[var(--rg-text-faint)]">⌘↵</span>
          <button
            type="button"
            disabled={text.trim() === ""}
            className="ml-auto text-[var(--rg-text-muted)] disabled:opacity-40"
            title="Put your question into the review as a question comment"
            onClick={() => {
              void api.addComment({ scope: "global", kind: "question", body: text });
              setText("");
            }}
          >
            Ask the author
          </button>
        </div>
      </div>

      <p className="border-t border-[var(--rg-border)] px-3 py-1 text-[var(--rg-text-faint)]">
        Read-only: the assistant reads, it changes nothing.
      </p>
    </div>
  );
}

/** The state of the automatic pass: a quiet line, never a spinner or a modal (§9). */
function PassIndicator({ status, onRestart }: { status: PassStatus; onRestart: () => void }) {
  if (status.state === "running") {
    return <span className="text-[var(--rg-text-faint)]">looking for suggestions…</span>;
  }
  if (status.state === "done") {
    return (
      <span className="text-[var(--rg-text-faint)]">
        {status.count === 0 ? "no suggestions" : `${status.count} suggestions`}
      </span>
    );
  }
  if (status.state === "failed") {
    return (
      <span className="text-[var(--rg-text-faint)]" title={status.error}>
        suggestions failed ·{" "}
        <button type="button" onClick={onRestart} className="underline">
          try again
        </button>
      </span>
    );
  }
  return (
    <button type="button" onClick={onRestart} className="text-[var(--rg-text-faint)] underline">
      look for suggestions
    </button>
  );
}
