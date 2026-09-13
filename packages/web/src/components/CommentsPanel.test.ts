import type { Comment, FileSummary, ReviewSummary, Suggestion } from "@reviewgate/core/api";
import { describe, expect, it } from "vitest";
import { byLine, computeSuggestionCounts, groupRows, type ReviewRow } from "./CommentsPanel.js";

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}${seq}`;
}

function file(path: string, index: number): FileSummary {
  return {
    index,
    path,
    oldPath: path,
    newPath: path,
    status: "modified",
    binary: false,
    submodule: false,
    similarity: null,
    additions: 1,
    deletions: 0,
    hunkCount: 1,
  };
}

function summaryWith(files: FileSummary[]): ReviewSummary {
  return {
    id: "review-1",
    scope: "working",
    repo: { root: "/repo", branch: "main" },
    createdAt: "2026-01-01T00:00:00.000Z",
    files,
    additions: 0,
    deletions: 0,
    changedLines: 0,
    review: {
      id: "review-1",
      repoRoot: "/repo",
      branch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      rounds: [],
      comments: [],
      suggestions: [],
      chat: [],
      status: "open",
    },
    passStatus: { done: true },
  } as unknown as ReviewSummary;
}

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: nextId("c"),
    round: 1,
    scope: "global",
    kind: "issue",
    body: "a comment",
    author: "user",
    status: "open",
    replies: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function suggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: nextId("s"),
    round: 1,
    scope: "global",
    body: "a suggestion",
    severity: "nit",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const commentRow = (c: Comment): ReviewRow => ({ kind: "comment", comment: c });
const suggestionRow = (s: Suggestion): ReviewRow => ({ kind: "suggestion", suggestion: s });

describe("groupRows — comment-only regression", () => {
  it("groups global, then commit message, then files in diff order, exactly as before", () => {
    const summary = summaryWith([file("b.ts", 1), file("a.ts", 0)]);
    const rows = [
      comment({ scope: "commit_message" }),
      comment({ scope: "global" }),
      comment({ scope: "line", path: "a.ts", startLine: 5 }),
      comment({ scope: "line", path: "b.ts", startLine: 2 }),
    ].map(commentRow);

    const groups = groupRows(rows, summary, "all");

    expect(groups.map((g) => g.key)).toEqual(["global", "commit_message", "file:a.ts", "file:b.ts"]);
    expect(groups.every((g) => g.rows.every((r) => r.kind === "comment"))).toBe(true);
  });

  it("filters by comment status exactly as before when there are no suggestions", () => {
    const summary = summaryWith([file("a.ts", 0)]);
    const rows = [
      comment({ status: "open", path: "a.ts", scope: "line", startLine: 1 }),
      comment({ status: "resolved", path: "a.ts", scope: "line", startLine: 2 }),
      comment({ status: "outdated", path: "a.ts", scope: "line", startLine: 3 }),
    ].map(commentRow);

    expect(groupRows(rows, summary, "open")[0]?.rows).toHaveLength(1);
    expect(groupRows(rows, summary, "resolved")[0]?.rows).toHaveLength(1);
    expect(groupRows(rows, summary, "outdated")[0]?.rows).toHaveLength(1);
    expect(groupRows(rows, summary, "all")[0]?.rows).toHaveLength(3);
  });
});

describe("groupRows — suggestions merged in", () => {
  it("buckets suggestions by file the same way comments would", () => {
    const summary = summaryWith([file("a.ts", 0), file("b.ts", 1)]);
    const rows = [
      suggestion({ path: "a.ts", scope: "line", startLine: 1 }),
      suggestion({ path: "b.ts", scope: "line", startLine: 1 }),
      suggestion({ scope: "global" }),
    ].map(suggestionRow);

    const groups = groupRows(rows, summary, "all");
    expect(groups.map((g) => g.key)).toEqual(["global", "file:a.ts", "file:b.ts"]);
  });

  it("interleaves a comment and a suggestion on the same file by line number", () => {
    const summary = summaryWith([file("a.ts", 0)]);
    const rows = [
      commentRow(comment({ scope: "line", path: "a.ts", startLine: 20 })),
      suggestionRow(suggestion({ scope: "line", path: "a.ts", startLine: 10 })),
    ];

    const groups = groupRows(rows, summary, "all");
    const fileGroup = groups.find((g) => g.key === "file:a.ts");
    expect(fileGroup?.rows.map((r) => r.kind)).toEqual(["suggestion", "comment"]);
  });

  it("ties by createdAt when two rows share a line, matching byLine's existing tie-break", () => {
    const rows: ReviewRow[] = [
      commentRow(comment({ startLine: 5, createdAt: "2026-01-02T00:00:00.000Z" })),
      suggestionRow(suggestion({ startLine: 5, createdAt: "2026-01-01T00:00:00.000Z" })),
    ];
    const sorted = rows.slice().sort(byLine);
    expect(sorted[0]?.kind).toBe("suggestion");
    expect(sorted[1]?.kind).toBe("comment");
  });

  it("treats a suggestion with no path as global scope", () => {
    const summary = summaryWith([]);
    const rows = [suggestionRow(suggestion({ scope: "global" }))];
    const groups = groupRows(rows, summary, "all");
    expect(groups).toEqual([expect.objectContaining({ key: "global" })]);
  });

  it("renders the existing empty state when there are no comments and no suggestions", () => {
    const summary = summaryWith([]);
    expect(groupRows([], summary, "open")).toEqual([]);
    expect(groupRows([], summary, "all")).toEqual([]);
  });
});

describe("groupRows — suggestion filter mapping (Story 3.3)", () => {
  it("shows a pending suggestion under Open and All, not Resolved/Outdated", () => {
    const summary = summaryWith([]);
    const rows = [suggestionRow(suggestion({ status: "pending" }))];

    expect(groupRows(rows, summary, "open")).toHaveLength(1);
    expect(groupRows(rows, summary, "all")).toHaveLength(1);
    expect(groupRows(rows, summary, "resolved")).toHaveLength(0);
    expect(groupRows(rows, summary, "outdated")).toHaveLength(0);
  });

  it("shows a dismissed suggestion under Resolved and All, not Open/Outdated", () => {
    const summary = summaryWith([]);
    const rows = [suggestionRow(suggestion({ status: "dismissed" }))];

    expect(groupRows(rows, summary, "resolved")).toHaveLength(1);
    expect(groupRows(rows, summary, "all")).toHaveLength(1);
    expect(groupRows(rows, summary, "open")).toHaveLength(0);
    expect(groupRows(rows, summary, "outdated")).toHaveLength(0);
  });

  it("never shows an accepted suggestion as a suggestion row, under any filter including All", () => {
    const summary = summaryWith([]);
    const rows = [suggestionRow(suggestion({ status: "accepted" }))];

    for (const filter of ["open", "all", "resolved", "outdated"] as const) {
      expect(groupRows(rows, summary, filter)).toHaveLength(0);
    }
  });

  it("never shows any suggestion under Outdated regardless of status", () => {
    const summary = summaryWith([]);
    const rows = (["pending", "dismissed", "accepted"] as const).map((status) =>
      suggestionRow(suggestion({ status })),
    );
    expect(groupRows(rows, summary, "outdated")).toHaveLength(0);
  });

  it("looks identical to a comments-only view when a review has only accepted suggestions", () => {
    const summary = summaryWith([]);
    const sharedComment = comment({ status: "open" });
    const commentOnly = [commentRow(sharedComment)];
    const withAcceptedSuggestion = [
      commentRow(sharedComment),
      suggestionRow(suggestion({ status: "accepted" })),
    ];

    expect(groupRows(withAcceptedSuggestion, summary, "open")).toEqual(
      groupRows(commentOnly, summary, "open"),
    );
    expect(groupRows(withAcceptedSuggestion, summary, "all")).toEqual(
      groupRows(commentOnly, summary, "all"),
    );
  });
});

describe("computeSuggestionCounts", () => {
  it("tallies pending under open+all and dismissed under resolved+all, honoring the mapping", () => {
    const counts = computeSuggestionCounts([
      suggestion({ status: "pending" }),
      suggestion({ status: "pending" }),
      suggestion({ status: "dismissed" }),
    ]);
    expect(counts).toEqual({ open: 2, all: 3, resolved: 1, outdated: 0 });
  });

  it("never counts accepted suggestions, anywhere", () => {
    const counts = computeSuggestionCounts([
      suggestion({ status: "accepted" }),
      suggestion({ status: "accepted" }),
    ]);
    expect(counts).toEqual({ open: 0, all: 0, resolved: 0, outdated: 0 });
  });

  it("returns all zeroes for no suggestions", () => {
    expect(computeSuggestionCounts([])).toEqual({ open: 0, all: 0, resolved: 0, outdated: 0 });
  });
});
