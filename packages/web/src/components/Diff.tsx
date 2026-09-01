import type {
  FileDetail,
  HighlightLine,
  IntralineSegment,
  PaletteEntry,
  Side,
} from "@reviewgate/core/api";
import { memo, useMemo, type CSSProperties, type ReactNode } from "react";
import { toPieces } from "../lib/code.js";
import type { ExpanderRow, HunkRow, LineRow, Row, SplitRow } from "../lib/rows.js";

/** Een lopende regelselectie in de goot: het begin en het einde van een range. */
export interface LineSelection {
  side: Side;
  start: number;
  end: number;
}

export interface GutterHandlers {
  onStart: (side: Side, line: number) => void;
  onExtend: (side: Side, line: number) => void;
  onEnd: () => void;
}

/** Tekst van één regel: shiki-tokens met de intraline-markering eroverheen. */
export const CodeText = memo(function CodeText({
  content,
  tokens,
  palette,
  segments,
  changedClass,
}: {
  content: string;
  tokens: HighlightLine | null;
  palette: readonly PaletteEntry[];
  segments: readonly IntralineSegment[];
  changedClass: string;
}) {
  const pieces = useMemo(
    () => toPieces(content, tokens, palette, segments),
    [content, tokens, palette, segments],
  );

  return (
    <>
      {pieces.map((p, i) => (
        <span
          key={i}
          className={`rg-tok${p.changed ? ` ${changedClass}` : ""}`}
          style={{ "--rg-tok-l": p.light, "--rg-tok-d": p.dark } as CSSProperties}
        >
          {p.text}
        </span>
      ))}
    </>
  );
});

function hunkLabel(row: HunkRow): string {
  const at = `@@ −${row.oldStart} +${row.newStart} @@`;
  return row.section ? `${at} ${row.section}` : at;
}

export function HunkHeaderRow({ row, columns }: { row: HunkRow; columns: number }) {
  return (
    <div
      className="rg-hunk-header rg-content"
      style={{ gridColumn: `span ${columns}` }}
      data-hunk={row.hunkIndex}
    >
      {hunkLabel(row)}
    </div>
  );
}

export function ExpanderRowView({
  row,
  columns,
  onExpand,
}: {
  row: ExpanderRow;
  columns: number;
  onExpand: (gapIndex: number, action: "top" | "bottom" | "all") => void;
}) {
  const btn =
    "px-2 py-0.5 rounded hover:bg-[var(--rg-bg-raised)] border border-transparent hover:border-[var(--rg-border)]";
  return (
    <div
      className="rg-hunk-header flex items-center gap-1 px-3 py-0.5"
      style={{ gridColumn: `span ${columns}` }}
    >
      {row.hasAbove && (
        <button type="button" className={btn} onClick={() => onExpand(row.gapIndex, "top")}>
          ↑ 10
        </button>
      )}
      {row.hasBelow && (
        <button type="button" className={btn} onClick={() => onExpand(row.gapIndex, "bottom")}>
          ↓ 10
        </button>
      )}
      <button type="button" className={btn} onClick={() => onExpand(row.gapIndex, "all")}>
        hele bestand
      </button>
      <span className="text-[var(--rg-text-faint)]">{row.hidden} regels verborgen</span>
    </div>
  );
}

/** Tokens van de regel opzoeken aan de kant waar hij vandaan komt. */
function tokensFor(detail: FileDetail, row: LineRow, side: Side): HighlightLine | null {
  const lineNo = side === "old" ? row.oldLine : row.newLine;
  if (lineNo === null) return null;
  const lines = side === "old" ? detail.highlight.old : detail.highlight.new;
  return lines?.[lineNo - 1] ?? null;
}

function segmentsFor(detail: FileDetail, row: LineRow): IntralineSegment[] {
  if (row.hunkIndex === null || row.lineIndex === null) return [];
  const pairs = detail.intraline[row.hunkIndex];
  if (!pairs) return [];
  for (const p of pairs) {
    if (p.delIndex === row.lineIndex) return p.delSegments;
    if (p.addIndex === row.lineIndex) return p.addSegments;
  }
  return [];
}

const lineClass = (type: LineRow["type"]): string =>
  type === "add" ? "rg-line-add" : type === "del" ? "rg-line-del" : "";

function inSelection(selection: LineSelection | null, side: Side, line: number | null): boolean {
  if (!selection || line === null || selection.side !== side) return false;
  const lo = Math.min(selection.start, selection.end);
  const hi = Math.max(selection.start, selection.end);
  return line >= lo && line <= hi;
}

/**
 * De goot is tegelijk regelnummer en aangrijppunt voor een comment: klikken geeft
 * één regel, slepen een range (§8). Daarom pointer-events in plaats van een klik:
 * anders kun je alleen losse regels becommentariëren.
 */
