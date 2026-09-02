import type { Review } from "@reviewgate/core/api";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { Ctx } from "../api.js";

/**
 * The action bar at the bottom: the heart of the screen (§8).
 *
 * One button that switches roles, not two buttons side by side. With open comments,
 * Request changes is the only possible action; if you do want to approve, you resolve
 * or delete those comments first. That is a deliberate act that shows up in the
 * history, not a deviation you click away.
 */
export function ActionBar({
  ctx,
  review,
  onDecided,
}: {
  ctx: Ctx;
  review: Review;
  onDecided: (review: Review) => void;
}) {
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = review.comments.filter((c) => c.status === "open");
  const outdated = review.comments.filter((c) => c.status === "outdated");
  const decision = open.length === 0 ? "approve" : "request_changes";

  const round = review.rounds[review.rounds.length - 1];
  const decided = round?.decision != null;

  const submit = async () => {
    if (busy || decided) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${ctx.id}/decision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ctx.token}`,
        },
        body: JSON.stringify({ decision, summary: summary.trim() === "" ? null : summary }),
      });
      const payload = (await res.json()) as { review?: Review; error?: string };
      if (!res.ok) throw new Error(payload.error ?? `${res.status}`);
      if (payload.review) onDecided(payload.review);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // ⌘⇧↵ performs the primary action, wherever the focus happens to be (§8).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onSummaryKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  if (decided) {
    return (
      <footer className="flex h-12 shrink-0 items-center gap-3 border-t border-[var(--rg-border)] bg-[var(--rg-bg-raised)] px-3">
        <span
          style={{
            color: round?.decision === "approve" ? "var(--rg-approve)" : "var(--rg-changes)",
          }}
        >
          {round?.decision === "approve"
            ? "Approved — the commit goes through."
            : "Changes requested — the feedback is in the session."}
        </span>
        <span className="text-[var(--rg-text-faint)]">You can close this window.</span>
      </footer>
    );
  }

  return (
    <footer className="flex h-12 shrink-0 items-center gap-3 border-t border-[var(--rg-border)] bg-[var(--rg-bg-raised)] px-3">
      <span className="tabular-nums text-[var(--rg-text-muted)]">
        {open.length} open
        {outdated.length > 0 && ` · ${outdated.length} outdated`}
      </span>

      <input
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={onSummaryKey}
        placeholder="Direction for the next round, optional"
        aria-label="Summary"
        className="min-w-0 flex-1 rounded border border-[var(--rg-border)] bg-[var(--rg-bg)] px-2 py-1"
      />

      {error && (
        <span style={{ color: "var(--rg-status-deleted)" }} role="alert">
          {error}
        </span>
      )}

      {/*
        A fixed width for the longest label, so the switch changes only colour and text
        and nothing jumps (§8).
      */}
      <button
        type="button"
        disabled={busy}
        onClick={() => void submit()}
        data-decision={decision}
        title="⌘⇧↵"
        className="rg-primary w-44 shrink-0 rounded px-3 py-1.5 font-semibold text-white disabled:opacity-60"
        style={{
          background: decision === "approve" ? "var(--rg-approve)" : "var(--rg-changes)",
        }}
      >
        {decision === "approve" ? "Approve" : "Request changes"}
      </button>
    </footer>
  );
}
