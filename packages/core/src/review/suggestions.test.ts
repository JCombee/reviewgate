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
  body: "iets",
  severity: "aandachtspunt",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const incoming = (over: Partial<IncomingSuggestion> = {}): IncomingSuggestion => ({
  scope: "line",
  body: "deze fetch heeft geen error-afhandeling",
  severity: "aandachtspunt",
  path: "a.ts",
  side: "new",
  startLine: 17,
  ...over,
});

describe("suggestionCap", () => {
  it("schaalt mee met de diff: twee per vijftig regels", () => {
    expect(suggestionCap(50)).toBe(2);
    expect(suggestionCap(200)).toBe(8);
    expect(suggestionCap(500)).toBe(20);
  });

  it("houdt de ondergrens van twee aan bij een kleine diff", () => {
    expect(suggestionCap(0)).toBe(2);
    expect(suggestionCap(10)).toBe(2);
  });

  it("kapt af op twintig bij een enorme refactor", () => {
    expect(suggestionCap(10_000)).toBe(20);
  });
});

describe("applyCap", () => {
  it("houdt de hoogste severity aan, dan bestand en regelnummer", () => {
    const items = [
      { severity: "nit" as const, path: "a.ts", startLine: 1 },
      { severity: "blocker" as const, path: "z.ts", startLine: 99 },
      { severity: "aandachtspunt" as const, path: "a.ts", startLine: 5 },
      { severity: "aandachtspunt" as const, path: "a.ts", startLine: 2 },
    ];
    const { kept, dropped } = applyCap(items, 2);
    expect(kept.map((k) => k.severity)).toEqual(["blocker", "aandachtspunt"]);
    expect(kept[1]?.startLine).toBe(2);
    expect(dropped).toHaveLength(2);
  });
});

describe("normalize en similarity", () => {
  it("haalt regelnummers weg, want een verschoven regel is dezelfde opmerking", () => {
    expect(normalize("L42: mist de tag-variant")).toBe(normalize("L58: mist de tag-variant"));
  });

  it("geeft 1 voor identieke tekst", () => {
    expect(similarity("de fetch heeft geen error-afhandeling", "de fetch heeft geen error-afhandeling")).toBe(1);
  });

  it("geeft een lage score voor iets heel anders", () => {
    expect(similarity("de fetch heeft geen error-afhandeling", "deze functie hoort in een andere map")).toBeLessThan(0.3);
  });

  it("werkt ook bij korte teksten", () => {
    expect(similarity("mist null-check", "mist null-check")).toBe(1);
    expect(similarity("mist null-check", "verkeerde volgorde")).toBe(0);
  });
});

describe("findDuplicate", () => {
  const dismissed = suggestion({
    id: "oud",
    body: "deze fetch heeft geen error-afhandeling",
    path: "a.ts",
    startLine: 17,
    status: "dismissed",
    dismissedReason: "user",
  });

  it("herkent dezelfde opmerking op een verschoven regel in hetzelfde bestand", () => {
    const match = findDuplicate(
      { body: "deze fetch heeft nog steeds geen error-afhandeling", path: "a.ts", startLine: 17 },
      [dismissed],
    );
    expect(match?.duplicateOf).toBe("oud");
  });

  it("laat een ander punt in hetzelfde bestand met rust", () => {
    expect(
      findDuplicate({ body: "deze variabele is nergens gebruikt", path: "a.ts", startLine: 17 }, [
        dismissed,
      ]),
    ).toBeNull();
  });

  it("onderdrukt alleen wat jij hebt afgewezen, niet wat bij een beslissing dichtging", () => {
    const closed = { ...dismissed, dismissedReason: "round_closed" as const };
    expect(
      findDuplicate({ body: "deze fetch heeft geen error-afhandeling", path: "a.ts", startLine: 17 }, [
        closed,
      ]),
    ).toBeNull();
  });

  it("negeert nog openstaande voorstellen", () => {
    const pending = { ...dismissed, status: "pending" as const };
    expect(
      findDuplicate({ body: "deze fetch heeft geen error-afhandeling", path: "a.ts" }, [pending]),
    ).toBeNull();
  });

  it("hanteert een strengere drempel buiten het oorspronkelijke bestand", () => {
    const elders = { body: "deze fetch heeft nog steeds geen error-afhandeling", path: "b.ts" };
    // Zelfde bestand haalt 0.6 wel, een ander bestand de vereiste 0.8 niet.
    expect(findDuplicate({ ...elders, path: "a.ts", startLine: 17 }, [dismissed])).not.toBeNull();
    expect(findDuplicate(elders, [dismissed])).toBeNull();
  });
});

