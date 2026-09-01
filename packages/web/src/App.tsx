import type { Review, ReviewSummary } from "@reviewgate/core/api";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchSummary, readContext } from "./api.js";
import { ActionBar } from "./components/ActionBar.jsx";
import { FilePanel } from "./components/FilePanel.jsx";
import { Overview } from "./components/Overview.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { createReviewApi, subscribeToReview } from "./lib/reviewClient.js";

type View = "unified" | "split";

const VIEW_KEY = "reviewgate.view";

const SCOPE_LABEL: Readonly<Record<string, string>> = {
  staged: "gestaged",
  working: "working tree",
  amend: "amend",
  range: "bereik",
};

export function App() {
  const ctx = useMemo(() => readContext(), []);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(readView);
  const [activeIndex, setActiveIndex] = useState(0);

  const fileRefs = useRef(new Map<number, HTMLElement>());
  const registerRef = useCallback((index: number, el: HTMLElement | null) => {
    if (el) fileRefs.current.set(index, el);
    else fileRefs.current.delete(index);
  }, []);

  const api = useMemo(() => (ctx ? createReviewApi(ctx, setReview) : null), [ctx]);

  useEffect(() => {
    if (!ctx) return;
    fetchSummary(ctx).then(
      (s) => {
        setSummary(s);
        setReview(s.review);
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [ctx]);

  // Meelopen met mutaties uit een ander tabblad, en straks met de suggesties die
  // tijdens de automatische pass binnendruppelen (§9).
  useEffect(() => {
    if (!ctx) return;
    return subscribeToReview(ctx, setReview);
  }, [ctx]);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Privémodus of geblokkeerde opslag: de keuze geldt dan alleen deze sessie.
    }
  }, [view]);

  const goToFile = useCallback((index: number) => {
    const el = fileRefs.current.get(index);
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: "auto" });
    setActiveIndex(index);
  }, []);

  const fileCount = summary?.files.length ?? 0;

  // Toetsenbord: n/p door bestanden, j/k door hunks, u wisselt de weergave (§8).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (e.key === "n" || e.key === "p") {
        e.preventDefault();
        const next = e.key === "n" ? activeIndex + 1 : activeIndex - 1;
        if (next >= 0 && next < fileCount) goToFile(next);
        return;
      }
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        moveHunk(e.key === "j" ? 1 : -1);
        return;
      }
      if (e.key === "u") {
        e.preventDefault();
        setView((v) => (v === "unified" ? "split" : "unified"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeIndex, fileCount, goToFile]);

  if (!ctx) {
    return (
      <Centered>
        Geen geldige review-URL. Open ReviewGate via <code className="rg-code">reviewgate open</code>.
      </Centered>
    );
  }
  if (error) return <Centered>Kon de review niet laden: {error}</Centered>;
  if (!summary || !review || !api) return <Centered>laden…</Centered>;

  const empty = summary.files.length === 0;
  const openCount = review.comments.filter((c) => c.status === "open").length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-[var(--rg-border)] bg-[var(--rg-bg-raised)] px-3">
        <span className="font-semibold">{summary.repo.branch ?? "(geen branch)"}</span>
        <span className="text-[var(--rg-text-faint)]">·</span>
        <span className="text-[var(--rg-text-muted)]">
          {SCOPE_LABEL[summary.scope] ?? summary.scope}
        </span>
        <span className="text-[var(--rg-text-faint)]">·</span>
        <span className="text-[var(--rg-text-muted)] tabular-nums">
          {summary.files.length} {summary.files.length === 1 ? "bestand" : "bestanden"}
        </span>
        <span className="tabular-nums">
          <span style={{ color: "var(--rg-status-added)" }}>+{summary.additions}</span>{" "}
          <span style={{ color: "var(--rg-status-deleted)" }}>−{summary.deletions}</span>
        </span>
        {openCount > 0 && (
          <>
            <span className="text-[var(--rg-text-faint)]">·</span>
            <span className="tabular-nums" style={{ color: "var(--rg-changes)" }}>
              {openCount} openstaand
            </span>
          </>
        )}

        <div
          className="ml-auto flex overflow-hidden rounded border border-[var(--rg-border)]"
          role="group"
          aria-label="Weergave"
        >
          {(["unified", "split"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`px-2 py-0.5 ${
                view === v
                  ? "bg-[var(--rg-bg-sunken)] text-[var(--rg-text)]"
                  : "text-[var(--rg-text-muted)]"
              }`}
            >
              {v === "unified" ? "Unified" : "Split"}
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-[var(--rg-border)] bg-[var(--rg-bg-sunken)]">
          <Overview review={review} api={api} />
          <Sidebar summary={summary} review={review} activeIndex={activeIndex} onSelect={goToFile} />
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          {empty ? (
            <Centered>Geen wijzigingen in deze scope.</Centered>
          ) : (
            summary.files.map((f) => (
              <FilePanel
                key={f.index}
                ctx={ctx}
                file={f}
                view={view}
                review={review}
                api={api}
                registerRef={registerRef}
              />
            ))
          )}
        </main>
      </div>

      <ActionBar ctx={ctx} review={review} onDecided={setReview} />
    </div>
  );
}

/** Springt naar de volgende of vorige hunk-kop in het document. */
function moveHunk(delta: 1 | -1): void {
  const headers = Array.from(document.querySelectorAll<HTMLElement>("[data-hunk]"));
  if (headers.length === 0) return;
  const y = window.scrollY;
  const tops = headers.map((h) => h.getBoundingClientRect().top + y);
  const current = tops.findIndex((t) => t > y + 1);
  const index =
    delta === 1
      ? current === -1
        ? headers.length - 1
        : current
      : Math.max(0, (current === -1 ? headers.length : current) - 2);
  headers[index]?.scrollIntoView({ block: "start", behavior: "auto" });
}

function readView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-[var(--rg-text-muted)]">
      <p>{children}</p>
    </div>
  );
}
