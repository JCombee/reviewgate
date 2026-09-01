import type {
  FileDetail,
  HighlightLine,
  IntralineSegment,
  PaletteEntry,
} from "@reviewgate/core/api";
import { memo, useMemo, type CSSProperties } from "react";
import { toPieces } from "../lib/code.js";
import type { ExpanderRow, HunkRow, LineRow, Row, SplitRow } from "../lib/rows.js";

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
function tokensFor(detail: FileDetail, row: LineRow, side: "old" | "new"): HighlightLine | null {
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

export function UnifiedRows({
  rows,
  detail,
  onExpand,
}: {
  rows: readonly Row[];
  detail: FileDetail;
  onExpand: (gapIndex: number, action: "top" | "bottom" | "all") => void;
}) {
  return (
    <div className="rg-code grid" style={{ gridTemplateColumns: "3.5rem 3.5rem 1fr" }}>
      {rows.map((row, i) => {
        if (row.kind === "hunk") return <HunkHeaderRow key={i} row={row} columns={3} />;
        if (row.kind === "expander")
          return <ExpanderRowView key={i} row={row} columns={3} onExpand={onExpand} />;

        const side = row.type === "del" ? "old" : "new";
        const cls = lineClass(row.type);
        return (
          <div key={i} className="contents">
            <span className={`rg-gutter ${cls}`}>{row.oldLine ?? ""}</span>
            <span className={`rg-gutter ${cls}`}>{row.newLine ?? ""}</span>
            <code className={`rg-content ${cls}`}>
              <CodeText
                content={row.content}
                tokens={tokensFor(detail, row, side)}
                palette={detail.highlight.palette}
                segments={segmentsFor(detail, row)}
                changedClass={row.type === "add" ? "rg-word-add" : "rg-word-del"}
              />
            </code>
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
}: {
  row: LineRow | null;
  detail: FileDetail;
  side: "old" | "new";
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
      <span className={`rg-gutter ${cls}`}>
        {(side === "old" ? row.oldLine : row.newLine) ?? ""}
      </span>
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
}: {
  rows: readonly SplitRow[];
  detail: FileDetail;
  onExpand: (gapIndex: number, action: "top" | "bottom" | "all") => void;
}) {
  return (
    <div
      className="rg-code grid"
      style={{ gridTemplateColumns: "3.5rem minmax(0,1fr) 3.5rem minmax(0,1fr)" }}
    >
      {rows.map((row, i) => {
        if (row.kind === "hunk") return <HunkHeaderRow key={i} row={row} columns={4} />;
        if (row.kind === "expander")
          return <ExpanderRowView key={i} row={row} columns={4} onExpand={onExpand} />;
        return (
          <div key={i} className="contents">
            <SplitSide row={row.left} detail={detail} side="old" />
            <SplitSide row={row.right} detail={detail} side="new" />
          </div>
        );
      })}
    </div>
  );
}
