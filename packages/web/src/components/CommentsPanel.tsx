import type {
  Comment,
  CommentScope,
  Review,
  ReviewSummary,
  Suggestion,
  SuggestionStatus,
} from "@reviewgate/core/api";
import { useMemo, useState } from "react";
import type { ReviewApi } from "../lib/reviewClient.js";
import { SuggestionCard } from "./SuggestionCard.jsx";

/**
 * Every comment in the review in one list, next to the conversation (§8).
 *
 * The diff shows a comment where it belongs; this panel shows what is still waiting
 * without scrolling for it. Clicking one takes you to the thread itself — the list
 * is a way in, not a second place to hold the discussion.
 */

export type Filter = "open" | "all" | "resolved" | "outdated";

const FILTERS: readonly Filter[] = ["open", "all", "resolved", "outdated"];

const FILTER_LABEL: Readonly<Record<Filter, string>> = {
  open: "Open",
  all: "All",
  resolved: "Resolved",
  outdated: "Outdated",
};

/**
 * How a `SuggestionStatus` maps onto the existing comment `Filter` tabs (Story 3.3).
 *
 * - `pending` is the analogue of an open comment — it's still waiting on a decision.
 * - `dismissed` is the analogue of a resolved comment — it's been dealt with.
 * - `accepted` maps to `null`, meaning "never shown as a suggestion row, under any
 *   filter, including All": accepting a suggestion already creates a real `Comment`
 *   (linked via `promotedToCommentId`/`fromSuggestion`), which is what shows in the
 *   list from that point on. Showing the original suggestion too would double-count
 *   the same feedback. This is why a review with only accepted suggestions reads
 *   identically to a comments-only review.
 * - There is no `outdated` analogue for suggestions at all (they close outright via
 *   `closeOpenSuggestions` at decision time, they don't go stale across rounds like a
 *   comment can) — so no suggestion ever appears under the "Outdated" tab.
 *
 * AC #4 ("under All, every suggestion appears regardless of status") is read together
 * with the `accepted` carve-out above, which the Testing section locks in explicitly
 * (an accepted suggestion "appears nowhere as a suggestion row" and a review with only
 * accepted suggestions "should look identical to a comments-only view"): "regardless
 * of status" distinguishes pending vs. dismissed suggestions (All doesn't apply the
 * Open/Resolved-style split to them) — it does not reopen the already-decided
 * accepted-suggestions-are-never-suggestion-rows rule.
 */
const SUGGESTION_FILTER: Readonly<Record<SuggestionStatus, Filter | null>> = {
  pending: "open",
  dismissed: "resolved",
  accepted: null,
};

/**
 * A row in the merged list: either a real comment or a suggestion from the automatic
 * pass (§9). Presentation-only — the underlying `Comment`/`Suggestion` types are never
 * merged, so suggestions can never silently affect the approval gate.
 */
export type ReviewRow =
  | { kind: "comment"; comment: Comment }
  | { kind: "suggestion"; suggestion: Suggestion };

function rowId(row: ReviewRow): string {
  return row.kind === "comment" ? row.comment.id : row.suggestion.id;
}

function rowScope(row: ReviewRow): CommentScope {
  return row.kind === "comment" ? row.comment.scope : row.suggestion.scope;
}

function rowPath(row: ReviewRow): string | undefined {
  return row.kind === "comment" ? row.comment.path : row.suggestion.path;
}

function rowStartLine(row: ReviewRow): number | undefined {
  return row.kind === "comment" ? row.comment.startLine : row.suggestion.startLine;
}

function rowCreatedAt(row: ReviewRow): string {
  return row.kind === "comment" ? row.comment.createdAt : row.suggestion.createdAt;
}

