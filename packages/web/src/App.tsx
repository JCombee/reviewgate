import type { PassStatus, Review, ReviewSummary, Suggestion } from "@reviewgate/core/api";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchSummary, readContext } from "./api.js";
import { ActionBar } from "./components/ActionBar.jsx";
import { ChatPanel } from "./components/ChatPanel.jsx";
import { FilePanel } from "./components/FilePanel.jsx";
import { Overview } from "./components/Overview.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { createReviewApi, subscribeToReview } from "./lib/reviewClient.js";

type View = "unified" | "split";

const VIEW_KEY = "reviewgate.view";
const CHAT_KEY = "reviewgate.chat";

const SCOPE_LABEL: Readonly<Record<string, string>> = {
  staged: "staged",
  working: "working tree",
  amend: "amend",
  range: "range",
};

export function App() {
  const ctx = useMemo(() => readContext(), []);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(readView);
  const [activeIndex, setActiveIndex] = useState(0);
  const [chatOpen, setChatOpen] = useState(readChatOpen);
  const [passStatus, setPassStatus] = useState<PassStatus>({ state: "idle" });
  const [streaming, setStreaming] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState<string | null>(null);

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
        setPassStatus(s.passStatus);
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [ctx]);

  // Keep up with mutations from another tab, with the tokens of an answer that is
  // still streaming, and with the suggestions that trickle in during the pass (§9).
  useEffect(() => {
    if (!ctx) return;
    return subscribeToReview(ctx, {
      onReview: (next) => {
        setReview(next);
        // The answer is in the review itself now; the loose stream can go.
        setStreaming(null);
      },
      onChatToken: (text) => setStreaming((prev) => (prev ?? "") + text),
      onPass: setPassStatus,
    });
  }, [ctx]);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view);
      window.localStorage.setItem(CHAT_KEY, chatOpen ? "1" : "0");
    } catch {
      // Private mode or blocked storage: the choice then holds for this session only.
    }
  }, [view, chatOpen]);

  const goToFile = useCallback((index: number) => {
    const el = fileRefs.current.get(index);
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: "auto" });
    setActiveIndex(index);
  }, []);

  const onDiscuss = useCallback((suggestion: Suggestion) => {
    const where = suggestion.path
      ? `${suggestion.path}${suggestion.startLine ? `:${suggestion.startLine}` : ""}`
      : "the change as a whole";
    setChatDraft(`About this suggestion at ${where}: "${suggestion.body}" — does that hold?`);
    setChatOpen(true);
  }, []);

  const fileCount = summary?.files.length ?? 0;

  // Keyboard: n/p through files, j/k through hunks, u switches the view (§8).
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
        Not a valid review URL. Open ReviewGate with <code className="rg-code">reviewgate open</code>.
      </Centered>
    );
  }
  if (error) return <Centered>Could not load the review: {error}</Centered>;
  if (!summary || !review || !api) return <Centered>loading…</Centered>;

  const empty = summary.files.length === 0;
  const openCount = review.comments.filter((c) => c.status === "open").length;
  const round = review.rounds.length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-[var(--rg-border)] bg-[var(--rg-bg-raised)] px-3">
        <span className="font-semibold">{summary.repo.branch ?? "(no branch)"}</span>
        <span className="text-[var(--rg-text-faint)]">·</span>
        <span className="text-[var(--rg-text-muted)]">
          {SCOPE_LABEL[summary.scope] ?? summary.scope}
        </span>
        {round > 1 && (
          <>
            <span className="text-[var(--rg-text-faint)]">·</span>
            <span className="text-[var(--rg-text-muted)]">round {round}</span>
          </>
        )}
        <span className="text-[var(--rg-text-faint)]">·</span>
        <span className="text-[var(--rg-text-muted)] tabular-nums">
          {summary.files.length} {summary.files.length === 1 ? "file" : "files"}
        </span>
        <span className="tabular-nums">
          <span style={{ color: "var(--rg-status-added)" }}>+{summary.additions}</span>{" "}
          <span style={{ color: "var(--rg-status-deleted)" }}>−{summary.deletions}</span>
        </span>
        {openCount > 0 && (
          <>
            <span className="text-[var(--rg-text-faint)]">·</span>
            <span className="tabular-nums" style={{ color: "var(--rg-changes)" }}>
              {openCount} open
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setChatOpen((v) => !v)}
            aria-pressed={chatOpen}
            className="rounded border border-[var(--rg-border)] px-2 py-0.5 text-[var(--rg-text-muted)]"
          >
            Conversation
          </button>
          <div
            className="flex overflow-hidden rounded border border-[var(--rg-border)]"
            role="group"
            aria-label="View"
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
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-[var(--rg-border)] bg-[var(--rg-bg-sunken)]">
          <Overview review={review} api={api} onDiscuss={onDiscuss} />
          <Sidebar summary={summary} review={review} activeIndex={activeIndex} onSelect={goToFile} />
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          {empty ? (
            <Centered>No changes in this scope.</Centered>
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
                onDiscuss={onDiscuss}
              />
            ))
          )}
        </main>

        {chatOpen && (
          <aside className="w-96 shrink-0">
            <ChatPanel
              ctx={ctx}
              review={review}
              api={api}
              streaming={streaming}
              passStatus={passStatus}
              draft={chatDraft}
              onDraftUsed={() => setChatDraft(null)}
            />
          </aside>
        )}
      </div>

      <ActionBar ctx={ctx} review={review} onDecided={setReview} />
    </div>
  );
}

/** Jumps to the next or previous hunk header in the document. */
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

function readChatOpen(): boolean {
  try {
    return window.localStorage.getItem(CHAT_KEY) !== "0";
  } catch {
    return true;
  }
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-[var(--rg-text-muted)]">
      <p>{children}</p>
    </div>
  );
}
