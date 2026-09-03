import fs from "node:fs/promises";
import type { IncomingSuggestion, Review, Severity } from "@reviewgate/core";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudePathInvalid, resolveClaudePath } from "./claude-path.js";

/**
 * The read-only reviewer assistant behind the chat panel and the automatic pass (§9).
 *
 * Runs through the Claude Agent SDK with `cwd` on the repo and only `Read`, `Grep` and
 * `Glob`. Explicitly without Edit, Write and Bash: the main session sits blocked and
 * waiting, and nothing may change under its hands.
 */

const ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

/** More transcript than this does not come along; otherwise it crowds out the diff. */
const MAX_TRANSCRIPT_CHARS = 40_000;
const MAX_DIFF_CHARS = 120_000;

export interface AgentContext {
  repoRoot: string;
  /** The patch the review is about. */
  patch: string;
  /** Transcript of the session that wrote the code (§9). */
  transcriptPath: string | null;
  /** Project instructions the pass should weigh. */
  projectDocs: string;
}

/**
 * The SDK is a heavy module and the hook runs on *every* commit. Loading it only when
 * a question or a pass actually arrives saves that at gate-open time; without chat you
 * pay nothing for it.
 */
type QueryFn = typeof import("@anthropic-ai/claude-agent-sdk").query;
let queryFn: QueryFn | null = null;

async function loadQuery(): Promise<QueryFn> {
  if (!queryFn) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = sdk.query;
  }
  return queryFn;
}

export class AgentUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailable";
  }
}

/**
 * The `claude` the SDK should spawn. Without one there is no assistant, and the reader
 * deserves a sentence they can act on rather than the SDK's talk of optional npm
 * dependencies.
 */
function claudeExecutable(): string {
  let path: string | null;
  try {
    path = resolveClaudePath();
  } catch (err) {
    if (err instanceof ClaudePathInvalid) throw new AgentUnavailable(err.message);
    throw err;
  }
  if (path) return path;
  throw new AgentUnavailable(
    "Claude Code was not found on this machine. Install Claude Code, or point REVIEWGATE_CLAUDE_PATH at the claude executable.",
  );
}

const SYSTEM_PROMPT = `You are a reviewer assistant inside ReviewGate, a local code review gate.

You explain and analyse; you change nothing. You have read-only access to the repo
(Read, Grep, Glob). Be explicit about what you know from the transcript of the writing
session and what you infer from the code — those two are not the same thing.

Answer briefly and concretely, with references in the form file:line.`;

const PASS_PROMPT = `Do a review pass over the diff below and return your findings as JSON.

Rules:
- Name only concrete defects with a place: file and line number on the new side.
- No style preferences, nothing a linter or type checker already catches.
- Name only what genuinely adds something. If there is nothing, return an empty list.
  Zero findings is a valid and often correct outcome.
- At most {CAP} findings. That is a ceiling, not a target.

Answer with JSON only, no text around it, in this shape:

{"findings":[{"path":"src/a.ts","line":42,"endLine":48,"severity":"blocker","body":"..."}]}

severity is "blocker", "consideration" or "nit".`;

export class ReviewAgent {
  /** The SDK session, so chat and pass share the same context (§9). */
  #sessionId: string | null = null;

  constructor(readonly context: AgentContext) {}

  #options(executable: string): Options {
    return {
      cwd: this.context.repoRoot,
      // The released binary carries no node_modules, so the SDK cannot resolve its own
      // native CLI. We point it at the `claude` that is on this machine instead.
      pathToClaudeCodeExecutable: executable,
      allowedTools: ALLOWED_TOOLS,
      // Double-locked: explicitly refuse what the review must not touch.
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash", "Task", "WebFetch", "WebSearch"],
      permissionMode: "default",
      systemPrompt: SYSTEM_PROMPT,
      includePartialMessages: true,
      ...(this.#sessionId ? { resume: this.#sessionId } : {}),
    };
  }

