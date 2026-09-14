import { describe, expect, it } from "vitest";
import {
  acceptSuggestion,
  addSuggestions,
  applyCap,
  closeOpenSuggestions,
  dismissSuggestion,
  reopenSuggestion,
  suggestionCap,
  type IncomingSuggestion,
} from "./suggestions.js";
import type { Review, Suggestion } from "./types.js";

const review = (suggestions: Suggestion[] = []): Review => ({
  id: "r1",
  repoRoot: "/repo",
  branch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  rounds: [
    {
      n: 2,
      diffHash: "abc",
      scope: "staged",
      commitMessage: null,
      editedCommitMessage: null,
      claudeSessionId: null,
      transcriptPath: null,
      decision: null,
      decidedAt: null,
      summary: null,
    },
  ],
  comments: [],
  suggestions,
  chats: [],
  status: "open",
});

const suggestion = (over: Partial<Suggestion>): Suggestion => ({
  id: over.id ?? "s1",
  round: 1,
  scope: "line",
  body: "something",
  severity: "consideration",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const incoming = (over: Partial<IncomingSuggestion> = {}): IncomingSuggestion => ({
  scope: "line",
  body: "this fetch has no error handling",
  severity: "consideration",
  path: "a.ts",
  side: "new",
  startLine: 17,
  ...over,
});

describe("suggestionCap", () => {
  it("scales with the diff: two per fifty lines", () => {
    expect(suggestionCap(50)).toBe(2);
    expect(suggestionCap(200)).toBe(8);
    expect(suggestionCap(500)).toBe(20);
  });

  it("holds the floor of two on a small diff", () => {
    expect(suggestionCap(0)).toBe(2);
    expect(suggestionCap(10)).toBe(2);
  });

  it("caps at twenty on an enormous refactor", () => {
    expect(suggestionCap(10_000)).toBe(20);
  });
});

describe("applyCap", () => {
  it("keeps the highest severity first, then file and line number", () => {
    const items = [
      { severity: "nit" as const, path: "a.ts", startLine: 1 },
      { severity: "blocker" as const, path: "z.ts", startLine: 99 },
      { severity: "consideration" as const, path: "a.ts", startLine: 5 },
      { severity: "consideration" as const, path: "a.ts", startLine: 2 },
    ];
    const { kept, dropped } = applyCap(items, 2);
    expect(kept.map((k) => k.severity)).toEqual(["blocker", "consideration"]);
    expect(kept[1]?.startLine).toBe(2);
    expect(dropped).toHaveLength(2);
  });
});

describe("addSuggestions", () => {
  it("adds suggestions as pending", () => {
    const { review: next, added } = addSuggestions(review(), [incoming()], { cap: 5 });
    expect(added).toHaveLength(1);
    expect(next.suggestions[0]).toMatchObject({
      status: "pending",
      round: 2,
      severity: "consideration",
    });
  });

  it("does not auto-dismiss a finding similar to an earlier user-dismissed suggestion", () => {
    const earlier = suggestion({
      id: "old",
      body: "this fetch has no error handling",
      path: "a.ts",
      startLine: 17,
      status: "dismissed",
      dismissedReason: "user",
    });
    const { review: next, added } = addSuggestions(review([earlier]), [incoming()], {
      cap: 5,
    });

    expect(added).toHaveLength(1);
    expect(next.suggestions).toHaveLength(2);
    expect(next.suggestions[1]).toMatchObject({ status: "pending" });
  });

  it("cuts off at the cap and reports what fell away", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      incoming({ body: `point number ${"x".repeat(i + 1)} different`, startLine: 10 + i }),
    );
    const { added, dropped } = addSuggestions(review(), items, { cap: 2 });
    expect(added).toHaveLength(2);
    expect(dropped).toHaveLength(3);
  });

  it("treats zero suggestions as a valid outcome", () => {
    const { review: next, added } = addSuggestions(review(), [], { cap: 5 });
    expect(added).toEqual([]);
    expect(next.suggestions).toEqual([]);
  });
});

describe("status changes", () => {
  it("dismissing keeps the suggestion with its reason", () => {
    const next = dismissSuggestion(review([suggestion({ id: "s1" })]), "s1");
    expect(next.suggestions[0]).toMatchObject({ status: "dismissed", dismissedReason: "user" });
  });

  it("reopening clears the dismissal", () => {
    const dismissed = suggestion({
      id: "s1",
      status: "dismissed",
      dismissedReason: "user",
    });
    const next = reopenSuggestion(review([dismissed]), "s1");
    expect(next.suggestions[0]?.status).toBe("pending");
    expect(next.suggestions[0]?.dismissedReason).toBeUndefined();
  });

  it("accepting points at the comment it produced", () => {
    const next = acceptSuggestion(review([suggestion({ id: "s1" })]), "s1", "c9");
    expect(next.suggestions[0]).toMatchObject({ status: "accepted", promotedToCommentId: "c9" });
  });

  it("a decision closes open suggestions with round_closed", () => {
    const next = closeOpenSuggestions(
      review([suggestion({ id: "s1" }), suggestion({ id: "s2", status: "accepted" })]),
    );
    expect(next.suggestions[0]).toMatchObject({
      status: "dismissed",
      dismissedReason: "round_closed",
    });
    expect(next.suggestions[1]?.status).toBe("accepted");
  });
});
