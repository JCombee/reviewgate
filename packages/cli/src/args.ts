import type { ReviewScope } from "@reviewgate/core";

export interface OpenArgs {
  scope: ReviewScope;
  range: string | null;
  json: boolean;
  context: number;
  includeUntracked: boolean;
  cwd: string;
}

export class UsageError extends Error {}

/**
 * Eigen argumentparser: het oppervlak is klein en `node:util.parseArgs` kent geen
 * positionele revisie-expressie zoals `main...HEAD`. Geen dependency nodig.
 */
export function parseOpenArgs(argv: readonly string[], cwd: string): OpenArgs {
  const out: OpenArgs = {
    scope: "staged",
    range: null,
    json: false,
    context: 5,
    includeUntracked: true,
    cwd,
  };
  let scopeSet = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "--staged":
      case "--cached":
        out.scope = "staged";
        scopeSet = true;
        break;
      case "--working":
        out.scope = "working";
        scopeSet = true;
        break;
      case "--amend":
        out.scope = "amend";
        scopeSet = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--no-untracked":
        out.includeUntracked = false;
        break;
      case "-U":
      case "--context": {
        const v = argv[++i];
        if (v === undefined) throw new UsageError(`${a} verwacht een aantal regels`);
        const n = Number.parseInt(v, 10);
        if (Number.isNaN(n) || n < 0) throw new UsageError(`ongeldige context: ${v}`);
        out.context = n;
        break;
      }
      case "-C":
      case "--cwd": {
        const v = argv[++i];
        if (v === undefined) throw new UsageError(`${a} verwacht een pad`);
        out.cwd = v;
        break;
      }
      default: {
        if (a.startsWith("-")) throw new UsageError(`onbekende optie: ${a}`);
        if (out.range !== null) throw new UsageError(`meerdere revisies opgegeven: ${a}`);
        out.range = a;
        out.scope = "range";
        scopeSet = true;
        break;
      }
    }
  }

  if (out.scope === "range" && out.range === null) {
    throw new UsageError('scope "range" zonder revisie-expressie');
  }
  if (!scopeSet) out.scope = "staged";
  return out;
}
