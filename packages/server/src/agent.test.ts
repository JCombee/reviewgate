import { describe, expect, it } from "vitest";
import { parseFindings, summarizeTranscript } from "./agent.js";

describe("parseFindings", () => {
  it("leest een gewone JSON-lijst", () => {
    const out = parseFindings(
      '{"findings":[{"path":"a.ts","line":42,"endLine":48,"severity":"blocker","body":"mist de tag-variant"}]}',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      scope: "line",
      path: "a.ts",
      side: "new",
      startLine: 42,
      endLine: 48,
      severity: "blocker",
      body: "mist de tag-variant",
    });
  });

  it("haalt de JSON uit een codeblok met tekst eromheen", () => {
    const out = parseFindings(
      'Hier zijn mijn bevindingen:\n\n```json\n{"findings":[{"path":"a.ts","line":1,"body":"iets"}]}\n```\n\nDat was het.',
    );
    expect(out).toHaveLength(1);
  });

  it("valt terug op aandachtspunt bij een onbekende severity", () => {
    const out = parseFindings('{"findings":[{"path":"a.ts","line":1,"severity":"ernstig","body":"x"}]}');
    expect(out[0]?.severity).toBe("aandachtspunt");
  });

  it("maakt er een globale bevinding van zonder pad of regel", () => {
    const out = parseFindings('{"findings":[{"body":"de opzet klopt niet"}]}');
    expect(out[0]).toMatchObject({ scope: "global", body: "de opzet klopt niet" });
    expect(out[0]?.path).toBeUndefined();
  });

  it("negeert bevindingen zonder tekst", () => {
    expect(parseFindings('{"findings":[{"path":"a.ts","line":1,"body":"   "}]}')).toEqual([]);
  });

  it("geeft een lege lijst bij onleesbare of lege uitvoer", () => {
    expect(parseFindings("geen JSON hier")).toEqual([]);
    expect(parseFindings('{"findings":[]}')).toEqual([]);
    expect(parseFindings("")).toEqual([]);
  });

  it("negeert een endLine die vóór de startregel ligt", () => {
    const out = parseFindings('{"findings":[{"path":"a.ts","line":10,"endLine":3,"body":"x"}]}');
    expect(out[0]?.endLine).toBeUndefined();
  });
});

describe("summarizeTranscript", () => {
  it("houdt alleen de tekst van gebruiker en assistent over", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "voeg caching toe" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ik zet er een repository omheen" },
            { type: "tool_use", name: "Edit", input: {} },
          ],
        },
      }),
      JSON.stringify({ type: "system", subtype: "init" }),
      "geen json",
    ].join("\n");

    expect(summarizeTranscript(jsonl)).toBe(
      "Gebruiker: voeg caching toe\n\nClaude: ik zet er een repository omheen",
    );
  });

  it("geeft een lege string voor een leeg transcript", () => {
    expect(summarizeTranscript("")).toBe("");
  });
});
