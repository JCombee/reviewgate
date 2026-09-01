import { describe, expect, it } from "vitest";
import {
  addComment,
  addReply,
  deleteComment,
  editComment,
  ReviewError,
  setCommentStatus,
  setEditedCommitMessage,
} from "./mutations.js";
import { openComments, type Review } from "./types.js";

const emptyReview = (): Review => ({
  id: "r1",
  repoRoot: "/repo",
  branch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  rounds: [
    {
      n: 1,
      diffHash: "abc",
      scope: "staged",
      commitMessage: "fix: iets",
      editedCommitMessage: null,
      claudeSessionId: null,
      transcriptPath: null,
      decision: null,
      decidedAt: null,
      summary: null,
    },
  ],
  comments: [],
  suggestions: [],
  chat: [],
  status: "open",
});

const lineComment = {
  scope: "line" as const,
  body: "dit invalidatie-pad mist de tag-variant",
  path: "app/Service.php",
  side: "new" as const,
  startLine: 42,
};

describe("addComment", () => {
  it("plaatst een globale comment met de ronde erbij", () => {
    const { review, comment } = addComment(emptyReview(), {
      scope: "global",
      body: "hoort in app/Services/",
    });
    expect(review.comments).toHaveLength(1);
    expect(comment).toMatchObject({ scope: "global", round: 1, status: "open", author: "user" });
    expect(comment.kind).toBe("issue");
  });

  it("plaatst een regel-comment en vult het einde van de range aan", () => {
    const { comment } = addComment(emptyReview(), lineComment);
    expect(comment.startLine).toBe(42);
    expect(comment.endLine).toBe(42);
  });

  it("bewaart een echte range", () => {
    const { comment } = addComment(emptyReview(), { ...lineComment, endLine: 48 });
    expect([comment.startLine, comment.endLine]).toEqual([42, 48]);
  });

  it("weigert een lege body", () => {
    expect(() => addComment(emptyReview(), { scope: "global", body: "   " })).toThrow(ReviewError);
  });

  it("weigert een regel-comment zonder pad, kant of regel", () => {
    const base = emptyReview();
    expect(() => addComment(base, { scope: "line", body: "x", side: "new", startLine: 1 })).toThrow(
      /pad/,
    );
    expect(() => addComment(base, { scope: "line", body: "x", path: "a", startLine: 1 })).toThrow(
      /kant/,
    );
    expect(() => addComment(base, { scope: "line", body: "x", path: "a", side: "new" })).toThrow(
      /startregel/,
    );
  });

  it("weigert een omgekeerde range", () => {
    expect(() => addComment(emptyReview(), { ...lineComment, endLine: 40 })).toThrow(/range/);
  });

  it("houdt een vraag apart van een opmerking", () => {
    const { comment } = addComment(emptyReview(), {
      scope: "line",
      kind: "question",
      body: "waarom een transactie om één write?",
      path: "a.php",
      side: "new",
      startLine: 91,
    });
    expect(comment.kind).toBe("question");
    // Een vraag is ook een openstaande comment en houdt de knop dus bezet (§8).
    expect(openComments({ ...emptyReview(), comments: [comment] })).toHaveLength(1);
  });
});

describe("comment bijwerken", () => {
  it("wijzigt de tekst", () => {
    const { review, comment } = addComment(emptyReview(), { scope: "global", body: "eerst" });
    const next = editComment(review, comment.id, "daarna");
    expect(next.comments[0]?.body).toBe("daarna");
  });

  it("verwijdert een comment", () => {
    const { review, comment } = addComment(emptyReview(), { scope: "global", body: "weg" });
    expect(deleteComment(review, comment.id).comments).toHaveLength(0);
  });

  it("geeft 404 voor een onbekende comment", () => {
    try {
      deleteComment(emptyReview(), "bestaat-niet");
      expect.unreachable();
    } catch (err) {
      expect((err as ReviewError).status).toBe(404);
    }
  });

  it("voegt een reactie toe met tijdstip en auteur", () => {
    const { review, comment } = addComment(emptyReview(), { scope: "global", body: "punt" });
    const next = addReply(review, comment.id, "eens", "agent");
    expect(next.comments[0]?.replies).toHaveLength(1);
    expect(next.comments[0]?.replies[0]).toMatchObject({ author: "agent", body: "eens" });
  });
});

describe("resolve", () => {
  it("haalt een comment uit de openstaande telling en zet hem terug", () => {
    const { review, comment } = addComment(emptyReview(), { scope: "global", body: "punt" });
    const resolved = setCommentStatus(review, comment.id, true);
    expect(openComments(resolved)).toHaveLength(0);
    expect(openComments(setCommentStatus(resolved, comment.id, false))).toHaveLength(1);
  });

  it("laat een verouderde comment met rust", () => {
    const { review, comment } = addComment(emptyReview(), { scope: "global", body: "punt" });
    const outdated: Review = {
      ...review,
      comments: review.comments.map((c) => ({ ...c, status: "outdated" as const })),
    };
    expect(setCommentStatus(outdated, comment.id, true).comments[0]?.status).toBe("outdated");
    expect(openComments(outdated)).toHaveLength(0);
  });
});

describe("commit message", () => {
  it("bewaart een aangepaste message", () => {
    const next = setEditedCommitMessage(emptyReview(), "fix(checkout): tags invalideren");
    expect(next.rounds[0]?.editedCommitMessage).toBe("fix(checkout): tags invalideren");
  });

  it("ziet de originele message terugtypen niet als wijziging", () => {
    const next = setEditedCommitMessage(emptyReview(), "fix: iets");
    expect(next.rounds[0]?.editedCommitMessage).toBeNull();
  });

  it("ziet leegmaken als ongewijzigd", () => {
    const edited = setEditedCommitMessage(emptyReview(), "iets anders");
    expect(setEditedCommitMessage(edited, "").rounds[0]?.editedCommitMessage).toBeNull();
  });
});
