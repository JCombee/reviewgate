import type { Comment, Review, Suggestion } from "@reviewgate/core/api";
import { useEffect, useState } from "react";
import type { ReviewApi } from "../lib/reviewClient.js";
import { CommentForm } from "./CommentForm.jsx";
import { CommentThread } from "./CommentThread.jsx";
import { DismissedSuggestions, SuggestionCard } from "./SuggestionCard.jsx";

/**
 * Het overzicht boven de bestandenlijst: de commit message en de globale comments.
 *
 * De message is zowel bewerkbaar als becommentarieerbaar, en die twee staan los van
 * elkaar (§8): jij kunt hem goedzetten, óf Claude vragen hem zelf te herzien, of
 * allebei.
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

  // De review kan ook van buitenaf wijzigen (SSE); dan loopt het veld mee zolang
  // je er niet zelf in staat te typen.
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
          Handmatige review — er is geen commit message onderschept.
        </p>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void saveMessage()}
            rows={3}
            className="rg-code w-full resize-y rounded border border-[var(--rg-border)] bg-[var(--rg-bg-raised)] px-2 py-1"
          />
          <div className="mt-1 flex items-center gap-3 text-[var(--rg-text-muted)]">
            <button type="button" onClick={() => setAdding("commit_message")}>
              Comment op de message
            </button>
            {edited !== null && (
              <button type="button" onClick={() => setShowOriginal((v) => !v)}>
                {showOriginal ? "verberg origineel" : "toon origineel"}
              </button>
            )}
            {saved && <span className="text-[var(--rg-text-faint)]">bewaard</span>}
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
              Let op: de message is inmiddels ook zelf aangepast.
            </p>
          )}
          {messageComments.map((c) => (
            <CommentThread key={c.id} comment={c} api={api} />
          ))}
        </div>
      )}

      <h2 className="mt-4 mb-1 text-[11px] uppercase tracking-wide text-[var(--rg-text-faint)]">
        Algemeen
      </h2>
      {globals.length === 0 && adding !== "global" && (
        <p className="text-[var(--rg-text-faint)]">Nog geen algemene opmerkingen.</p>
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
            adding === "global" ? "Iets over de wijziging als geheel…" : "Iets over de message…"
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
          + algemene opmerking
        </button>
      )}
    </div>
  );
}

/**
 * Comments waarvan de regel in deze ronde niet meer terug te vinden is (§5). Ze
 * blijven zichtbaar — je wil kunnen zien wat je eerder opmerkte — maar tellen niet
 * meer mee als openstaand.
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
        {open ? "▾" : "▸"} Verouderd ({comments.length})
      </button>
      {open && comments.map((c) => <CommentThread key={c.id} comment={c} api={api} />)}
    </div>
  );
}
