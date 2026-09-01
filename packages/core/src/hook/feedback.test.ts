import { describe, expect, it } from "vitest";
import type { Comment, Review } from "../review/types.js";
import { renderApproved, renderChangesRequested } from "./feedback.js";

const comment = (over: Partial<Comment>): Comment => ({
  id: Math.random().toString(36).slice(2),
  round: 1,
  scope: "line",
  kind: "issue",
  body: "iets",
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
  ...over,
});

describe("renderChangesRequested", () => {
  it("groepeert per bestand, op regelnummer gesorteerd", () => {
    const out = renderChangesRequested(
      review({
        comments: [
          comment({ path: "b.ts", side: "new", startLine: 17, body: "geen error-afhandeling" }),
          comment({ path: "a.php", side: "new", startLine: 91, body: "tweede" }),
          comment({
            path: "a.php",
            side: "new",
            startLine: 42,
            endLine: 48,
            body: "mist de tag-variant",
          }),
        ],
      }),
    );

    expect(out).toContain("# Code review: changes requested (ronde 2)");
    expect(out).toContain("## a.php\n\n- L42-48: mist de tag-variant\n- L91: tweede");
    expect(out).toContain("## b.ts\n\n- L17: geen error-afhandeling");
    expect(out.indexOf("## a.php")).toBeLessThan(out.indexOf("## b.ts"));
  });

  it("markeert vragen met een vraagteken", () => {
    const out = renderChangesRequested(
      review({
        comments: [
          comment({ kind: "question", path: "a.php", side: "new", startLine: 91, body: "waarom?" }),
        ],
      }),
    );
    expect(out).toContain("- ? L91: waarom?");
  });

  it("zet globale comments onder Algemeen", () => {
    const out = renderChangesRequested(
      review({ comments: [comment({ scope: "global", body: "hoort in app/Services/" })] }),
    );
    expect(out).toContain("## Algemeen\n\n- hoort in app/Services/");
  });

  it("neemt de samenvatting bovenaan mee", () => {
    const r = review();
    const withSummary = {
      ...r,
      rounds: [{ ...r.rounds[0]!, summary: "los eerst de cache-invalidatie op" }],
      comments: [comment({ scope: "global", body: "punt" })],
    };
    const out = renderChangesRequested(withSummary);
    expect(out).toContain("## Samenvatting\n\nlos eerst de cache-invalidatie op");
    expect(out.indexOf("## Samenvatting")).toBeLessThan(out.indexOf("## Algemeen"));
  });

  it("laat de samenvatting weg als hij leeg is", () => {
    expect(renderChangesRequested(review())).not.toContain("## Samenvatting");
  });

  it("toont het message-blok alleen bij een bewerking of een comment erover", () => {
    expect(renderChangesRequested(review())).not.toContain("## Commit message");

    const r = review();
    const edited = { ...r, rounds: [{ ...r.rounds[0]!, editedCommitMessage: "fix(x): beter\n\nRefs #412" }] };
    const out = renderChangesRequested(edited);
    expect(out).toContain("## Commit message");
    expect(out).toContain("    fix(x): beter");
    expect(out).toContain("    Refs #412");
  });

  it("zet bij een message-comment zowel de nieuwe message als de opmerking neer", () => {
    const r = review();
    const both: Review = {
      ...r,
      rounds: [{ ...r.rounds[0]!, editedCommitMessage: "fix(x): beter" }],
      comments: [comment({ scope: "commit_message", body: "splits dit in twee commits" })],
    };
    const out = renderChangesRequested(both);
    expect(out).toContain("    fix(x): beter");
    expect(out).toContain("- splits dit in twee commits");
  });

  it("negeert opgeloste en verouderde comments", () => {
    const out = renderChangesRequested(
      review({
        comments: [
          comment({ scope: "global", body: "opgelost", status: "resolved" }),
          comment({ scope: "global", body: "verouderd", status: "outdated" }),
        ],
      }),
    );
    expect(out).not.toContain("opgelost");
    expect(out).not.toContain("verouderd");
  });

  it("zet openstaande punten uit eerdere rondes apart", () => {
    const out = renderChangesRequested(
      review({
        comments: [comment({ round: 1, path: "a.php", side: "new", startLine: 23, body: "nog niet opgelost" })],
      }),
    );
    expect(out).toContain("## Nog open uit eerdere rondes");
    expect(out).toContain("- a.php L23: nog niet opgelost (ronde 1)");
  });

  it("neemt eigen reacties mee onder de comment", () => {
    const out = renderChangesRequested(
      review({
        comments: [
          comment({
            scope: "global",
            body: "punt",
            replies: [
              { author: "user", body: "en dit ook", at: "2026-01-01T00:00:00.000Z" },
              { author: "agent", body: "van de agent, niet meesturen", at: "2026-01-01T00:00:00.000Z" },
            ],
          }),
        ],
      }),
    );
    expect(out).toContain("en dit ook");
    expect(out).not.toContain("van de agent");
  });
});

describe("renderApproved", () => {
  it("geeft null zonder samenvatting", () => {
    expect(renderApproved(review())).toBeNull();
  });

  it("geeft de samenvatting mee als context", () => {
    const r = review();
    const out = renderApproved({ ...r, rounds: [{ ...r.rounds[0]!, summary: "opzet klopt" }] });
    expect(out).toContain("goedgekeurd (ronde 2)");
    expect(out).toContain("opzet klopt");
  });
});
