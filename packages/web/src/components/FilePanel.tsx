import type { FileDetail, FileSummary } from "@reviewgate/core/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchFile, type Ctx } from "../api.js";
import { linesFromTokens } from "../lib/code.js";
import {
  buildRows,
  computeGaps,
  expand,
  toSplitRows,
  type ExpansionState,
} from "../lib/rows.js";
import { SplitRows, UnifiedRows } from "./Diff.jsx";
import { StatusBadge } from "./StatusBadge.jsx";

/** Boven dit aantal gewijzigde regels staat een bestand dichtgeklapt (§12). */
const LARGE_FILE_LINES = 2000;

export interface FilePanelProps {
  ctx: Ctx;
  file: FileSummary;
  view: "unified" | "split";
  registerRef: (index: number, el: HTMLElement | null) => void;
}

export function FilePanel({ ctx, file, view, registerRef }: FilePanelProps) {
  const isLarge = file.additions + file.deletions > LARGE_FILE_LINES;
  const [open, setOpen] = useState(!isLarge);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expansion, setExpansion] = useState<ExpansionState>({});
  const [visible, setVisible] = useState(false);

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
    const linesOld = linesFromTokens(detail.highlight.old);
    const linesNew = linesFromTokens(detail.highlight.new);
    return buildRows({
      hunks: detail.file.hunks,
      oldLineCount: detail.oldLineCount,
      newLineCount: detail.newLineCount,
      linesOld,
      linesNew,
      expansion,
    });
  }, [detail, expansion]);

  const splitRows = useMemo(
    () => (rows && view === "split" ? toSplitRows(rows) : null),
    [rows, view],
  );

  return (
    <section
      ref={setHost}
      data-file-index={file.index}
      className="border-b border-[var(--rg-border)]"
    >
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
                <SplitRows rows={splitRows} detail={detail} onExpand={onExpand} />
              ) : (
                <UnifiedRows rows={rows} detail={detail} onExpand={onExpand} />
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
