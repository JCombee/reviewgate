import type { Comment, FileDetail, FileSummary, Review, Side } from "@reviewgate/core/api";
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

/** Boven dit aantal gewijzigde regels staat een bestand dichtgeklapt (§12). */
const LARGE_FILE_LINES = 2000;

export interface FilePanelProps {
  ctx: Ctx;
  file: FileSummary;
  view: "unified" | "split";
  review: Review;
  api: ReviewApi;
  registerRef: (index: number, el: HTMLElement | null) => void;
}

export function FilePanel({ ctx, file, view, review, api, registerRef }: FilePanelProps) {
  const isLarge = file.additions + file.deletions > LARGE_FILE_LINES;
  const [open, setOpen] = useState(!isLarge);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expansion, setExpansion] = useState<ExpansionState>({});
  const [visible, setVisible] = useState(false);

  /** De lopende sleepselectie in de goot; null zodra het formulier open staat. */
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

  // Pas laden wanneer het bestand in of vlak bij beeld komt. Zo blijft een diff
  // van duizenden regels direct bruikbaar: de eerste schermen staan er meteen,
  // de rest komt eronder terwijl je scrollt.
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

  /** Hoeveel regels elk gat in totaal bevat; de bovengrens voor uitklappen. */
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

  // --- selectie in de goot -------------------------------------------------
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

  // Loslaten buiten de goot moet de selectie ook afronden, anders blijf je slepen.
  useEffect(() => {
    if (!dragging) return;
    const up = () => gutter.onEnd();
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [dragging, gutter]);

  /** Comments van dit bestand, gegroepeerd op de regel waar ze onder horen. */
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
      const threads = commentsByAnchor.get(`${side}:${line}`) ?? [];
      const showForm = form !== null && form.side === side && form.end === line;
      if (threads.length === 0 && !showForm) return null;

      return (
        <>
          {threads.map((c) => (
            <CommentThread key={c.id} comment={c} api={api} />
          ))}
          {showForm && (
            <CommentForm
              placeholder={
                form.start === form.end
                  ? `Comment op regel ${form.start}`
                  : `Comment op regels ${form.start}–${form.end}`
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
    [commentsByAnchor, form, api, file.path, anchorSnippet],
  );

  const fileCommentCount = review.comments.filter(
    (c) => c.scope === "line" && c.path === file.path && c.status === "open",
  ).length;

  return (
    <section ref={setHost} data-file-index={file.index} className="border-b border-[var(--rg-border)]">
      {/* Sticky binnen de scrollende main, dus top-0: die container begint al
          onder de kopbalk van de app. */}
      <header className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--rg-bg-sunken)] border-b border-[var(--rg-border)] px-3 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-[var(--rg-text-faint)] w-4 shrink-0"
          aria-expanded={open}
          aria-label={open ? "inklappen" : "uitklappen"}
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
            "binair"
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
                ? "Submodule — inhoud wordt niet getoond."
                : "Binair bestand — geen tekstuele diff."}
            </p>
          ) : error ? (
            <p className="px-3 py-2" style={{ color: "var(--rg-status-deleted)" }}>
              Kon dit bestand niet laden: {error}
            </p>
          ) : !detail || !rows ? (
            <p className="px-3 py-2 text-[var(--rg-text-faint)]">laden…</p>
          ) : (
            <>
              {detail.highlight.skipped && (
                <p className="px-3 py-1 text-[var(--rg-text-faint)] border-b border-[var(--rg-border)]">
                  Te groot voor syntax highlighting — de diff is verder volledig.
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
          Groot bestand ({file.additions + file.deletions} gewijzigde regels) — ingeklapt.
        </p>
      )}
    </section>
  );
}

/**
 * `exactOptionalPropertyTypes` staat aan, dus een optioneel veld laat je weg in
 * plaats van het op undefined te zetten.
 */
function snippetOf(snippet: string | undefined): { anchorSnippet?: string } {
  return snippet === undefined ? {} : { anchorSnippet: snippet };
}
