import type { Review } from "@reviewgate/core/api";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { Ctx } from "../api.js";

/**
 * De actiebalk onderaan: de kern van het scherm (§8).
 *
 * Eén knop die van rol wisselt, geen twee knoppen naast elkaar. Met openstaande
 * comments is Request changes de enige mogelijke actie; wil je toch approven, dan
 * resolve of verwijder je die comments eerst. Dat is een bewuste handeling die in
 * de historie staat, geen afwijking die je wegklikt.
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

  // ⌘⇧↵ voert de primaire actie uit, waar de focus ook staat (§8).
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
            ? "Goedgekeurd — de commit loopt door."
            : "Changes requested — de feedback staat in de sessie."}
        </span>
        <span className="text-[var(--rg-text-faint)]">Dit venster kan dicht.</span>
      </footer>
    );
  }

  return (
    <footer className="flex h-12 shrink-0 items-center gap-3 border-t border-[var(--rg-border)] bg-[var(--rg-bg-raised)] px-3">
      <span className="tabular-nums text-[var(--rg-text-muted)]">
        {open.length} openstaand
        {outdated.length > 0 && ` · ${outdated.length} verouderd`}
      </span>

      <input
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={onSummaryKey}
        placeholder="Richting voor de volgende ronde, optioneel"
        aria-label="Samenvatting"
        className="min-w-0 flex-1 rounded border border-[var(--rg-border)] bg-[var(--rg-bg)] px-2 py-1"
      />

      {error && (
        <span style={{ color: "var(--rg-status-deleted)" }} role="alert">
          {error}
        </span>
      )}

      {/*
        Vaste breedte voor het langste label, zodat de wissel alleen kleur en tekst
        verandert en niets verspringt (§8).
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
