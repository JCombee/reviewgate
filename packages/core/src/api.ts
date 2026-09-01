/**
 * De DTO's die server en web delen. Bewust een eigen entrypoint (`@reviewgate/core/api`):
 * de web-bundel mag niets van de node-kant van core meenemen.
 */
import type { IntralinePair } from "./diff/intraline.js";
import type { DiffFile, FileStatus, ReviewScope } from "./types.js";

export interface RepoSummary {
  root: string;
  branch: string | null;
}

export interface FileSummary {
  /** Positie in de reviewvolgorde; tevens de sleutel voor het detail-endpoint. */
  index: number;
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  submodule: boolean;
  similarity: number | null;
  additions: number;
  deletions: number;
  hunkCount: number;
}

export interface ReviewSummary {
  id: string;
  scope: ReviewScope;
  repo: RepoSummary;
  createdAt: string;
  files: FileSummary[];
  additions: number;
  deletions: number;
  changedLines: number;
}

/**
 * Eén gekleurd stukje tekst: de tekst plus een index in het palet van het bestand.
 * Een bestand gebruikt maar een handvol kleuren, dus de index scheelt bij grote
 * bestanden makkelijk de helft van de payload ten opzichte van kleuren per token.
 */
export interface HighlightToken {
  t: string;
  c: number;
}

/** Tokens van één regel. Index in de array = regelnummer − 1. */
export type HighlightLine = HighlightToken[];

/** Kleurenpaar [licht, donker] waar `HighlightToken.c` naar verwijst. */
export type PaletteEntry = readonly [light: string, dark: string];

export interface FileHighlight {
  /** Tokens van de oude kant, of null als die kant niet bestaat of te groot is. */
  old: HighlightLine[] | null;
  new: HighlightLine[] | null;
  /** Gedeeld door beide kanten van dit bestand. */
  palette: PaletteEntry[];
  /** Taal die shiki gebruikt heeft; "text" bij onbekend of overgeslagen. */
  lang: string;
  /** Highlighting overgeslagen omdat het bestand te groot is (§12). */
  skipped: boolean;
}

export interface FileDetail {
  index: number;
  file: DiffFile;
  /** Per hunk de gekoppelde regels met hun verschilstukken; zelfde volgorde als `file.hunks`. */
  intraline: IntralinePair[][];
  highlight: FileHighlight;
  /** Aantal regels aan elke kant, zodat de UI weet hoever context-expansie kan gaan. */
  oldLineCount: number;
  newLineCount: number;
}

export interface ApiError {
  error: string;
}

export type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffLineType,
  FileStatus,
  ReviewScope,
} from "./types.js";
export type { IntralinePair, IntralineSegment } from "./diff/intraline.js";
