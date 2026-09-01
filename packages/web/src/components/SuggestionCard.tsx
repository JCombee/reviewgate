import type { Severity, Suggestion } from "@reviewgate/core/api";
import { useState } from "react";
import type { ReviewApi } from "../lib/reviewClient.js";
import { CommentForm } from "./CommentForm.jsx";

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  blocker: "blocker",
  aandachtspunt: "aandachtspunt",
  nit: "nit",
};

const SEVERITY_COLOR: Readonly<Record<Severity, string>> = {
  blocker: "var(--rg-status-deleted)",
  aandachtspunt: "var(--rg-status-modified)",
  nit: "var(--rg-text-faint)",
};

/**
 * Een voorstel van de automatische pass (§9).
 *
 * Visueel bewust anders dan een comment: gestippelde rand, badge "Voorstel", gedempte
 * kleur. Zolang je niets doet blijft het een voorstel en verandert er niets aan de
 * review — het telt niet mee voor de knop en gaat niet naar Claude.
 */
export function SuggestionCard({
  suggestion,
  api,
  onDiscuss,
}: {
  suggestion: Suggestion;
  api: ReviewApi;
  onDiscuss: (suggestion: Suggestion) => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const auto = suggestion.dismissedReason === "auto_duplicate";
  const dismissed = suggestion.status === "dismissed";

  return (
    <div
      className={`my-1 rounded border border-dashed border-[var(--rg-border-strong)] bg-[var(--rg-bg)] px-3 py-2 ${
        dismissed ? "opacity-60" : ""
      }`}
      data-suggestion-id={suggestion.id}
    >
      <div className="flex items-center gap-2 text-[var(--rg-text-faint)]">
        <span className="rounded border border-[var(--rg-border)] px-1">Voorstel</span>
        <span style={{ color: SEVERITY_COLOR[suggestion.severity] }}>
          {SEVERITY_LABEL[suggestion.severity]}
        </span>
        <span>· ronde {suggestion.round}</span>
        {suggestion.startLine !== undefined && (
          <span className="rg-code">
            {suggestion.endLine && suggestion.endLine !== suggestion.startLine
              ? `L${suggestion.startLine}-${suggestion.endLine}`
              : `L${suggestion.startLine}`}
          </span>
        )}
      </div>

      <p className="mt-1 whitespace-pre-wrap text-[var(--rg-text-muted)]">{suggestion.body}</p>

      {auto && (
        <p className="mt-1 text-[var(--rg-text-faint)]">
          Automatisch afgewezen — je hebt dit eerder al afgewezen.
        </p>
      )}

      {accepting ? (
        <div className="mt-2">
          <CommentForm
            initialBody={suggestion.body}
            submitLabel="Neem over"
            onSubmit={async (body) => {
              await api.acceptSuggestion(suggestion.id, body);
              setAccepting(false);
            }}
            onCancel={() => setAccepting(false)}
          />
        </div>
      ) : (
        <div className="mt-2 flex gap-3 text-[var(--rg-text-muted)]">
          {suggestion.status === "pending" && (
            <>
              <button type="button" onClick={() => setAccepting(true)}>
                Overnemen
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => api.dismissSuggestion(suggestion.id))}
              >
                Afwijzen
              </button>
              <button type="button" onClick={() => onDiscuss(suggestion)}>
                Bespreken
              </button>
            </>
          )}
          {dismissed && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => api.reopenSuggestion(suggestion.id))}
            >
              Heropen
            </button>
          )}
          {suggestion.status === "accepted" && (
            <span className="text-[var(--rg-text-faint)]">Overgenomen als comment.</span>
          )}
        </div>
      )}
    </div>
  );
}

/** De ingeklapte sectie met wat je hebt afgewezen; die blijft altijd zichtbaar (§9). */
export function DismissedSuggestions({
  suggestions,
  api,
  onDiscuss,
}: {
  suggestions: readonly Suggestion[];
  api: ReviewApi;
  onDiscuss: (suggestion: Suggestion) => void;
}) {
  const [open, setOpen] = useState(false);
  if (suggestions.length === 0) return null;

  return (
    <div className="px-3 py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[var(--rg-text-faint)]"
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Afgewezen ({suggestions.length})
      </button>
      {open &&
        suggestions.map((s) => (
          <SuggestionCard key={s.id} suggestion={s} api={api} onDiscuss={onDiscuss} />
        ))}
    </div>
  );
}
