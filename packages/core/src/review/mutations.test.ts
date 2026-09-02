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
      commitMessage: "fix: something",
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
  body: "this invalidation path misses the tag variant",
  path: "app/Service.php",
  side: "new" as const,
  startLine: 42,
};

describe("addComment", () => {
  it("places a global comment with its round attached", () => {
    const { review, comment } = addComment(emptyReview(), {
      scope: "global",
      body: "this belongs in app/Services/",
    });
    expect(review.comments).toHaveLength(1);
    expect(comment).toMatchObject({ scope: "global", round: 1, status: "open", author: "user" });
    expect(comment.kind).toBe("issue");
  });

  it("places a line comment and fills in the end of the range", () => {
    const { comment } = addComment(emptyReview(), lineComment);
    expect(comment.startLine).toBe(42);
    expect(comment.endLine).toBe(42);
  });

  it("keeps a genuine range", () => {
    const { comment } = addComment(emptyReview(), { ...lineComment, endLine: 48 });
    expect([comment.startLine, comment.endLine]).toEqual([42, 48]);
  });

  it("refuses an empty body", () => {
    expect(() => addComment(emptyReview(), { scope: "global", body: "   " })).toThrow(ReviewError);
  });

  it("refuses a line comment without a path, side or line", () => {
    const base = emptyReview();
    expect(() => addComment(base, { scope: "line", body: "x", side: "new", startLine: 1 })).toThrow(
      /path/,
    );
    expect(() => addComment(base, { scope: "line", body: "x", path: "a", startLine: 1 })).toThrow(
      /side/,
    );
    expect(() => addComment(base, { scope: "line", body: "x", path: "a", side: "new" })).toThrow(
      /start line/,
    );
  });

  it("refuses a reversed range", () => {
    expect(() => addComment(emptyReview(), { ...lineComment, endLine: 40 })).toThrow(/range/);
  });

  it("keeps a question distinct from a remark", () => {
    const { comment } = addComment(emptyReview(), {
      scope: "line",
      kind: "question",
      body: "why wrap one write in a transaction?",
      path: "a.php",
      side: "new",
      startLine: 91,
    });
    expect(comment.kind).toBe("question");
    // A question is an open comment too, so it holds the button (§8).
    expect(openComments({ ...emptyReview(), comments: [comment] })).toHaveLength(1);
  });
});

describe("updating a comment", () => {
  it("changes the text", () => {
    const { review, comment } = addComment(emptyReview(), { scope: "global", body: "first" });
    const next = editComment(review, comment.id, "second");
    expect(next.comments[0]?.body).toBe("second");
  });

  it("deletes a comment", () => {
    const { review, comment } = addComment(emptyReview(), { scope: "global", body: "gone" });
    expect(deleteComment(review, comment.id).comments).toHaveLength(0);
  });

  it("returns 404 for an unknown comment", () => {
    try {
      deleteComment(emptyReview(), "does-not-exist");
      expect.unreachable();
    } catch (err) {
      expect((err as ReviewError).status).toBe(404);
    }
  });

  it("adds a reply with a timestamp and an author", () => {
    const { review, comment } = addComment(emptyReview(), { scope: "global", body: "point" });
    const next = addReply(review, comment.id, "agreed", "agent");
    expect(next.comments[0]?.replies).toHaveLength(1);
    expect(next.comments[0]?.replies[0]).toMatchObject({ author: "agent", body: "agreed" });
  });
});

describe("resolve", () => {
  it("takes a comment out of the open count and puts it back", () => {
    const { review, comment } = addComment(emptyReview(), { scope: "global", body: "point" });
    const resolved = setCommentStatus(review, comment.id, true);
    expect(openComments(resolved)).toHaveLength(0);
    expect(openComments(setCommentStatus(resolved, comment.id, false))).toHaveLength(1);
  });

  it("leaves an outdated comment alone", () => {
    const { review, comment } = addComment(emptyReview(), { scope: "global", body: "point" });
    const outdated: Review = {
      ...review,
      comments: review.comments.map((c) => ({ ...c, status: "outdated" as const })),
    };
    expect(setCommentStatus(outdated, comment.id, true).comments[0]?.status).toBe("outdated");
    expect(openComments(outdated)).toHaveLength(0);
  });
});

describe("commit message", () => {
  it("stores an adjusted message", () => {
    const next = setEditedCommitMessage(emptyReview(), "fix(checkout): invalidate tags");
    expect(next.rounds[0]?.editedCommitMessage).toBe("fix(checkout): invalidate tags");
  });

  it("does not treat retyping the original message as a change", () => {
    const next = setEditedCommitMessage(emptyReview(), "fix: something");
    expect(next.rounds[0]?.editedCommitMessage).toBeNull();
  });

  it("treats clearing the field as unchanged", () => {
    const edited = setEditedCommitMessage(emptyReview(), "something else");
    expect(setEditedCommitMessage(edited, "").rounds[0]?.editedCommitMessage).toBeNull();
  });
});
