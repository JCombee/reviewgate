import type {
  Diff,
  DiffFile,
  DiffHunk,
  DiffLine,
  FileStatus,
  ReviewScope,
} from "../types.js";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const SUBMODULE_MODE = "160000";

/**
 * Parser voor `git diff -U<n> --no-color` output.
 *
 * Bewust dun: hij levert precies de structuur die anchoring en de UI nodig hebben (§4).
 * Hij normaliseert niets aan de regelinhoud — CRLF-checkouts leveren wat git levert,
 * en alleen de regelscheiding wordt CRLF-veilig gesplitst (§12).
 */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const lines = patch.split(/\r?\n/);
  const files: DiffFile[] = [];

  let file: MutableFile | null = null;
  let hunk: DiffHunk | null = null;
  /** De laatst geopende hunk, ook als hij al gesloten is. Alleen voor de `\`-marker. */
  let lastHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  // Resterende regels volgens de hunk-header. Zodra beide op nul staan is de hunk
  // compleet en hoort wat volgt weer bij het bestandsniveau. Zonder deze teller
  // komt de lege slotregel die elke patch heeft binnen als lege contextregel.
  let oldLeft = 0;
  let newLeft = 0;

  const flushFile = (): void => {
    if (file) files.push(finalizeFile(file));
    file = null;
    hunk = null;
    lastHunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (line.startsWith("diff --git ")) {
      flushFile();
      const paths = parseGitHeaderPaths(line.slice("diff --git ".length));
      file = newMutableFile(paths.old, paths.new);
      continue;
    }

    // Regels vóór het eerste `diff --git` (bijv. commit-headers) negeren we.
    if (!file) continue;
    const f: MutableFile = file;

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" hoort bij de regel ervoor. Dat kan de laatste
      // regel van een net volgelopen hunk zijn, dus val terug op de vorige hunk.
      const target = hunk ?? lastHunk;
      const prev = target?.lines[target.lines.length - 1];
      if (prev) prev.noNewlineAtEof = true;
      continue;
    }

    if (hunk === null) {
      if (readHeaderLine(f, line)) continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? "",
        lines: [],
      };
      f.hunks.push(hunk);
      lastHunk = hunk;
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      continue;
    }

    if (hunk === null) continue;

    const marker = line.charAt(0);
    const content = line.slice(1);

    if (marker === "+") {
      hunk.lines.push(mkLine("add", content, null, newLine++));
      f.additions++;
      newLeft--;
    } else if (marker === "-") {
      hunk.lines.push(mkLine("del", content, oldLine++, null));
      f.deletions++;
      oldLeft--;
    } else if (marker === " " || line === "") {
      // Een lege regel binnen een nog niet volle hunk is een lege contextregel
      // waarvan de spatie onderweg is weggeknipt; behandel hem als context.
      hunk.lines.push(mkLine("context", marker === " " ? content : "", oldLine++, newLine++));
      oldLeft--;
      newLeft--;
    } else {
      // Onbekende regel binnen een hunk (bijv. het begin van een volgend bestand
      // zonder `diff --git`): sluit de hunk en probeer hem als header te lezen.
      hunk = null;
      readHeaderLine(f, line);
    }

    if (hunk !== null && oldLeft <= 0 && newLeft <= 0) hunk = null;
  }

  flushFile();
  return files;
}

/** Bouwt de complete `Diff` inclusief totalen voor een scope. */
export function buildDiff(scope: ReviewScope, files: DiffFile[]): Diff {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return {
    scope,
    files,
    additions,
    deletions,
    changedLines: additions + deletions,
  };
}

// ---------------------------------------------------------------------------

interface MutableFile {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus | null;
  binary: boolean;
  similarity: number | null;
  oldMode: string | null;
  newMode: string | null;
  renamed: boolean;
  copied: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

function newMutableFile(oldPath: string | null, newPath: string | null): MutableFile {
  return {
    oldPath,
    newPath,
    status: null,
    binary: false,
    similarity: null,
    oldMode: null,
    newMode: null,
    renamed: false,
    copied: false,
    additions: 0,
    deletions: 0,
    hunks: [],
  };
}

function mkLine(
  type: DiffLine["type"],
  content: string,
  oldLine: number | null,
  newLine: number | null,
): DiffLine {
  return { type, content, oldLine, newLine, noNewlineAtEof: false };
}

/** Leest één headerregel van een bestandsblok. Geeft true als de regel is verwerkt. */
function readHeaderLine(f: MutableFile, line: string): boolean {
  if (line.startsWith("old mode ")) {
    f.oldMode = line.slice("old mode ".length).trim();
    return true;
  }
  if (line.startsWith("new mode ")) {
    f.newMode = line.slice("new mode ".length).trim();
    return true;
  }
  if (line.startsWith("new file mode ")) {
    f.status = "added";
    f.newMode = line.slice("new file mode ".length).trim();
    f.oldPath = null;
    return true;
  }
  if (line.startsWith("deleted file mode ")) {
    f.status = "deleted";
    f.oldMode = line.slice("deleted file mode ".length).trim();
    f.newPath = null;
    return true;
  }
  if (line.startsWith("similarity index ")) {
    const n = Number.parseInt(line.slice("similarity index ".length), 10);
    f.similarity = Number.isNaN(n) ? null : n;
    return true;
  }
  if (line.startsWith("dissimilarity index ")) return true;
  if (line.startsWith("rename from ")) {
    f.renamed = true;
    f.oldPath = line.slice("rename from ".length);
    return true;
  }
  if (line.startsWith("rename to ")) {
    f.renamed = true;
    f.newPath = line.slice("rename to ".length);
    return true;
  }
  if (line.startsWith("copy from ")) {
    f.copied = true;
    f.oldPath = line.slice("copy from ".length);
    return true;
  }
  if (line.startsWith("copy to ")) {
    f.copied = true;
    f.newPath = line.slice("copy to ".length);
    return true;
  }
  if (line.startsWith("index ")) {
    // "index <old>..<new> <mode>" — de mode staat er alleen bij als hij ongewijzigd is.
    const mode = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d+)$/.exec(line)?.[1];
    if (mode) {
      f.oldMode ??= mode;
      f.newMode ??= mode;
    }
    return true;
  }
  if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
    f.binary = true;
    return true;
  }
  if (line.startsWith("--- ")) {
    const p = stripPrefix(line.slice(4));
    if (p === null) f.status ??= "added";
    else f.oldPath = p;
    return true;
  }
  if (line.startsWith("+++ ")) {
    const p = stripPrefix(line.slice(4));
    if (p === null) f.status ??= "deleted";
    else f.newPath = p;
    return true;
  }
  return false;
}

