import type { PassStatus, Review } from "@reviewgate/core/api";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Ctx } from "../api.js";
import type { ReviewApi } from "../lib/reviewClient.js";

/**
 * Het chatpaneel naast de diff (§9).
 *
 * De assistent leest mee in de repo en in het transcript van de sessie die de code
 * schreef, maar wijzigt niets. Antwoorden komen woord voor woord binnen over SSE.
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
  /** Het antwoord dat nu binnenkomt, nog niet in de review opgeslagen. */
  streaming: string | null;
  passStatus: PassStatus;
  /** Tekst die vanuit een voorstel naar de chat is gestuurd ("Bespreken"). */
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
    // Meteen leegmaken: het antwoord streamt en dat duurt; je vraag staat dan al
    // in het gesprek en hoort niet ook nog in het invoerveld te blijven staan.
    setText("");
    try {
      await api.chat(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Bij een fout krijg je je vraag terug, zodat je hem niet opnieuw hoeft te typen.
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
          Gesprek
        </span>
        <PassIndicator status={passStatus} onRestart={() => void api.restartPass()} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {review.chat.length === 0 && streaming === null && (
          <p className="text-[var(--rg-text-faint)]">
            Vraag iets over deze wijziging. De assistent leest de repo en het transcript van de
            sessie die de code schreef, en wijzigt niets.
          </p>
        )}

        {review.chat.map((m) => (
          <div key={m.id} className="mb-3">
            <p className="text-[var(--rg-text-faint)]">{m.role === "user" ? "jij" : "assistent"}</p>
            <p className="whitespace-pre-wrap">{m.body}</p>
          </div>
        ))}

        {streaming !== null && (
          <div className="mb-3">
            <p className="text-[var(--rg-text-faint)]">assistent</p>
            <p className="whitespace-pre-wrap">{streaming}</p>
          </div>
        )}

        {error && (
          <p style={{ color: "var(--rg-status-deleted)" }}>
            {error}
            <br />
            <span className="text-[var(--rg-text-faint)]">
              Zonder de assistent werkt de rest van de review gewoon door.
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
          placeholder="vraag…"
          aria-label="Vraag aan de assistent"
          className="w-full resize-y rounded border border-[var(--rg-border)] bg-[var(--rg-bg)] px-2 py-1"
        />
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            disabled={busy || text.trim() === ""}
            onClick={() => void send()}
            className="rounded border border-[var(--rg-border-strong)] px-2 py-0.5 disabled:opacity-40"
          >
            Vraag
          </button>
          <span className="text-[var(--rg-text-faint)]">⌘↵</span>
          <button
            type="button"
            disabled={text.trim() === ""}
            className="ml-auto text-[var(--rg-text-muted)] disabled:opacity-40"
            title="Zet je vraag als vraag-comment in de review"
            onClick={() => {
              void api.addComment({ scope: "global", kind: "question", body: text });
              setText("");
            }}
          >
            Vraag het de auteur
          </button>
        </div>
      </div>

      <p className="border-t border-[var(--rg-border)] px-3 py-1 text-[var(--rg-text-faint)]">
        Read-only: de assistent leest, hij wijzigt niets.
      </p>
    </div>
  );
}

/** De stand van de automatische pass: een rustige regel, nooit een spinner of modal (§9). */
function PassIndicator({ status, onRestart }: { status: PassStatus; onRestart: () => void }) {
  if (status.state === "running") {
    return <span className="text-[var(--rg-text-faint)]">voorstellen zoeken…</span>;
  }
  if (status.state === "done") {
    return (
      <span className="text-[var(--rg-text-faint)]">
        {status.count === 0 ? "geen voorstellen" : `${status.count} voorstellen`}
      </span>
    );
  }
  if (status.state === "failed") {
    return (
      <span className="text-[var(--rg-text-faint)]" title={status.error}>
        voorstellen mislukt ·{" "}
        <button type="button" onClick={onRestart} className="underline">
          opnieuw
        </button>
      </span>
    );
  }
  return (
    <button type="button" onClick={onRestart} className="text-[var(--rg-text-faint)] underline">
      voorstellen zoeken
    </button>
  );
}
