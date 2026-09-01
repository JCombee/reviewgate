import fs from "node:fs/promises";
import type { IncomingSuggestion, Review, Severity } from "@reviewgate/core";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * De read-only reviewer-assistent achter het chatpaneel en de automatische pass (§9).
 *
 * Draait via de Claude Agent SDK met `cwd` op de repo en alleen `Read`, `Grep` en
 * `Glob`. Expliciet zonder Edit, Write en Bash: de hoofdsessie staat geblokkeerd te
 * wachten en er mag niets onder handen veranderen.
 */

const ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

/** Meer transcript dan dit gaat niet mee; anders verdringt het de diff zelf. */
const MAX_TRANSCRIPT_CHARS = 40_000;
const MAX_DIFF_CHARS = 120_000;

export interface AgentContext {
  repoRoot: string;
  /** De patch waar de review over gaat. */
  patch: string;
  /** Transcript van de sessie die de code schreef (§9). */
  transcriptPath: string | null;
  /** Projectinstructies die de pass moet meewegen. */
  projectDocs: string;
}

/**
 * De SDK is een zware module en de hook draait bij élke commit. Hem pas laden als
 * er daadwerkelijk een vraag of een pass komt scheelt dat bij het openen van de
 * gate; zonder chat betaal je er niets voor.
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

const SYSTEM_PROMPT = `Je bent een reviewer-assistent in ReviewGate, een lokale code review gate.

Je legt uit en analyseert; je wijzigt niets. Je hebt alleen leesrechten op de repo
(Read, Grep, Glob). Wees expliciet over wat je uit het transcript van de schrijvende
sessie weet en wat je uit de code afleidt — die twee zijn niet hetzelfde.

Antwoord in het Nederlands, kort en concreet, met verwijzingen als bestand:regel.`;

const PASS_PROMPT = `Doe een review-pass over de diff hieronder en lever je bevindingen als JSON.

Regels:
- Noem alleen concrete defecten met een plek: bestand en regelnummer aan de nieuwe kant.
- Geen stijlvoorkeuren, geen dingen die een linter of typechecker al vangt.
- Noem alleen wat daadwerkelijk iets toevoegt. Als er niets is, lever een lege lijst.
  Nul bevindingen is een geldige en vaak juiste uitkomst.
- Hoogstens {CAP} bevindingen. Dat is een plafond, geen doel.

Antwoord met uitsluitend JSON, zonder tekst eromheen, in deze vorm:

{"findings":[{"path":"src/a.ts","line":42,"endLine":48,"severity":"blocker","body":"..."}]}

severity is "blocker", "aandachtspunt" of "nit".`;

export class ReviewAgent {
  /** Sessie van de SDK, zodat chat en pass dezelfde context delen (§9). */
  #sessionId: string | null = null;

  constructor(readonly context: AgentContext) {}

  #options(): Options {
    return {
      cwd: this.context.repoRoot,
      allowedTools: ALLOWED_TOOLS,
      // Dubbel op slot: expliciet weigeren wat de review niet mag aanraken.
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash", "Task", "WebFetch", "WebSearch"],
      permissionMode: "default",
      systemPrompt: SYSTEM_PROMPT,
      includePartialMessages: true,
      ...(this.#sessionId ? { resume: this.#sessionId } : {}),
    };
  }

  /**
   * Eén vraag aan de assistent. Tekst komt stukje bij beetje binnen via `onToken`,
   * zodat de UI kan meelezen terwijl het antwoord groeit.
   */
  async ask(prompt: string, onToken?: (text: string) => void): Promise<string> {
    let answer = "";
    try {
      const query = await loadQuery();
      for await (const message of query({ prompt, options: this.#options() })) {
        this.#trackSession(message);
        const chunk = partialText(message);
        if (chunk) {
          answer += chunk;
          onToken?.(chunk);
        }
        if (message.type === "result") {
          if (message.subtype === "success") return message.result;
          throw new AgentUnavailable(`de agent stopte met "${message.subtype}"`);
        }
      }
    } catch (err) {
      if (err instanceof AgentUnavailable) throw err;
      throw new AgentUnavailable(err instanceof Error ? err.message : String(err));
    }
    return answer;
  }

  /** De context die zowel de chat als de pass meekrijgt. */
  async contextPrompt(): Promise<string> {
    const transcript = await this.#transcript();
    const parts = [
      "# Diff onder review",
      "",
      "```diff",
      truncate(this.context.patch, MAX_DIFF_CHARS),
      "```",
    ];
    if (this.context.projectDocs.trim() !== "") {
      parts.push("", "# Projectinstructies", "", this.context.projectDocs.trim());
    }
    if (transcript) {
      parts.push(
        "",
        "# Transcript van de sessie die deze code schreef",
        "",
        "Gebruik dit om intentie te achterhalen, niet als waarheid over de code.",
        "",
        truncate(transcript, MAX_TRANSCRIPT_CHARS),
      );
    }
    return parts.join("\n");
  }

  /**
   * De automatische eerste pass. Levert bevindingen die als *suggesties* in de
   * review komen, niet als comments: de agent mag je aandacht ergens op vestigen,
   * maar niet namens jou een oordeel neerzetten (§9).
   */
  async reviewPass(cap: number, review: Review): Promise<IncomingSuggestion[]> {
    const dismissed = review.suggestions.filter(
      (s) => s.status === "dismissed" && s.dismissedReason === "user",
    );

    const parts = [PASS_PROMPT.replace("{CAP}", String(cap)), "", await this.contextPrompt()];
    if (dismissed.length > 0) {
      parts.push(
        "",
        "# Eerder afgewezen bevindingen — niet herhalen",
        "",
        ...dismissed.map((s) => `- ${s.path ?? "algemeen"}: ${s.body}`),
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
 * Het transcript is JSONL met veel ruis. We houden de tekst van de gebruiker en van
 * de assistent over: dat is waar de intentie in zit.
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
  const label = role === "user" ? "Gebruiker" : "Claude";

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

/** Haalt de findings uit het antwoord, ook als er tekst omheen staat. */
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
      f.severity === "blocker" || f.severity === "nit" ? f.severity : "aandachtspunt";
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
  return `${text.slice(0, max)}\n… (afgekapt, ${text.length - max} tekens weggelaten)`;
}

/** `CLAUDE.md` en een eventuele `REVIEW.md` van het project (§9). */
export async function readProjectDocs(repoRoot: string): Promise<string> {
  const parts: string[] = [];
  for (const name of ["CLAUDE.md", "REVIEW.md"]) {
    try {
      const content = await fs.readFile(`${repoRoot}/${name}`, "utf8");
      parts.push(`## ${name}\n\n${content.trim()}`);
    } catch {
      // Niet aanwezig is prima.
    }
  }
  return parts.join("\n\n");
}