  /**
   * One question to the assistant. Text arrives piece by piece through `onToken`, so
   * the UI can read along while the answer grows.
   */
  async ask(prompt: string, onToken?: (text: string) => void): Promise<string> {
    const executable = claudeExecutable();
    let answer = "";
    try {
      const query = await loadQuery();
      for await (const message of query({ prompt, options: this.#options(executable) })) {
        this.#trackSession(message);
        const chunk = partialText(message);
        if (chunk) {
          answer += chunk;
          onToken?.(chunk);
        }
        if (message.type === "result") {
          if (message.subtype === "success") return message.result;
          throw new AgentUnavailable(`the agent stopped with "${message.subtype}"`);
        }
      }
    } catch (err) {
      if (err instanceof AgentUnavailable) throw err;
      throw new AgentUnavailable(err instanceof Error ? err.message : String(err));
    }
    return answer;
  }

  /** The context both the chat and the pass receive. */
  async contextPrompt(): Promise<string> {
    const transcript = await this.#transcript();
    const parts = [
      "# Diff under review",
      "",
      "```diff",
      truncate(this.context.patch, MAX_DIFF_CHARS),
      "```",
    ];
    if (this.context.projectDocs.trim() !== "") {
      parts.push("", "# Project instructions", "", this.context.projectDocs.trim());
    }
    if (transcript) {
      parts.push(
        "",
        "# Transcript of the session that wrote this code",
        "",
        "Use this to work out intent, not as truth about the code.",
        "",
        truncate(transcript, MAX_TRANSCRIPT_CHARS),
      );
    }
    return parts.join("\n");
  }

  /**
   * The automatic first pass. It yields findings that enter the review as
   * *suggestions*, not as comments: the agent may draw your attention to something,
   * but it may not put a judgement down on your behalf (§9).
   */
  async reviewPass(cap: number, review: Review): Promise<IncomingSuggestion[]> {
    const dismissed = review.suggestions.filter(
      (s) => s.status === "dismissed" && s.dismissedReason === "user",
    );

    const parts = [PASS_PROMPT.replace("{CAP}", String(cap)), "", await this.contextPrompt()];
    if (dismissed.length > 0) {
      parts.push(
        "",
        "# Findings dismissed earlier — do not repeat these",
        "",
        ...dismissed.map((s) => `- ${s.path ?? "general"}: ${s.body}`),
      );
    }

    const answer = await this.ask(parts.join("\n"));
    return parseFindings(answer);
  }

  #trackSession(message: SDKMessage): void {
    if (message.type === "system" && "session_id" in message) {
      this.#sessionId = (message as { session_id?: string }).session_id ?? this.#sessionId;
    }
  }

  async #transcript(): Promise<string | null> {
    if (!this.context.transcriptPath) return null;
    try {
      const raw = await fs.readFile(this.context.transcriptPath, "utf8");
      return summarizeTranscript(raw);
    } catch {
      return null;
    }
  }
}

/**
 * The transcript is JSONL with a lot of noise. We keep the text of the user and of the
 * assistant: that is where the intent sits.
 */
export function summarizeTranscript(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = transcriptText(entry);
    if (text) out.push(text);
  }
  return out.join("\n\n");
}

function transcriptText(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
  const role = e.message?.role;
  if (role !== "user" && role !== "assistant") return null;

  const content = e.message?.content;
  const label = role === "user" ? "User" : "Claude";

  if (typeof content === "string") return `${label}: ${content}`;
  if (!Array.isArray(content)) return null;

  const text = content
    .filter((b): b is { type: string; text: string } => {
      const block = b as { type?: string; text?: unknown };
      return block.type === "text" && typeof block.text === "string";
    })
    .map((b) => b.text)
    .join("\n");
  return text.trim() === "" ? null : `${label}: ${text}`;
}

/** Pulls the findings out of the answer, even with text around them. */
export function parseFindings(answer: string): IncomingSuggestion[] {
  const json = extractJson(answer);
  if (!json) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];

  const out: IncomingSuggestion[] = [];
  for (const raw of findings) {
    if (typeof raw !== "object" || raw === null) continue;
    const f = raw as {
      path?: unknown;
      line?: unknown;
      endLine?: unknown;
      severity?: unknown;
      body?: unknown;
    };
    if (typeof f.body !== "string" || f.body.trim() === "") continue;

    const severity: Severity =
      f.severity === "blocker" || f.severity === "nit" ? f.severity : "consideration";
    const hasLine = typeof f.line === "number" && Number.isInteger(f.line) && f.line > 0;
    const path = typeof f.path === "string" && f.path !== "" ? f.path : undefined;

    out.push({
      scope: path && hasLine ? "line" : "global",
      body: f.body.trim(),
      severity,
      ...(path ? { path } : {}),
      ...(path && hasLine ? { side: "new" as const } : {}),
      ...(hasLine ? { startLine: f.line as number } : {}),
      ...(hasLine && typeof f.endLine === "number" && f.endLine >= (f.line as number)
        ? { endLine: f.endLine }
        : {}),
    });
  }
  return out;
}

function extractJson(answer: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer);
  const text = fenced?.[1] ?? answer;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end <= start ? null : text.slice(start, end + 1);
}

function partialText(message: SDKMessage): string | null {
  if (message.type !== "stream_event") return null;
  const event = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } })
    .event;
  if (event?.type !== "content_block_delta") return null;
  return event.delta?.type === "text_delta" ? (event.delta.text ?? null) : null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated, ${text.length - max} characters omitted)`;
}

/** `CLAUDE.md` and, if present, the project's `REVIEW.md` (§9). */
export async function readProjectDocs(repoRoot: string): Promise<string> {
  const parts: string[] = [];
  for (const name of ["CLAUDE.md", "REVIEW.md"]) {
    try {
      const content = await fs.readFile(`${repoRoot}/${name}`, "utf8");
      parts.push(`## ${name}\n\n${content.trim()}`);
    } catch {
      // Not present is fine.
    }
  }
  return parts.join("\n\n");
}