function finalizeFile(f: MutableFile): DiffFile {
  const submodule = f.oldMode === SUBMODULE_MODE || f.newMode === SUBMODULE_MODE;
  const status: FileStatus =
    f.status ??
    (f.renamed
      ? "renamed"
      : f.copied
        ? "copied"
        : f.hunks.length === 0 &&
            !f.binary &&
            f.oldMode !== null &&
            f.newMode !== null &&
            f.oldMode !== f.newMode
          ? "mode_changed"
          : "modified");

  // Een rename kan óók inhoudswijzigingen hebben; die blijft "renamed", want dat
  // is wat de UI moet tonen. De hunks zitten er gewoon bij.
  const path = f.newPath ?? f.oldPath ?? "";

  return {
    path,
    oldPath: f.oldPath,
    newPath: f.newPath,
    status,
    binary: f.binary,
    submodule,
    similarity: f.similarity,
    oldMode: f.oldMode,
    newMode: f.newMode,
    additions: f.additions,
    deletions: f.deletions,
    hunks: f.hunks,
  };
}

/** `a/src/foo.ts` → `src/foo.ts`; `/dev/null` → null. */
function stripPrefix(raw: string): string | null {
  let s = raw.trim();
  // Een tijdstempel achter de padnaam (POSIX diff) knippen we eraf.
  const tab = s.indexOf("\t");
  if (tab !== -1) s = s.slice(0, tab);
  if (s === "/dev/null") return null;
  if (s.startsWith('"') && s.endsWith('"')) s = unquote(s);
  if (s.startsWith("a/") || s.startsWith("b/")) return s.slice(2);
  return s;
}

/**
 * `diff --git a/x b/y` is ambigu bij paden met spaties. Dit is een fallback:
 * de ---/+++ regels en rename from/to zijn leidend en overschrijven dit later.
 */
function parseGitHeaderPaths(rest: string): { old: string | null; new: string | null } {
  const trimmed = rest.trim();

  // Meest voorkomende geval: geen spaties, of beide kanten identiek.
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== " ") continue;
    const left = trimmed.slice(0, i);
    const right = trimmed.slice(i + 1);
    if (!left.startsWith("a/") || !right.startsWith("b/")) continue;
    if (left.slice(2) === right.slice(2)) {
      return { old: left.slice(2), new: right.slice(2) };
    }
  }
  // Geen identieke helften: pak de eerste geldige splitsing.
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== " ") continue;
    const left = trimmed.slice(0, i);
    const right = trimmed.slice(i + 1);
    if (left.startsWith("a/") && right.startsWith("b/")) {
      return { old: left.slice(2), new: right.slice(2) };
    }
  }
  return { old: null, new: null };
}

/** Git-stijl C-quoting terugdraaien, voor het geval quotePath toch aanstaat. */
function unquote(s: string): string {
  const body = s.slice(1, -1);
  let out = "";
  const bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length > 0) {
      out += Buffer.from(bytes).toString("utf8");
      bytes.length = 0;
    }
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      flush();
      out += ch;
      continue;
    }
    const next = body[i + 1] as string | undefined;
    if (next === undefined) break;
    i++;
    switch (next) {
      case "n":
        flush();
        out += "\n";
        break;
      case "t":
        flush();
        out += "\t";
        break;
      case "r":
        flush();
        out += "\r";
        break;
      case '"':
      case "\\":
        flush();
        out += next;
        break;
      default: {
        // Octale byte-escape: \303\251 → é
        const oct = body.slice(i, i + 3);
        if (/^[0-7]{3}$/.test(oct)) {
          bytes.push(Number.parseInt(oct, 8));
          i += 2;
        } else {
          flush();
          out += next;
        }
      }
    }
  }
  flush();
  return out;
}
