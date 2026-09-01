/**
 * Getypeerde diffstructuur. Dit is het contract tussen core, server en web:
 * de parser produceert het, de UI rendert het, anchoring werkt erop (§5).
 *
 * Alle paden zijn POSIX (forward slashes), zoals git ze aanlevert. Converteren naar
 * een platformpad gebeurt alleen op het moment van echt filesystem-contact (§4).
 */

/** Welke verzameling wijzigingen onder review staat (§2). */
export type ReviewScope = "staged" | "working" | "amend" | "range";

export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  /** Regelinhoud zonder het +/-/spatie-markerteken. */
  content: string;
  /** Regelnummer in de oude versie, null voor toegevoegde regels. */
  oldLine: number | null;
  /** Regelnummer in de nieuwe versie, null voor verwijderde regels. */
  newLine: number | null;
  /** Git meldde "\ No newline at end of file" direct na deze regel. */
  noNewlineAtEof: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** De sectiecontext die git achter de tweede `@@` zet, bijv. een functienaam. */
  section: string;
  lines: DiffLine[];
}

export type FileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "mode_changed";

export interface DiffFile {
  /**
   * Het pad waaronder het bestand in de review bekend staat: het nieuwe pad,
   * of het oude pad als het bestand verwijderd is. Stabiele sleutel voor comments.
   */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  /** Git kon geen tekstuele diff maken; er zijn dus geen hunks (§12). */
  binary: boolean;
  /** Submodule-pointer in plaats van een gewoon bestand (§12). */
  submodule: boolean;
  /** Percentage bij rename/copy, anders null. */
  similarity: number | null;
  oldMode: string | null;
  newMode: string | null;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface Diff {
  scope: ReviewScope;
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** Som van alle + en − regels: de basis voor de suggestie-cap (§9). */
  changedLines: number;
}