describe("addSuggestions", () => {
  it("voegt voorstellen toe als pending", () => {
    const { review: next, added } = addSuggestions(review(), [incoming()], { cap: 5 });
    expect(added).toHaveLength(1);
    expect(next.suggestions[0]).toMatchObject({ status: "pending", round: 2, severity: "aandachtspunt" });
  });

  it("wijst een herhaald voorstel automatisch af, maar gooit het niet weg", () => {
    const eerder = suggestion({
      id: "oud",
      body: "deze fetch heeft geen error-afhandeling",
      path: "a.ts",
      startLine: 17,
      status: "dismissed",
      dismissedReason: "user",
    });
    const { review: next, added, duplicates } = addSuggestions(review([eerder]), [incoming()], {
      cap: 5,
    });

    expect(added).toHaveLength(0);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.score).toBeGreaterThan(0.6);
    expect(next.suggestions).toHaveLength(2);
    expect(next.suggestions[1]).toMatchObject({
      status: "dismissed",
      dismissedReason: "auto_duplicate",
      duplicateOf: "oud",
    });
  });

  it("telt automatisch afgewezen duplicaten niet mee voor de cap", () => {
    const eerder = suggestion({
      id: "oud",
      body: "deze fetch heeft geen error-afhandeling",
      path: "a.ts",
      startLine: 17,
      status: "dismissed",
      dismissedReason: "user",
    });
    const items = [
      incoming(),
      incoming({ body: "hier ontbreekt een null-check", startLine: 30 }),
      incoming({ body: "deze naam dekt de lading niet", startLine: 40 }),
    ];
    const { added, duplicates } = addSuggestions(review([eerder]), items, { cap: 2 });
    expect(duplicates).toHaveLength(1);
    // De cap van 2 geldt over de twee nieuwe bevindingen, niet over het duplicaat.
    expect(added).toHaveLength(2);
  });

  it("kapt af op de cap en meldt wat er afviel", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      incoming({ body: `punt nummer ${"x".repeat(i + 1)} anders`, startLine: 10 + i }),
    );
    const { added, dropped } = addSuggestions(review(), items, { cap: 2 });
    expect(added).toHaveLength(2);
    expect(dropped).toHaveLength(3);
  });

  it("nul voorstellen is een geldige uitkomst", () => {
    const { review: next, added } = addSuggestions(review(), [], { cap: 5 });
    expect(added).toEqual([]);
    expect(next.suggestions).toEqual([]);
  });
});

describe("statuswisselingen", () => {
  it("afwijzen bewaart het voorstel met reden", () => {
    const next = dismissSuggestion(review([suggestion({ id: "s1" })]), "s1");
    expect(next.suggestions[0]).toMatchObject({ status: "dismissed", dismissedReason: "user" });
  });

  it("heropenen haalt de afwijzing weg", () => {
    const auto = suggestion({
      id: "s1",
      status: "dismissed",
      dismissedReason: "auto_duplicate",
      duplicateOf: "oud",
    });
    const next = reopenSuggestion(review([auto]), "s1");
    expect(next.suggestions[0]?.status).toBe("pending");
    expect(next.suggestions[0]?.dismissedReason).toBeUndefined();
    expect(next.suggestions[0]?.duplicateOf).toBeUndefined();
  });

  it("overnemen wijst naar de comment die eruit voortkwam", () => {
    const next = acceptSuggestion(review([suggestion({ id: "s1" })]), "s1", "c9");
    expect(next.suggestions[0]).toMatchObject({ status: "accepted", promotedToCommentId: "c9" });
  });

  it("een beslissing sluit openstaande voorstellen met round_closed", () => {
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
