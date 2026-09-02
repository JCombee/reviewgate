import type { CommentKind } from "@reviewgate/core/api";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * Formulier voor een nieuwe comment of een reactie. Bewust klein: een tekstvlak,
 * de keuze tussen opmerking en vraag, en versturen met ⌘↵ (§8).
 */
export function CommentForm({
  initialBody = "",
  submitLabel = "Plaats",
  withKind = true,
  placeholder = "Wat valt je op?",
  onSubmit,
  onCancel,
}: {
  initialBody?: string;
  submitLabel?: string;
  withKind?: boolean;
  placeholder?: string;
  onSubmit: (body: string, kind: CommentKind) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const [kind, setKind] = useState<CommentKind>("issue");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = async () => {
    if (body.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body, kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className="border-y border-[var(--rg-border)] bg-[var(--rg-bg-raised)] px-3 py-2"
      data-comment-form
    >
      <textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full resize-y rounded border border-[var(--rg-border)] bg-[var(--rg-bg)] px-2 py-1 font-[family-name:var(--rg-font-ui)]"
      />
      {error && (
        <p className="mt-1" style={{ color: "var(--rg-status-deleted)" }}>
          {error}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || body.trim() === ""}
          onClick={() => void submit()}
          className="rounded border border-[var(--rg-border-strong)] px-2 py-0.5 disabled:opacity-40"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-0.5 text-[var(--rg-text-muted)]"
        >
          Annuleer
        </button>

        {withKind && (
          <label className="ml-auto flex items-center gap-1 text-[var(--rg-text-muted)]">
            <input
              type="checkbox"
              checked={kind === "question"}
              onChange={(e) => setKind(e.target.checked ? "question" : "issue")}
            />
            Dit is een vraag
          </label>
        )}
        <span className="text-[var(--rg-text-faint)]">⌘↵</span>
      </div>
    </div>
  );
}
