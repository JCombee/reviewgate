import { NodeGitClient, type Diff, type DiffFile } from "@reviewgate/core";
import { parseOpenArgs } from "../args.js";

export async function cmdOpen(argv: readonly string[], cwd: string): Promise<number> {
  const args = parseOpenArgs(argv, cwd);
  const git = await NodeGitClient.open(args.cwd);

  const diff = await git.diff(args.scope, {
    context: args.context,
    includeUntracked: args.includeUntracked,
    ...(args.range ? { range: args.range } : {}),
  });

  if (args.json) {
    const info = await git.info();
    process.stdout.write(
      `${JSON.stringify(
        {
          repo: { root: info.root, branch: info.branch, hasHead: info.hasHead },
          diff,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(renderSummary(diff));
  // De browser-UI komt in M1; tot dan is `open` een leescommando.
  process.stdout.write("\n(UI volgt in M1 — gebruik --json voor de volledige structuur)\n");
  return 0;
}

function renderSummary(diff: Diff): string {
  const lines: string[] = [];
  lines.push(
    `${diff.files.length} bestand(en) · +${diff.additions} −${diff.deletions} · scope: ${diff.scope}`,
  );
  for (const f of diff.files) lines.push(`  ${statusChar(f)} ${label(f)}${counts(f)}`);
  return lines.length > 1 ? `${lines.join("\n")}\n` : `${lines[0] as string}\n`;
}

function statusChar(f: DiffFile): string {
  switch (f.status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "mode_changed":
      return "M";
    default:
      return "M";
  }
}

function label(f: DiffFile): string {
  if (f.status === "renamed" || f.status === "copied") {
    return `${f.oldPath ?? "?"} → ${f.newPath ?? "?"}`;
  }
  return f.path;
}

function counts(f: DiffFile): string {
  if (f.binary) return "  (binair)";
  if (f.submodule) return "  (submodule)";
  return `  +${f.additions} −${f.deletions}`;
}
