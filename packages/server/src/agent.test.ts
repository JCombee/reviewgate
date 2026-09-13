import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "./agent.js";
import { parseFindings, ReviewAgent, summarizeTranscript } from "./agent.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

describe("parseFindings", () => {
  it("reads a plain JSON list", () => {
    const out = parseFindings(
      '{"findings":[{"path":"a.ts","line":42,"endLine":48,"severity":"blocker","body":"misses the tag variant"}]}',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      scope: "line",
      path: "a.ts",
      side: "new",
      startLine: 42,
      endLine: 48,
      severity: "blocker",
      body: "misses the tag variant",
    });
  });

  it("pulls the JSON out of a code block with text around it", () => {
    const out = parseFindings(
      'Here are my findings:\n\n```json\n{"findings":[{"path":"a.ts","line":1,"body":"something"}]}\n```\n\nThat was it.',
    );
    expect(out).toHaveLength(1);
  });

  it("falls back to consideration for an unknown severity", () => {
    const out = parseFindings(
      '{"findings":[{"path":"a.ts","line":1,"severity":"severe","body":"x"}]}',
    );
    expect(out[0]?.severity).toBe("consideration");
  });

  it("makes it a global finding without a path or line", () => {
    const out = parseFindings('{"findings":[{"body":"the whole shape is off"}]}');
    expect(out[0]).toMatchObject({ scope: "global", body: "the whole shape is off" });
    expect(out[0]?.path).toBeUndefined();
  });

  it("ignores findings without text", () => {
    expect(parseFindings('{"findings":[{"path":"a.ts","line":1,"body":"   "}]}')).toEqual([]);
  });

  it("returns an empty list for unreadable or empty output", () => {
    expect(parseFindings("no JSON here")).toEqual([]);
    expect(parseFindings('{"findings":[]}')).toEqual([]);
    expect(parseFindings("")).toEqual([]);
  });

  it("ignores an endLine that comes before the start line", () => {
    const out = parseFindings('{"findings":[{"path":"a.ts","line":10,"endLine":3,"body":"x"}]}');
    expect(out[0]?.endLine).toBeUndefined();
  });
});

describe("summarizeTranscript", () => {
  it("keeps only the text of the user and the assistant", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "add caching" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I am wrapping a repository around it" },
            { type: "tool_use", name: "Edit", input: {} },
          ],
        },
      }),
      JSON.stringify({ type: "system", subtype: "init" }),
      "not json",
    ].join("\n");

    expect(summarizeTranscript(jsonl)).toBe(
      "User: add caching\n\nClaude: I am wrapping a repository around it",
    );
  });

  it("returns an empty string for an empty transcript", () => {
    expect(summarizeTranscript("")).toBe("");
  });
});

describe("ReviewAgent's SDK options", () => {
  function baseContext(model?: string | null): AgentContext {
    return {
      repoRoot: "/repo",
      patch: "diff --git a/a.ts b/a.ts",
      transcriptPath: null,
      projectDocs: "",
      ...(model === undefined ? {} : { model }),
    };
  }

  async function* successResult() {
    yield { type: "result", subtype: "success", result: "ok" } as const;
  }

  beforeEach(async () => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(sdk.query).mockReset().mockReturnValue(successResult());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes model when the context has a non-empty one", async () => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const agent = new ReviewAgent(baseContext("claude-opus-4-8"));
    await agent.ask("hello");

    const call = vi.mocked(sdk.query).mock.calls[0]?.[0] as { options: { model?: string } };
    expect(call.options.model).toBe("claude-opus-4-8");
  });

  it.each([[undefined], [null], [""]])(
    "omits model from the SDK options when the context's model is %p",
    async (model) => {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const agent = new ReviewAgent(baseContext(model));
      await agent.ask("hello");

      const call = vi.mocked(sdk.query).mock.calls[0]?.[0] as {
        options: Record<string, unknown>;
      };
      expect(call.options).not.toHaveProperty("model");
    },
  );
});
