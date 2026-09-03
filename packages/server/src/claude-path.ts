import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { createRequire } from "node:module";

/**
 * Where the reviewer assistant's `claude` executable lives.
 *
 * The Agent SDK normally resolves its own native CLI through the per-platform
 * package next to it in `node_modules`. The released ReviewGate is a single-file
 * binary: there is no `node_modules` beside it, so that lookup fails and the chat
 * panel dies with "Native CLI binary for linux-x64 not found". We therefore find the
 * `claude` that is already on the machine ourselves and hand it to the SDK.
 */

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export interface ResolveDeps {
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  home: string;
  /** Whether a path points at an existing file. */
  exists: (path: string) => boolean;
  /** `require.resolve`, so the npm install keeps working exactly as before. */
  resolveModule: (specifier: string) => string;
  /** Whether this Linux is musl rather than glibc. */
  preferMusl: () => boolean;
}

export class ClaudePathInvalid extends Error {
  constructor(path: string) {
    super(
      `REVIEWGATE_CLAUDE_PATH points at ${path}, but there is no executable there.`,
    );
    this.name = "ClaudePathInvalid";
  }
}

/**
 * The path to `claude`, or `null` when this machine has none. Memoised: the answer
 * cannot change while the gate is open, and the search touches the filesystem.
 */
let cached: string | null | undefined;

export function resolveClaudePath(deps: Partial<ResolveDeps> = {}): string | null {
  const injected = Object.keys(deps).length > 0;
  if (!injected && cached !== undefined) return cached;

  const found = search({ ...defaults(), ...deps });
  if (!injected) cached = found;
  return found;
}

/** For the tests: forget what an earlier call found. */
export function resetClaudePathCache(): void {
  cached = undefined;
}

function defaults(): ResolveDeps {
  const require = createRequire(import.meta.url);
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    home: homedir(),
    exists: isFile,
    resolveModule: (specifier) => require.resolve(specifier),
    preferMusl: musl,
  };
}

function search(deps: ResolveDeps): string | null {
  const override = deps.env["REVIEWGATE_CLAUDE_PATH"]?.trim();
  if (override) {
    // A typo here should not fall through to some other `claude`: whoever sets this
    // wants that one executable and nothing else.
    if (!deps.exists(override)) throw new ClaudePathInvalid(override);
    return override;
  }

  return fromSdkPackage(deps) ?? fromPath(deps) ?? fromInstallDirs(deps);
}

/**
 * The SDK's own per-platform package. Present in a checkout and in an npm install,
 * absent in the compiled binary.
 */
function fromSdkPackage(deps: ResolveDeps): string | null {
  const suffix = deps.platform === "win32" ? ".exe" : "";
  for (const pkg of sdkPackages(deps)) {
    try {
      const resolved = deps.resolveModule(`${pkg}/claude${suffix}`);
      if (deps.exists(resolved)) return resolved;
    } catch {
      // Not installed for this platform; try the next candidate.
    }
  }
  return null;
}

/** Mirrors the SDK's own candidate order, musl before glibc where that applies. */
function sdkPackages(deps: ResolveDeps): string[] {
  if (deps.platform === "android") return [`${SDK_PACKAGE}-linux-${deps.arch}-android`];
  if (deps.platform !== "linux") return [`${SDK_PACKAGE}-${deps.platform}-${deps.arch}`];
  const glibc = `${SDK_PACKAGE}-linux-${deps.arch}`;
  const musl = `${glibc}-musl`;
  return deps.preferMusl() ? [musl, glibc] : [glibc, musl];
}

/**
 * `claude` on the PATH. Walked by hand rather than through `which`/`where`: no child
 * process, and the same code on every platform.
 */
function fromPath(deps: ResolveDeps): string | null {
  const path = deps.env["PATH"] ?? deps.env["Path"];
  if (!path) return null;

  const windows = deps.platform === "win32";
  const extensions = windows
    ? (deps.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")
    : [""];

  for (const dir of path.split(windows ? ";" : ":")) {
    if (dir === "") continue;
    for (const ext of extensions) {
      const candidate = pathFor(deps).join(dir, `claude${ext}`);
      if (deps.exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Where the native installer puts `claude` when it is not on the PATH. */
function fromInstallDirs(deps: ResolveDeps): string | null {
  const { join } = pathFor(deps);
  const candidates =
    deps.platform === "win32"
      ? [
          join(
            deps.env["LOCALAPPDATA"] ?? join(deps.home, "AppData", "Local"),
            "Programs",
            "claude",
            "claude.exe",
          ),
          join(deps.home, ".local", "bin", "claude.exe"),
        ]
      : [join(deps.home, ".local", "bin", "claude"), join(deps.home, ".claude", "local", "claude")];

  return candidates.find((c) => deps.exists(c)) ?? null;
}

/**
 * Paths are joined for the *target* platform, not for the one the tests happen to run
 * on: a Windows machine still has to build Linux paths correctly here.
 */
function pathFor(deps: ResolveDeps): typeof posix {
  return deps.platform === "win32" ? win32 : posix;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A musl Linux reports no glibc runtime version. Same check the SDK makes, so we pick
 * the same package it would have picked.
 */
function musl(): boolean {
  if (process.platform !== "linux") return false;
  const report = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
  const header = (report as { header?: { glibcVersionRuntime?: string } } | null)?.header;
  return report !== null && header?.glibcVersionRuntime === undefined;
}
