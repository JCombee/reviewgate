import type { Severity, Suggestion } from "@reviewgate/core/api";
import { useState } from "react";
import type { ReviewApi } from "../lib/reviewClient.js";
import { CommentForm } from "./CommentForm.jsx";

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  blocker: "blocker",
  consideration: "consideration",
  nit: "nit",
};

const SEVERITY_COLOR: Readonly<Record<Severity, string>> = {
  blocker: "var(--rg-status-deleted)",
  consideration: "var(--rg-status-modified)",
  nit: "var(--rg-text-faint)",
};

/**
 * A suggestion from the automatic pass (§9).
 *
 * Deliberately different from a comment: a dashed border, a "Suggestion" badge, muted
 * colour. As long as you do nothing it stays a suggestion and nothing about the review
 * changes — it does not count towards the button and it does not go to Claude.
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
        <span className="rounded border border-[var(--rg-border)] px-1">Suggestion</span>
        <span style={{ color: SEVERITY_COLOR[suggestion.severity] }}>
          {SEVERITY_LABEL[suggestion.severity]}
        </span>
        <span>· round {suggestion.round}</span>
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
          Dismissed automatically — you already dismissed this earlier.
        </p>
      )}

      {accepting ? (
        <div className="mt-2">
          <CommentForm
            initialBody={suggestion.body}
            submitLabel="Accept"
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
                Accept
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => api.dismissSuggestion(suggestion.id))}
              >
                Dismiss
              </button>
              <button type="button" onClick={() => onDiscuss(suggestion)}>
                Discuss
              </button>
            </>
          )}
          {dismissed && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => api.reopenSuggestion(suggestion.id))}
            >
              Reopen
            </button>
          )}
          {suggestion.status === "accepted" && (
            <span className="text-[var(--rg-text-faint)]">Accepted as a comment.</span>
          )}
        </div>
      )}
    </div>
  );
}

/** The collapsed section with what you dismissed; it always stays visible (§9). */
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
        {open ? "▾" : "▸"} Dismissed ({suggestions.length})
      </button>
      {open &&
        suggestions.map((s) => (
          <SuggestionCard key={s.id} suggestion={s} api={api} onDiscuss={onDiscuss} />
        ))}
    </div>
  );
}
