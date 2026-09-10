import type { Comment, Review, ReviewSummary } from "@reviewgate/core/api";
import { useMemo, useState } from "react";
import type { ReviewApi } from "../lib/reviewClient.js";

/**
 * Every comment in the review in one list, next to the conversation (§8).
 *
 * The diff shows a comment where it belongs; this panel shows what is still waiting
 * without scrolling for it. Clicking one takes you to the thread itself — the list
 * is a way in, not a second place to hold the discussion.
 */

type Filter = "open" | "all" | "resolved" | "outdated";

const FILTERS: readonly Filter[] = ["open", "all", "resolved", "outdated"];

const FILTER_LABEL: Readonly<Record<Filter, string>> = {
  open: "Open",
  all: "All",
  resolved: "Resolved",
  outdated: "Outdated",
};

export function CommentsPanel({
  summary,
  review,
  api,
  onSelect,
}: {
  summary: ReviewSummary;
  review: Review;
  api: ReviewApi;
  /** Take the reader to the thread in the diff or in the overview. */
  onSelect: (comment: Comment) => void;
}) {
  const [filter, setFilter] = useState<Filter>("open");

  const counts = useMemo(() => {
    const c = { open: 0, all: review.comments.length, resolved: 0, outdated: 0 };
    for (const comment of review.comments) c[comment.status] += 1;
    return c;
  }, [review.comments]);

  const groups = useMemo(
    () => groupComments(review.comments, summary, filter),
    [review.comments, summary, filter],
  );

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
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="px-3 py-2 text-[var(--rg-text-faint)]">
            {review.comments.length === 0
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
                  {group.comments.length}
                </span>
              </h3>
              <ul>
                {group.comments.map((c) => (
                  <li key={c.id}>
                    <CommentRow comment={c} api={api} onSelect={onSelect} />
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

interface Group {
  key: string;
  /** The file name, or the name of the section for comments without a file. */
  label: string;
  /** The directory in front of the file name, rendered fainter. */
  dir: string;
  comments: Comment[];
}

/**
 * General remarks first, then the commit message, then the files in the order of the
 * diff. Comments on a file that is no longer in this round land at the bottom.
 */
function groupComments(
  comments: readonly Comment[],
  summary: ReviewSummary,
  filter: Filter,
): Group[] {
  const kept = comments.filter((c) => filter === "all" || c.status === filter);
  const order = new Map(summary.files.map((f) => [f.path, f.index]));

  const global: Comment[] = [];
  const message: Comment[] = [];
  const byPath = new Map<string, Comment[]>();

  for (const c of kept) {
    if (c.scope === "global") global.push(c);
    else if (c.scope === "commit_message") message.push(c);
    else {
      const path = c.path ?? "(unknown file)";
      const list = byPath.get(path);
      if (list) list.push(c);
      else byPath.set(path, [c]);
    }
  }

  const groups: Group[] = [];
  if (global.length > 0) groups.push({ key: "global", label: "General", dir: "", comments: global });
  if (message.length > 0) {
    groups.push({ key: "commit_message", label: "Commit message", dir: "", comments: message });
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
      comments: (byPath.get(path) ?? []).slice().sort(byLine),
    });
  }
  return groups;
}

function byLine(a: Comment, b: Comment): number {
  const la = a.startLine ?? 0;
  const lb = b.startLine ?? 0;
  return la === lb ? a.createdAt.localeCompare(b.createdAt) : la - lb;
}

function lineLabel(comment: Comment): string {
  return comment.endLine && comment.endLine !== comment.startLine
    ? `L${comment.startLine}-${comment.endLine}`
    : `L${comment.startLine}`;
}
