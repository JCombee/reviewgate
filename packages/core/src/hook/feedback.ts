import type { Comment, Review, Round } from "../review/types.js";

/**
 * De markdown die als `permissionDecisionReason` terug de sessie in gaat (§10).
 *
 * Compact en machineleesbaar genoeg dat Claude er direct op kan werken: per bestand
 * gegroepeerd, regelnummers vooraan, vragen met een `?` zodat hij ze beantwoordt in
 * plaats van blind te fixen.
 */
export function renderChangesRequested(review: Review): string {
  const round = review.rounds[review.rounds.length - 1];
  const roundNumber = round?.n ?? 1;
  const open = review.comments.filter((c) => c.status === "open");

  const lines: string[] = [];
  lines.push(`# Code review: changes requested (ronde ${roundNumber})`);
  lines.push("");
  lines.push(
    "De commit is geblokkeerd. Verwerk onderstaande punten, en probeer daarna opnieuw te committen.",
  );
  lines.push(
    "Vragen (gemarkeerd met ?) beantwoord je in je antwoord aan de gebruiker; die hoef je niet te fixen.",
  );

  if (round?.summary) {
    lines.push("", "## Samenvatting", "", round.summary.trim());
  }

  const messageBlock = renderCommitMessage(round, open);
  if (messageBlock.length > 0) lines.push("", ...messageBlock);

  const globals = open.filter((c) => c.scope === "global");
  if (globals.length > 0) {
    lines.push("", "## Algemeen", "");
    for (const c of globals) lines.push(bullet(c));
  }

  for (const [path, comments] of groupByPath(open)) {
    lines.push("", `## ${path}`, "");
    for (const c of comments) lines.push(bullet(c));
  }

  const earlier = open.filter((c) => c.round < roundNumber);
  if (earlier.length > 0) {
    lines.push("", `## Nog open uit eerdere rondes`, "");
    for (const c of earlier) {
      const where = c.path ? `${c.path} ${lineRef(c)}: ` : "";
      lines.push(`- ${where}${firstLine(c.body)} (ronde ${c.round})`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Wat er bij een approve nog meegaat als `additionalContext` (§10). */
export function renderApproved(review: Review): string | null {
  const round = review.rounds[review.rounds.length - 1];
  const summary = round?.summary?.trim();
  if (!summary) return null;
  return `Code review: goedgekeurd (ronde ${round?.n ?? 1}).\n\n${summary}\n`;
}

// ---------------------------------------------------------------------------

/**
 * Het commit-message-blok verschijnt alleen als de message is bewerkt of als er een
 * comment over open staat, en bevat dan allebei die dingen (§10).
 */
function renderCommitMessage(round: Round | undefined, open: readonly Comment[]): string[] {
  const messageComments = open.filter((c) => c.scope === "commit_message");
  const edited = round?.editedCommitMessage ?? null;
  if (edited === null && messageComments.length === 0) return [];

  const lines: string[] = ["## Commit message", ""];
  if (edited !== null) {
    lines.push("Gebruik deze message (aangepast door de reviewer):", "");
    // Ingesprongen blok, zodat een message met backticks of markdown niets breekt.
    for (const line of edited.split("\n")) lines.push(`    ${line}`);
    if (messageComments.length > 0) lines.push("");
  }
  for (const c of messageComments) lines.push(bullet(c));
  return lines;
}

function groupByPath(comments: readonly Comment[]): Map<string, Comment[]> {
  const map = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.scope !== "line" || !c.path) continue;
    const list = map.get(c.path);
    if (list) list.push(c);
    else map.set(c.path, [c]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  }
  // Vaste volgorde: de feedback moet er bij elke ronde hetzelfde uitzien, ook als
  // de comments in een andere volgorde geplaatst zijn.
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function bullet(c: Comment): string {
  const mark = c.kind === "question" ? "? " : "";
  const ref = c.scope === "line" ? `${lineRef(c)}: ` : "";
  const body = c.body.trim().split("\n").join("\n  ");
  const replies = c.replies
    .filter((r) => r.author === "user")
    .map((r) => `\n  ${r.body.trim().split("\n").join("\n  ")}`)
    .join("");
  return `- ${mark}${ref}${body}${replies}`;
}

function lineRef(c: Comment): string {
  if (c.startLine === undefined) return "";
  const side = c.side === "old" ? "oud " : "";
  return c.endLine && c.endLine !== c.startLine
    ? `${side}L${c.startLine}-${c.endLine}`
    : `${side}L${c.startLine}`;
}

function firstLine(body: string): string {
  const [first] = body.trim().split("\n");
  return first ?? "";
}
