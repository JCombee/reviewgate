import type { Review, ReviewSummary } from "@reviewgate/core/api";
import { StatusBadge } from "./StatusBadge.jsx";

export function Sidebar({
  summary,
  review,
  activeIndex,
  onSelect,
}: {
  summary: ReviewSummary;
  review: Review;
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  /** Openstaande comments per bestand, zodat je ziet waar nog iets ligt. */
  const openPerFile = new Map<string, number>();
  for (const c of review.comments) {
    if (c.scope !== "line" || c.status !== "open" || !c.path) continue;
    openPerFile.set(c.path, (openPerFile.get(c.path) ?? 0) + 1);
  }

  return (
    <nav aria-label="Bestanden">
      <p className="px-3 py-2 text-[11px] uppercase tracking-wide text-[var(--rg-text-faint)]">
        Bestanden
      </p>
      <ul>
        {summary.files.map((f) => {
          const name = f.path.split("/").pop() ?? f.path;
          const dir = f.path.slice(0, f.path.length - name.length);
          const open = openPerFile.get(f.path) ?? 0;
          return (
            <li key={f.index}>
              <button
                type="button"
                onClick={() => onSelect(f.index)}
                aria-current={f.index === activeIndex}
                className={`flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-[var(--rg-bg-raised)] ${
                  f.index === activeIndex ? "bg-[var(--rg-bg-raised)]" : ""
                }`}
              >
                <StatusBadge status={f.status} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-[var(--rg-text-faint)]">{dir}</span>
                  {name}
                </span>
                {open > 0 && (
                  <span
                    className="shrink-0 tabular-nums"
                    style={{ color: "var(--rg-changes)" }}
                    title={`${open} openstaande comment(s)`}
                  >
                    {open}
                  </span>
                )}
                <span className="shrink-0 tabular-nums text-[var(--rg-text-faint)]">
                  {f.binary ? "bin" : f.additions + f.deletions}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
