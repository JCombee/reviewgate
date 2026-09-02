import { describe, expect, it } from "vitest";
import { reanchorComment, reanchorComments, type FileLines } from "./anchor.js";
import type { Comment } from "./types.js";

const comment = (over: Partial<Comment> = {}): Comment => ({
  id: "c1",
  round: 1,
  scope: "line",
  kind: "issue",
  path: "src/service.ts",
  side: "new",
  startLine: 42,
  endLine: 42,
  anchorSnippet: "  cache.forget(key);",
  body: "misses the tag variant",
  author: "user",
  status: "open",
  replies: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/** A file of `size` lines with the anchor at `anchorAt` (1-based). */
function fileWith(anchorAt: number[], size = 100, anchor = "  cache.forget(key);"): FileLines {
  const lines = Array.from({ length: size }, (_, i) => `line ${i + 1}`);
  for (const at of anchorAt) lines[at - 1] = anchor;
  return { get: () => lines };
}

const noFiles: FileLines = { get: () => null };

describe("reanchorComment", () => {
  it("leaves a comment alone when the line did not shift", () => {
    const res = reanchorComment(comment(), fileWith([42]));
    expect(res.outcome).toBe("unchanged");
    expect(res.comment.startLine).toBe(42);
    expect(res.comment.status).toBe("open");
  });

  it("shifts to the new line within the window", () => {
    const res = reanchorComment(comment(), fileWith([55]));
    expect(res.outcome).toBe("shifted");
    expect(res.comment.startLine).toBe(55);
    expect(res.from).toBe(42);
    expect(res.comment.status).toBe("open");
  });

  it("keeps the length of a range while shifting", () => {
    const res = reanchorComment(comment({ startLine: 42, endLine: 48 }), fileWith([50]));
    expect([res.comment.startLine, res.comment.endLine]).toEqual([50, 56]);
  });

  it("picks the nearest match inside the window", () => {
    const res = reanchorComment(comment(), fileWith([30, 45]));
    expect(res.comment.startLine).toBe(45);
  });

  it("moves to the only match far outside the window", () => {
    const res = reanchorComment(comment(), fileWith([95]));
    expect(res.outcome).toBe("moved");
    expect(res.comment.startLine).toBe(95);
  });

  it("goes outdated when the anchor is nowhere to be found", () => {
    const res = reanchorComment(comment(), fileWith([]));
    expect(res.outcome).toBe("outdated");
    expect(res.comment.status).toBe("outdated");
  });

  it("goes outdated on several matches far outside the window", () => {
    const res = reanchorComment(comment(), fileWith([90, 95]));
    expect(res.outcome).toBe("outdated");
  });

  it("goes outdated when the file is gone", () => {
    expect(reanchorComment(comment(), noFiles).outcome).toBe("outdated");
  });

  it("goes outdated without an anchor", () => {
    const without = comment();
    delete without.anchorSnippet;
    expect(reanchorComment(without, fileWith([42])).outcome).toBe("outdated");
  });

  it("leaves global, resolved and outdated comments alone", () => {
    expect(reanchorComment(comment({ scope: "global" }), fileWith([])).outcome).toBe("skipped");
    expect(reanchorComment(comment({ status: "resolved" }), fileWith([])).outcome).toBe("skipped");
    expect(reanchorComment(comment({ status: "outdated" }), fileWith([42])).outcome).toBe("skipped");
  });
});

describe("reanchorComments", () => {
  it("handles the whole list and reports an outcome per comment", () => {
    const { comments, results } = reanchorComments(
      [
        comment({ id: "a", startLine: 42 }),
        comment({ id: "b", startLine: 42, anchorSnippet: "no longer exists" }),
        comment({ id: "c", scope: "global" }),
      ],
      fileWith([50]),
    );

    expect(results.map((r) => r.outcome)).toEqual(["shifted", "outdated", "skipped"]);
    expect(comments[0]?.startLine).toBe(50);
    expect(comments[1]?.status).toBe("outdated");
    expect(comments[2]?.status).toBe("open");
  });
});
