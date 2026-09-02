import { describe, expect, it } from "vitest";
import {
  acceptSuggestion,
  addSuggestions,
  applyCap,
  closeOpenSuggestions,
  dismissSuggestion,
  findDuplicate,
  normalize,
  reopenSuggestion,
  similarity,
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
  chat: [],
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

describe("normalize and similarity", () => {
  it("strips line numbers, because a shifted line is the same remark", () => {
    expect(normalize("L42: misses the tag variant")).toBe(normalize("L58: misses the tag variant"));
  });

  it("gives 1 for identical text", () => {
    expect(similarity("the fetch has no error handling", "the fetch has no error handling")).toBe(1);
  });

  it("gives a low score for something entirely different", () => {
    expect(
      similarity("the fetch has no error handling", "this function belongs in another directory"),
    ).toBeLessThan(0.3);
  });

  it("works on short texts too", () => {
    expect(similarity("missing null check", "missing null check")).toBe(1);
    expect(similarity("missing null check", "wrong order")).toBe(0);
  });
});

describe("findDuplicate", () => {
  const dismissed = suggestion({
    id: "old",
    body: "this fetch has no error handling",
    path: "a.ts",
    startLine: 17,
    status: "dismissed",
    dismissedReason: "user",
  });

  it("recognises the same remark on a shifted line in the same file", () => {
    const match = findDuplicate(
      { body: "this fetch still has no proper error handling", path: "a.ts", startLine: 17 },
      [dismissed],
    );
    expect(match?.duplicateOf).toBe("old");
  });

  it("leaves a different point in the same file alone", () => {
    expect(
      findDuplicate({ body: "this variable is used nowhere", path: "a.ts", startLine: 17 }, [
        dismissed,
      ]),
    ).toBeNull();
  });

  it("suppresses only what you dismissed, not what closed with a decision", () => {
    const closed = { ...dismissed, dismissedReason: "round_closed" as const };
    expect(
      findDuplicate({ body: "this fetch has no error handling", path: "a.ts", startLine: 17 }, [
        closed,
      ]),
    ).toBeNull();
  });

  it("ignores suggestions that are still pending", () => {
    const pending = { ...dismissed, status: "pending" as const };
    expect(
      findDuplicate({ body: "this fetch has no error handling", path: "a.ts" }, [pending]),
    ).toBeNull();
  });

  it("applies a stricter threshold outside the original file", () => {
    const elsewhere = { body: "this fetch still has no proper error handling", path: "b.ts" };
    // The same file clears 0.6; another file does not clear the required 0.8.
    expect(findDuplicate({ ...elsewhere, path: "a.ts", startLine: 17 }, [dismissed])).not.toBeNull();
    expect(findDuplicate(elsewhere, [dismissed])).toBeNull();
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

  it("auto-dismisses a repeated suggestion without throwing it away", () => {
    const earlier = suggestion({
      id: "old",
      body: "this fetch has no error handling",
      path: "a.ts",
      startLine: 17,
      status: "dismissed",
      dismissedReason: "user",
    });
    const { review: next, added, duplicates } = addSuggestions(review([earlier]), [incoming()], {
      cap: 5,
    });

    expect(added).toHaveLength(0);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.score).toBeGreaterThan(0.6);
    expect(next.suggestions).toHaveLength(2);
    expect(next.suggestions[1]).toMatchObject({
      status: "dismissed",
      dismissedReason: "auto_duplicate",
      duplicateOf: "old",
    });
  });

  it("does not count auto-dismissed duplicates towards the cap", () => {
    const earlier = suggestion({
      id: "old",
      body: "this fetch has no error handling",
      path: "a.ts",
      startLine: 17,
      status: "dismissed",
      dismissedReason: "user",
    });
    const items = [
      incoming(),
      incoming({ body: "a null check is missing here", startLine: 30 }),
      incoming({ body: "this name does not cover what it does", startLine: 40 }),
    ];
    const { added, duplicates } = addSuggestions(review([earlier]), items, { cap: 2 });
    expect(duplicates).toHaveLength(1);
    // The cap of 2 applies to the two new findings, not to the duplicate.
    expect(added).toHaveLength(2);
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
    const auto = suggestion({
      id: "s1",
      status: "dismissed",
      dismissedReason: "auto_duplicate",
      duplicateOf: "old",
    });
    const next = reopenSuggestion(review([auto]), "s1");
    expect(next.suggestions[0]?.status).toBe("pending");
    expect(next.suggestions[0]?.dismissedReason).toBeUndefined();
    expect(next.suggestions[0]?.duplicateOf).toBeUndefined();
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
