import type { ReviewSummary } from "@reviewgate/core/api";
import { StatusBadge } from "./StatusBadge.jsx";

export function Sidebar({
  summary,
  activeIndex,
  onSelect,
}: {
  summary: ReviewSummary;
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <nav
      className="h-full overflow-y-auto border-r border-[var(--rg-border)] bg-[var(--rg-bg-sunken)]"
      aria-label="Bestanden"
    >
      <p className="px-3 py-2 text-[var(--rg-text-faint)] uppercase tracking-wide text-[11px]">
        Bestanden
      </p>
      <ul>
        {summary.files.map((f) => {
          const name = f.path.split("/").pop() ?? f.path;
          const dir = f.path.slice(0, f.path.length - name.length);
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
