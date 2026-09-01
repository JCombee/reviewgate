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
  body: "mist de tag-variant",
  author: "user",
  status: "open",
  replies: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/** Bestand van `size` regels met het anker op `at` (1-based). */
function fileWith(anchorAt: number[], size = 100, anchor = "  cache.forget(key);"): FileLines {
  const lines = Array.from({ length: size }, (_, i) => `regel ${i + 1}`);
  for (const at of anchorAt) lines[at - 1] = anchor;
  return { get: () => lines };
}

const noFiles: FileLines = { get: () => null };

describe("reanchorComment", () => {
  it("laat een comment staan als de regel niet verschoven is", () => {
    const res = reanchorComment(comment(), fileWith([42]));
    expect(res.outcome).toBe("unchanged");
    expect(res.comment.startLine).toBe(42);
    expect(res.comment.status).toBe("open");
  });

  it("verschuift naar de nieuwe regel binnen het venster", () => {
    const res = reanchorComment(comment(), fileWith([55]));
    expect(res.outcome).toBe("shifted");
    expect(res.comment.startLine).toBe(55);
    expect(res.from).toBe(42);
    expect(res.comment.status).toBe("open");
  });

  it("houdt de lengte van een range vast bij het verschuiven", () => {
    const res = reanchorComment(comment({ startLine: 42, endLine: 48 }), fileWith([50]));
    expect([res.comment.startLine, res.comment.endLine]).toEqual([50, 56]);
  });

  it("kiest binnen het venster de dichtstbijzijnde match", () => {
    const res = reanchorComment(comment(), fileWith([30, 45]));
    expect(res.comment.startLine).toBe(45);
  });

  it("verplaatst naar de enige match ver buiten het venster", () => {
    const res = reanchorComment(comment(), fileWith([95]));
    expect(res.outcome).toBe("moved");
    expect(res.comment.startLine).toBe(95);
  });

  it("wordt verouderd als het anker nergens meer staat", () => {
    const res = reanchorComment(comment(), fileWith([]));
    expect(res.outcome).toBe("outdated");
    expect(res.comment.status).toBe("outdated");
  });

  it("wordt verouderd bij meerdere matches ver buiten het venster", () => {
    const res = reanchorComment(comment(), fileWith([90, 95]));
    expect(res.outcome).toBe("outdated");
  });

  it("wordt verouderd als het bestand verdwenen is", () => {
    expect(reanchorComment(comment(), noFiles).outcome).toBe("outdated");
  });

  it("wordt verouderd zonder anker", () => {
    const zonder = comment();
    delete zonder.anchorSnippet;
    expect(reanchorComment(zonder, fileWith([42])).outcome).toBe("outdated");
  });

  it("laat globale, opgeloste en verouderde comments met rust", () => {
    expect(reanchorComment(comment({ scope: "global" }), fileWith([])).outcome).toBe("skipped");
    expect(reanchorComment(comment({ status: "resolved" }), fileWith([])).outcome).toBe("skipped");
    expect(reanchorComment(comment({ status: "outdated" }), fileWith([42])).outcome).toBe("skipped");
  });
});

describe("reanchorComments", () => {
  it("verwerkt de hele lijst en geeft per comment de uitkomst", () => {
    const { comments, results } = reanchorComments(
      [
        comment({ id: "a", startLine: 42 }),
        comment({ id: "b", startLine: 42, anchorSnippet: "bestaat niet meer" }),
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
