import { describe, expect, it } from "vitest";
import type { Comment, Review } from "../review/types.js";
import { renderApproved, renderChangesRequested } from "./feedback.js";

const comment = (over: Partial<Comment>): Comment => ({
  id: Math.random().toString(36).slice(2),
  round: 1,
  scope: "line",
  kind: "issue",
  body: "something",
  author: "user",
  status: "open",
  replies: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const review = (over: Partial<Review> = {}): Review => ({
  id: "r1",
  repoRoot: "/repo",
  branch: "feature/checkout",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  rounds: [
    {
      n: 2,
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
  ...over,
});

describe("renderChangesRequested", () => {
  it("groups per file, sorted by line number", () => {
    const out = renderChangesRequested(
      review({
        comments: [
          comment({ path: "b.ts", side: "new", startLine: 17, body: "no error handling" }),
          comment({ path: "a.php", side: "new", startLine: 91, body: "second" }),
          comment({
            path: "a.php",
            side: "new",
            startLine: 42,
            endLine: 48,
            body: "misses the tag variant",
          }),
        ],
      }),
    );

    expect(out).toContain("# Code review: changes requested (round 2)");
    expect(out).toContain("## a.php\n\n- L42-48: misses the tag variant\n- L91: second");
    expect(out).toContain("## b.ts\n\n- L17: no error handling");
    expect(out.indexOf("## a.php")).toBeLessThan(out.indexOf("## b.ts"));
  });

  it("marks questions with a question mark", () => {
    const out = renderChangesRequested(
      review({
        comments: [
          comment({ kind: "question", path: "a.php", side: "new", startLine: 91, body: "why?" }),
        ],
      }),
    );
    expect(out).toContain("- ? L91: why?");
  });

  it("puts global comments under General", () => {
    const out = renderChangesRequested(
      review({ comments: [comment({ scope: "global", body: "belongs in app/Services/" })] }),
    );
    expect(out).toContain("## General\n\n- belongs in app/Services/");
  });

  it("carries the summary at the top", () => {
    const r = review();
    const withSummary = {
      ...r,
      rounds: [{ ...r.rounds[0]!, summary: "sort out the cache invalidation first" }],
      comments: [comment({ scope: "global", body: "point" })],
    };
    const out = renderChangesRequested(withSummary);
    expect(out).toContain("## Summary\n\nsort out the cache invalidation first");
    expect(out.indexOf("## Summary")).toBeLessThan(out.indexOf("## General"));
  });

  it("leaves the summary out when it is empty", () => {
    expect(renderChangesRequested(review())).not.toContain("## Summary");
  });

  it("shows the message block only for an edit or a comment about it", () => {
    expect(renderChangesRequested(review())).not.toContain("## Commit message");

    const r = review();
    const edited = {
      ...r,
      rounds: [{ ...r.rounds[0]!, editedCommitMessage: "fix(x): better\n\nRefs #412" }],
    };
    const out = renderChangesRequested(edited);
    expect(out).toContain("## Commit message");
    expect(out).toContain("    fix(x): better");
    expect(out).toContain("    Refs #412");
  });

  it("shows both the new message and the remark for a message comment", () => {
    const r = review();
    const both: Review = {
      ...r,
      rounds: [{ ...r.rounds[0]!, editedCommitMessage: "fix(x): better" }],
      comments: [comment({ scope: "commit_message", body: "split this into two commits" })],
    };
    const out = renderChangesRequested(both);
    expect(out).toContain("    fix(x): better");
    expect(out).toContain("- split this into two commits");
  });

  it("ignores resolved and outdated comments", () => {
    const out = renderChangesRequested(
      review({
        comments: [
          comment({ scope: "global", body: "resolved point", status: "resolved" }),
          comment({ scope: "global", body: "outdated point", status: "outdated" }),
        ],
      }),
    );
    expect(out).not.toContain("resolved point");
    expect(out).not.toContain("outdated point");
  });

  it("sets open points from earlier rounds apart", () => {
    const out = renderChangesRequested(
      review({
        comments: [
          comment({ round: 1, path: "a.php", side: "new", startLine: 23, body: "not fixed yet" }),
        ],
      }),
    );
    expect(out).toContain("## Still open from earlier rounds");
    expect(out).toContain("- a.php L23: not fixed yet (round 1)");
  });

  it("carries your own replies under the comment", () => {
    const out = renderChangesRequested(
      review({
        comments: [
          comment({
            scope: "global",
            body: "point",
            replies: [
              { author: "user", body: "and this too", at: "2026-01-01T00:00:00.000Z" },
              {
                author: "agent",
                body: "from the agent, do not send",
                at: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        ],
      }),
    );
    expect(out).toContain("and this too");
    expect(out).not.toContain("from the agent");
  });
});

describe("renderApproved", () => {
  it("returns null without a summary", () => {
    expect(renderApproved(review())).toBeNull();
  });

  it("passes the summary along as context", () => {
    const r = review();
    const out = renderApproved({ ...r, rounds: [{ ...r.rounds[0]!, summary: "the shape holds" }] });
    expect(out).toContain("approved (round 2)");
    expect(out).toContain("the shape holds");
  });
});
