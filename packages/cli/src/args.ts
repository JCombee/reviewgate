import type { ReviewScope } from "@reviewgate/core";

export interface OpenArgs {
  scope: ReviewScope;
  range: string | null;
  json: boolean;
  context: number;
  includeUntracked: boolean;
  cwd: string;
  /** Do not open the browser; the URL then only appears in the terminal. */
  noOpen: boolean;
  /** A fixed port instead of an ephemeral one; handy during development. */
  port: number | null;
}

export class UsageError extends Error {}

/**
 * A hand-written argument parser: the surface is small and `node:util.parseArgs` has
 * no notion of a positional revision expression like `main...HEAD`. No dependency
 * needed.
 */
export function parseOpenArgs(argv: readonly string[], cwd: string): OpenArgs {
  const out: OpenArgs = {
    scope: "staged",
    range: null,
    json: false,
    context: 5,
    includeUntracked: true,
    cwd,
    noOpen: false,
    port: null,
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
      case "--no-open":
        out.noOpen = true;
        break;
      case "--port": {
        const v = argv[++i];
        if (v === undefined) throw new UsageError("--port expects a port number");
        const n = Number.parseInt(v, 10);
        if (Number.isNaN(n) || n < 0 || n > 65535) throw new UsageError(`invalid port: ${v}`);
        out.port = n;
        break;
      }
      case "-U":
      case "--context": {
        const v = argv[++i];
        if (v === undefined) throw new UsageError(`${a} expects a number of lines`);
        const n = Number.parseInt(v, 10);
        if (Number.isNaN(n) || n < 0) throw new UsageError(`invalid context: ${v}`);
        out.context = n;
        break;
      }
      case "-C":
      case "--cwd": {
        const v = argv[++i];
        if (v === undefined) throw new UsageError(`${a} expects a path`);
        out.cwd = v;
        break;
      }
      default: {
        if (a.startsWith("-")) throw new UsageError(`unknown option: ${a}`);
        if (out.range !== null) throw new UsageError(`several revisions given: ${a}`);
        out.range = a;
        out.scope = "range";
        scopeSet = true;
        break;
      }
    }
  }

  if (out.scope === "range" && out.range === null) {
    throw new UsageError('scope "range" without a revision expression');
  }
  if (!scopeSet) out.scope = "staged";
  return out;
}
