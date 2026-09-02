import type {
  Comment,
  FileDetail,
  FileSummary,
  Review,
  Side,
  Suggestion,
} from "@reviewgate/core/api";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchFile, type Ctx } from "../api.js";
import { linesFromTokens } from "../lib/code.js";
import type { ReviewApi } from "../lib/reviewClient.js";
import {
  buildRows,
  computeGaps,
  expand,
  toSplitRows,
  type ExpansionState,
} from "../lib/rows.js";
import { CommentForm } from "./CommentForm.jsx";
import { CommentThread } from "./CommentThread.jsx";
import { SplitRows, UnifiedRows, type LineSelection } from "./Diff.jsx";
import { StatusBadge } from "./StatusBadge.jsx";
import { DismissedSuggestions, SuggestionCard } from "./SuggestionCard.jsx";

/** Above this many changed lines a file starts collapsed (§12). */
const LARGE_FILE_LINES = 2000;

export interface FilePanelProps {
  ctx: Ctx;
  file: FileSummary;
  view: "unified" | "split";
  review: Review;
  api: ReviewApi;
  registerRef: (index: number, el: HTMLElement | null) => void;
  onDiscuss: (suggestion: Suggestion) => void;
}

export function FilePanel({
  ctx,
  file,
  view,
  review,
  api,
  registerRef,
  onDiscuss,
}: FilePanelProps) {
  const isLarge = file.additions + file.deletions > LARGE_FILE_LINES;
  const [open, setOpen] = useState(!isLarge);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expansion, setExpansion] = useState<ExpansionState>({});
  const [visible, setVisible] = useState(false);

  /** The live drag selection in the gutter; null once the form is open. */
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [form, setForm] = useState<LineSelection | null>(null);

  const hostRef = useRef<HTMLElement | null>(null);

  const setHost = useCallback(
    (el: HTMLElement | null) => {
      hostRef.current = el;
      registerRef(file.index, el);
    },
    [file.index, registerRef],
  );

  // Only load when the file comes into view or close to it. That keeps a diff of
  // thousands of lines usable straight away: the first screens are there at once and
  // the rest arrives underneath while you scroll.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || !open || detail || error) return;
    let cancelled = false;
    fetchFile(ctx, file.index).then(
      (d) => {
        if (!cancelled) setDetail(d);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ctx, file.index, visible, open, detail, error]);

  /** How many lines each gap holds in total; the ceiling for expanding. */
  const gapSizes = useMemo(() => {
    const map = new Map<number, number>();
    if (!detail) return map;
    for (const g of computeGaps({
      hunks: detail.file.hunks,
      oldLineCount: detail.oldLineCount,
      newLineCount: detail.newLineCount,
    })) {
      map.set(g.index, g.hidden);
    }
    return map;
  }, [detail]);

  const onExpand = useCallback(
    (gapIndex: number, action: "top" | "bottom" | "all") => {
      const hidden = gapSizes.get(gapIndex) ?? 0;
      setExpansion((prev) => ({ ...prev, [gapIndex]: expand(prev[gapIndex], hidden, action) }));
    },
    [gapSizes],
  );

  const rows = useMemo(() => {
    if (!detail) return null;
    return buildRows({
      hunks: detail.file.hunks,
      oldLineCount: detail.oldLineCount,
      newLineCount: detail.newLineCount,
      linesOld: linesFromTokens(detail.highlight.old),
      linesNew: linesFromTokens(detail.highlight.new),
      expansion,
    });
  }, [detail, expansion]);

  const splitRows = useMemo(
    () => (rows && view === "split" ? toSplitRows(rows) : null),
    [rows, view],
  );

  // --- selection in the gutter ---------------------------------------------
  const gutter = useMemo(
    () => ({
      onStart: (side: Side, line: number) => {
        setDragging(true);
        setForm(null);
        setSelection({ side, start: line, end: line });
      },
      onExtend: (side: Side, line: number) => {
        setDragging((isDragging) => {
          if (isDragging) {
            setSelection((prev) => (prev && prev.side === side ? { ...prev, end: line } : prev));
          }
          return isDragging;
        });
      },
      onEnd: () => {
        setDragging(false);
        setSelection((sel) => {
          if (sel) {
            setForm({
              side: sel.side,
              start: Math.min(sel.start, sel.end),
              end: Math.max(sel.start, sel.end),
            });
          }
          return sel;
        });
      },
    }),
    [],
  );

  // Releasing outside the gutter has to finish the selection too, or you keep dragging.
  useEffect(() => {
    if (!dragging) return;
    const up = () => gutter.onEnd();
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [dragging, gutter]);

  /** This file's comments, grouped by the line they belong under. */
  const commentsByAnchor = useMemo(() => {
    const map = new Map<string, Comment[]>();
    for (const c of review.comments) {
      if (c.scope !== "line" || c.path !== file.path || !c.side) continue;
      const line = c.endLine ?? c.startLine;
      if (line === undefined) continue;
      const key = `${c.side}:${line}`;
      const list = map.get(key);
      if (list) list.push(c);
      else map.set(key, [c]);
    }
    return map;
  }, [review.comments, file.path]);

  /** This file's suggestions, anchored the same way comments are. */
  const suggestionsByAnchor = useMemo(() => {
    const map = new Map<string, Suggestion[]>();
    for (const s of review.suggestions) {
      if (s.scope !== "line" || s.path !== file.path || !s.side) continue;
      if (s.status === "accepted") continue;
      const line = s.endLine ?? s.startLine;
      if (line === undefined) continue;
      const key = `${s.side}:${line}`;
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return map;
  }, [review.suggestions, file.path]);

  const anchorSnippet = useCallback(
    (side: Side, line: number): string | undefined => {
      const lines =
        side === "old"
          ? linesFromTokens(detail?.highlight.old ?? null)
          : linesFromTokens(detail?.highlight.new ?? null);
      return lines?.[line - 1];
    },
    [detail],
  );

  const below = useCallback(
    (side: Side, line: number): ReactNode => {
      const key = `${side}:${line}`;
      const threads = commentsByAnchor.get(key) ?? [];
      const suggestions = suggestionsByAnchor.get(key) ?? [];
      const pending = suggestions.filter((s) => s.status === "pending");
      const dismissed = suggestions.filter((s) => s.status === "dismissed");
      const showForm = form !== null && form.side === side && form.end === line;
      if (threads.length === 0 && suggestions.length === 0 && !showForm) return null;

      return (
        <>
          {threads.map((c) => (
            <CommentThread key={c.id} comment={c} api={api} />
          ))}
          {pending.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} api={api} onDiscuss={onDiscuss} />
          ))}
          <DismissedSuggestions suggestions={dismissed} api={api} onDiscuss={onDiscuss} />
          {showForm && (
            <CommentForm
              placeholder={
                form.start === form.end
                  ? `Comment on line ${form.start}`
                  : `Comment on lines ${form.start}–${form.end}`
              }
              onSubmit={async (body, kind) => {
                await api.addComment({
                  scope: "line",
                  kind,
                  body,
                  path: file.path,
                  side: form.side,
                  startLine: form.start,
                  endLine: form.end,
                  ...snippetOf(anchorSnippet(form.side, form.start)),
                });
                setForm(null);
                setSelection(null);
              }}
              onCancel={() => {
                setForm(null);
                setSelection(null);
              }}
            />
          )}
        </>
      );
    },
    [commentsByAnchor, suggestionsByAnchor, form, api, file.path, anchorSnippet, onDiscuss],
  );

  const fileCommentCount = review.comments.filter(
    (c) => c.scope === "line" && c.path === file.path && c.status === "open",
  ).length;

  return (
    <section ref={setHost} data-file-index={file.index} className="border-b border-[var(--rg-border)]">
      {/* Sticky inside the scrolling main, so top-0: that container already starts
          below the app header. */}
      <header className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--rg-bg-sunken)] border-b border-[var(--rg-border)] px-3 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-[var(--rg-text-faint)] w-4 shrink-0"
          aria-expanded={open}
          aria-label={open ? "collapse" : "expand"}
        >
          {open ? "▾" : "▸"}
        </button>
        <StatusBadge status={file.status} />
        <span className="rg-code truncate">
          {file.status === "renamed" || file.status === "copied" ? (
            <>
              <span className="text-[var(--rg-text-muted)]">{file.oldPath}</span>
              <span className="text-[var(--rg-text-faint)]"> → </span>
              {file.newPath}
            </>
          ) : (
            file.path
          )}
        </span>
        {fileCommentCount > 0 && (
          <span className="shrink-0 rounded bg-[var(--rg-bg-raised)] px-1 text-[var(--rg-text-muted)]">
            {fileCommentCount} open
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-[var(--rg-text-muted)]">
          {file.binary ? (
            "binary"
          ) : (
            <>
              <span style={{ color: "var(--rg-status-added)" }}>+{file.additions}</span>{" "}
              <span style={{ color: "var(--rg-status-deleted)" }}>−{file.deletions}</span>
            </>
          )}
        </span>
      </header>

      {open && (
        <div>
          {file.binary || file.submodule ? (
            <p className="px-3 py-2 text-[var(--rg-text-muted)]">
              {file.submodule
                ? "Submodule — its content is not shown."
                : "Binary file — no textual diff."}
            </p>
          ) : error ? (
            <p className="px-3 py-2" style={{ color: "var(--rg-status-deleted)" }}>
              Could not load this file: {error}
            </p>
          ) : !detail || !rows ? (
            <p className="px-3 py-2 text-[var(--rg-text-faint)]">loading…</p>
          ) : (
            <>
              {detail.highlight.skipped && (
                <p className="px-3 py-1 text-[var(--rg-text-faint)] border-b border-[var(--rg-border)]">
                  Too large for syntax highlighting — the diff itself is complete.
                </p>
              )}
              {view === "split" && splitRows ? (
                <SplitRows
                  rows={splitRows}
                  detail={detail}
                  onExpand={onExpand}
                  selection={selection}
                  gutter={gutter}
                  below={below}
                />
              ) : (
                <UnifiedRows
                  rows={rows}
                  detail={detail}
                  onExpand={onExpand}
                  selection={selection}
                  gutter={gutter}
                  below={below}
                />
              )}
            </>
          )}
        </div>
      )}

      {!open && isLarge && (
        <p className="px-3 py-2 text-[var(--rg-text-faint)]">
          Large file ({file.additions + file.deletions} changed lines) — collapsed.
        </p>
      )}
    </section>
  );
}

/**
 * `exactOptionalPropertyTypes` is on, so you leave an optional field out rather than
 * setting it to undefined.
 */
function snippetOf(snippet: string | undefined): { anchorSnippet?: string } {
  return snippet === undefined ? {} : { anchorSnippet: snippet };
}