function Gutter({
  side,
  line,
  cls,
  selection,
  gutter,
}: {
  side: Side;
  line: number | null;
  cls: string;
  selection: LineSelection | null;
  gutter: GutterHandlers | null;
}) {
  const selected = inSelection(selection, side, line);
  const clickable = gutter !== null && line !== null;

  return (
    <span
      className={`rg-gutter ${cls} ${selected ? "rg-gutter-selected" : ""} ${
        clickable ? "rg-gutter-clickable" : ""
      }`}
      data-side={side}
      {...(line !== null ? { "data-line": line } : {})}
      {...(clickable
        ? {
            role: "button",
            tabIndex: -1,
            title: "Comment op deze regel — sleep voor meerdere regels",
            onPointerDown: (e: React.PointerEvent<HTMLSpanElement>) => {
              e.preventDefault();
              gutter.onStart(side, line);
            },
            onPointerEnter: () => gutter.onExtend(side, line),
            onPointerUp: () => gutter.onEnd(),
          }
        : {})}
    >
      {clickable && <span className="rg-plus">+</span>}
      {line ?? ""}
    </span>
  );
}

export interface RowsProps {
  detail: FileDetail;
  onExpand: (gapIndex: number, action: "top" | "bottom" | "all") => void;
  selection: LineSelection | null;
  gutter: GutterHandlers | null;
  /** Wat er onder een regel hoort te staan: discussies en het comment-formulier. */
  below: (side: Side, line: number) => ReactNode;
}

export function UnifiedRows({
  rows,
  detail,
  onExpand,
  selection,
  gutter,
  below,
}: RowsProps & { rows: readonly Row[] }) {
  return (
    <div className="rg-code grid" style={{ gridTemplateColumns: "3.5rem 3.5rem 1fr" }}>
      {rows.map((row, i) => {
        if (row.kind === "hunk") return <HunkHeaderRow key={i} row={row} columns={3} />;
        if (row.kind === "expander")
          return <ExpanderRowView key={i} row={row} columns={3} onExpand={onExpand} />;

        const side: Side = row.type === "del" ? "old" : "new";
        const cls = lineClass(row.type);
        const anchor = side === "old" ? row.oldLine : row.newLine;
        const extra = anchor === null ? null : below(side, anchor);

        return (
          <div key={i} className="contents">
            <Gutter side="old" line={row.oldLine} cls={cls} selection={selection} gutter={gutter} />
            <Gutter side="new" line={row.newLine} cls={cls} selection={selection} gutter={gutter} />
            <code className={`rg-content ${cls}`}>
              <CodeText
                content={row.content}
                tokens={tokensFor(detail, row, side)}
                palette={detail.highlight.palette}
                segments={segmentsFor(detail, row)}
                changedClass={row.type === "add" ? "rg-word-add" : "rg-word-del"}
              />
            </code>
            {extra && (
              <div className="rg-below" style={{ gridColumn: "span 3" }}>
                {extra}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SplitSide({
  row,
  detail,
  side,
  selection,
  gutter,
}: {
  row: LineRow | null;
  detail: FileDetail;
  side: Side;
  selection: LineSelection | null;
  gutter: GutterHandlers | null;
}) {
  if (!row) {
    return (
      <>
        <span className="rg-gutter rg-line-empty" />
        <code className="rg-content rg-line-empty" />
      </>
    );
  }
  const cls = lineClass(row.type);
  return (
    <>
      <Gutter
        side={side}
        line={side === "old" ? row.oldLine : row.newLine}
        cls={cls}
        selection={selection}
        gutter={gutter}
      />
      <code className={`rg-content ${cls}`}>
        <CodeText
          content={row.content}
          tokens={tokensFor(detail, row, side)}
          palette={detail.highlight.palette}
          segments={segmentsFor(detail, row)}
          changedClass={row.type === "add" ? "rg-word-add" : "rg-word-del"}
        />
      </code>
    </>
  );
}

export function SplitRows({
  rows,
  detail,
  onExpand,
  selection,
  gutter,
  below,
}: RowsProps & { rows: readonly SplitRow[] }) {
  return (
    <div
      className="rg-code grid"
      style={{ gridTemplateColumns: "3.5rem minmax(0,1fr) 3.5rem minmax(0,1fr)" }}
    >
      {rows.map((row, i) => {
        if (row.kind === "hunk") return <HunkHeaderRow key={i} row={row} columns={4} />;
        if (row.kind === "expander")
          return <ExpanderRowView key={i} row={row} columns={4} onExpand={onExpand} />;

        const leftExtra = row.left?.oldLine != null ? below("old", row.left.oldLine) : null;
        const rightExtra = row.right?.newLine != null ? below("new", row.right.newLine) : null;

        return (
          <div key={i} className="contents">
            <SplitSide
              row={row.left}
              detail={detail}
              side="old"
              selection={selection}
              gutter={gutter}
            />
            <SplitSide
              row={row.right}
              detail={detail}
              side="new"
              selection={selection}
              gutter={gutter}
            />
            {(leftExtra || rightExtra) && (
              <div className="rg-below" style={{ gridColumn: "span 4" }}>
                {leftExtra}
                {rightExtra}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
