import type { FileStatus } from "@reviewgate/core/api";

const LABEL: Readonly<Record<FileStatus, string>> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
  copied: "C",
  mode_changed: "±",
};

const COLOR: Readonly<Record<FileStatus, string>> = {
  added: "var(--rg-status-added)",
  deleted: "var(--rg-status-deleted)",
  modified: "var(--rg-status-modified)",
  renamed: "var(--rg-status-renamed)",
  copied: "var(--rg-status-renamed)",
  mode_changed: "var(--rg-text-muted)",
};

const TITLE: Readonly<Record<FileStatus, string>> = {
  added: "toegevoegd",
  deleted: "verwijderd",
  modified: "gewijzigd",
  renamed: "hernoemd",
  copied: "gekopieerd",
  mode_changed: "modus gewijzigd",
};

export function StatusBadge({ status }: { status: FileStatus }) {
  return (
    <span
      className="rg-code w-4 shrink-0 text-center font-semibold"
      style={{ color: COLOR[status] }}
      title={TITLE[status]}
      aria-label={TITLE[status]}
    >
      {LABEL[status]}
    </span>
  );
}