export function CommentsPanel({
  summary,
  review,
  api,
  onSelect,
  onDiscuss,
}: {
  summary: ReviewSummary;
  review: Review;
  api: ReviewApi;
  /** Take the reader to the thread in the diff or in the overview. */
  onSelect: (comment: Comment) => void;
  /**
   * Same callback shape App.tsx already threads into `Overview`/`FilePanel` as
   * `onDiscuss` (opens the chat panel with a draft about the suggestion). Optional
   * here because `CommentsPanel`'s own call site in App.tsx does not pass it yet —
   * see this story's Dev Agent Record for the flagged, out-of-scope follow-up.
   */
  onDiscuss?: (suggestion: Suggestion) => void;
}) {
  const [filter, setFilter] = useState<Filter>("open");

  // Comment-only, unchanged from before Story 3.3 — "Open 3" must keep meaning
  // "3 comments", not silently grow to include suggestions (AC #5).
  const counts = useMemo(() => {
    const c = { open: 0, all: review.comments.length, resolved: 0, outdated: 0 };
    for (const comment of review.comments) c[comment.status] += 1;
    return c;
  }, [review.comments]);

  // Suggestions get their own, separately labeled count per tab (AC #5) rather than
  // being folded into `counts` above.
  const suggestionCounts = useMemo(() => computeSuggestionCounts(review.suggestions), [review.suggestions]);

  const rows = useMemo<ReviewRow[]>(
    () => [
      ...review.comments.map((comment): ReviewRow => ({ kind: "comment", comment })),
      ...review.suggestions.map((suggestion): ReviewRow => ({ kind: "suggestion", suggestion })),
    ],
    [review.comments, review.suggestions],
  );

  const groups = useMemo(() => groupRows(rows, summary, filter), [rows, summary, filter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--rg-border)] px-3 py-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={`rounded border px-1.5 py-0.5 tabular-nums ${
              filter === f
                ? "border-[var(--rg-border-strong)] bg-[var(--rg-bg-raised)] text-[var(--rg-text)]"
                : "border-transparent text-[var(--rg-text-muted)]"
            }`}
          >
            {FILTER_LABEL[f]} {counts[f]}
            {suggestionCounts[f] > 0 && (
              <span
                className="ml-1 text-[var(--rg-text-faint)]"
                title={`${suggestionCounts[f]} ${suggestionCounts[f] === 1 ? "suggestion" : "suggestions"}`}
              >
                +{suggestionCounts[f]} suggestion{suggestionCounts[f] === 1 ? "" : "s"}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="px-3 py-2 text-[var(--rg-text-faint)]">
            {review.comments.length === 0 && review.suggestions.length === 0
              ? "No comments yet. Drag along the gutter of the diff to place one."
              : `No ${FILTER_LABEL[filter].toLowerCase()} comments.`}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.key}>
              <h3 className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-[var(--rg-border)] bg-[var(--rg-bg-sunken)] px-3 py-1">
                <span className="min-w-0 truncate">
                  <span className="text-[var(--rg-text-faint)]">{group.dir}</span>
                  {group.label}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-[var(--rg-text-faint)]">
                  {group.rows.length}
                </span>
              </h3>
              <ul>
                {group.rows.map((row) => (
                  <li key={`${row.kind}:${rowId(row)}`}>
                    {row.kind === "comment" ? (
                      <CommentRow comment={row.comment} api={api} onSelect={onSelect} />
                    ) : (
                      <SuggestionCard
                        suggestion={row.suggestion}
                        api={api}
                        onDiscuss={onDiscuss ?? NOOP_DISCUSS}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  api,
  onSelect,
}: {
  comment: Comment;
  api: ReviewApi;
  onSelect: (comment: Comment) => void;
}) {
  const [busy, setBusy] = useState(false);
  const muted = comment.status !== "open";

  return (
    <div
      className={`flex items-start gap-2 border-b border-[var(--rg-border)] px-3 py-2 hover:bg-[var(--rg-bg-raised)] ${
        muted ? "opacity-70" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(comment)}
        className="min-w-0 flex-1 text-left"
        title="Go to this comment"
      >
        <span className="flex flex-wrap items-center gap-x-2 text-[var(--rg-text-faint)]">
          <span>{comment.author === "user" ? "you" : "agent"}</span>
          {comment.scope === "line" && comment.startLine !== undefined && (
            <span className="rg-code">{lineLabel(comment)}</span>
          )}
          {comment.kind === "question" && (
            <span style={{ color: "var(--rg-status-renamed)" }}>question</span>
          )}
          {comment.status !== "open" && <span>{comment.status}</span>}
          {comment.replies.length > 0 && (
            <span className="tabular-nums">
              {comment.replies.length} {comment.replies.length === 1 ? "reply" : "replies"}
            </span>
          )}
        </span>
        <span className="mt-0.5 line-clamp-3 block whitespace-pre-wrap">{comment.body}</span>
      </button>

      {comment.status !== "outdated" && (
        <button
          type="button"
          disabled={busy}
          className="shrink-0 text-[var(--rg-text-muted)] disabled:opacity-40"
          onClick={async () => {
            setBusy(true);
            try {
              await api.setResolved(comment.id, comment.status !== "resolved");
            } finally {
              setBusy(false);
            }
          }}
        >
          {comment.status === "resolved" ? "Reopen" : "Resolve"}
        </button>
      )}
    </div>
  );
}

/**
 * Until App.tsx's `<CommentsPanel>` call site is updated to pass its existing
 * `onDiscuss` callback through (see the Dev Agent Record for Story 3.2), clicking
 * "Discuss" on a suggestion in this list is a no-op rather than a crash.
 */
function NOOP_DISCUSS(): void {}

interface Group {
  key: string;
  /** The file name, or the name of the section for comments without a file. */
  label: string;
  /** The directory in front of the file name, rendered fainter. */
  dir: string;
  rows: ReviewRow[];
}

/**
 * General remarks first, then the commit message, then the files in the order of the
 * diff. Rows on a file that is no longer in this round land at the bottom.
 */
export function groupRows(rows: readonly ReviewRow[], summary: ReviewSummary, filter: Filter): Group[] {
  const kept = rows.filter((row) => {
    if (row.kind === "comment") return filter === "all" || row.comment.status === filter;
    const mapped = SUGGESTION_FILTER[row.suggestion.status];
    if (mapped === null) return false; // accepted: never a suggestion row, under any tab
    return filter === "all" || mapped === filter;
  });
  const order = new Map(summary.files.map((f) => [f.path, f.index]));

  const global: ReviewRow[] = [];
  const message: ReviewRow[] = [];
  const byPath = new Map<string, ReviewRow[]>();

  for (const row of kept) {
    const scope = rowScope(row);
    if (scope === "global") global.push(row);
    else if (scope === "commit_message") message.push(row);
    else {
      const path = rowPath(row) ?? "(unknown file)";
      const list = byPath.get(path);
      if (list) list.push(row);
      else byPath.set(path, [row]);
    }
  }

  const groups: Group[] = [];
  if (global.length > 0) groups.push({ key: "global", label: "General", dir: "", rows: global });
  if (message.length > 0) {
    groups.push({ key: "commit_message", label: "Commit message", dir: "", rows: message });
  }

  const paths = [...byPath.keys()].sort((a, b) => {
    const ia = order.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ib = order.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ia === ib ? a.localeCompare(b) : ia - ib;
  });

  for (const path of paths) {
    const name = path.split("/").pop() ?? path;
    groups.push({
      key: `file:${path}`,
      label: name,
      dir: path.slice(0, path.length - name.length),
      rows: (byPath.get(path) ?? []).slice().sort(byLine),
    });
  }
  return groups;
}

export function byLine(a: ReviewRow, b: ReviewRow): number {
  const la = rowStartLine(a) ?? 0;
  const lb = rowStartLine(b) ?? 0;
  return la === lb ? rowCreatedAt(a).localeCompare(rowCreatedAt(b)) : la - lb;
}

/**
 * How many suggestions would show under each filter tab, per the `SUGGESTION_FILTER`
 * mapping — kept separate from `counts` (comment-only) so the tab counts stay honest
 * (AC #5). Accepted suggestions are never counted anywhere, including "all", since
 * they render as their promoted comment instead (see `SUGGESTION_FILTER`'s doc comment).
 */
export function computeSuggestionCounts(
  suggestions: readonly Suggestion[],
): Record<Filter, number> {
  const c: Record<Filter, number> = { open: 0, all: 0, resolved: 0, outdated: 0 };
  for (const s of suggestions) {
    const mapped = SUGGESTION_FILTER[s.status];
    if (mapped === null) continue;
    c.all += 1;
    c[mapped] += 1;
  }
  return c;
}

function lineLabel(comment: Comment): string {
  return comment.endLine && comment.endLine !== comment.startLine
    ? `L${comment.startLine}-${comment.endLine}`
    : `L${comment.startLine}`;
}
