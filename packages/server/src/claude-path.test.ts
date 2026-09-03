import { describe, expect, it } from "vitest";
import { ClaudePathInvalid, resolveClaudePath, type ResolveDeps } from "./claude-path.js";

/** A machine with nothing on it, which each test furnishes as it needs. */
function deps(overrides: Partial<ResolveDeps> = {}): Partial<ResolveDeps> {
  return {
    platform: "linux",
    arch: "x64",
    env: {},
    home: "/home/dev",
    exists: () => false,
    resolveModule: (specifier) => {
      throw new Error(`cannot find ${specifier}`);
    },
    preferMusl: () => false,
    ...overrides,
  };
}

/** Only these paths exist. */
function only(...paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

describe("resolveClaudePath", () => {
  it("takes the override before anything else", () => {
    const found = resolveClaudePath(
      deps({
        env: { REVIEWGATE_CLAUDE_PATH: "/opt/claude", PATH: "/usr/bin" },
        exists: only("/opt/claude", "/usr/bin/claude"),
      }),
    );
    expect(found).toBe("/opt/claude");
  });

  it("refuses an override that points at nothing", () => {
    expect(() =>
      resolveClaudePath(deps({ env: { REVIEWGATE_CLAUDE_PATH: "/nope" } })),
    ).toThrow(ClaudePathInvalid);
  });

  it("ignores an empty override", () => {
    const found = resolveClaudePath(
      deps({
        env: { REVIEWGATE_CLAUDE_PATH: "  ", PATH: "/usr/bin" },
        exists: only("/usr/bin/claude"),
      }),
    );
    expect(found).toBe("/usr/bin/claude");
  });

  it("uses the SDK's own package when it is installed", () => {
    const found = resolveClaudePath(
      deps({
        resolveModule: (specifier) =>
          specifier === "@anthropic-ai/claude-agent-sdk-linux-x64/claude"
            ? "/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"
            : (() => {
                throw new Error("not installed");
              })(),
        exists: only("/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"),
      }),
    );
    expect(found).toBe("/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude");
  });

  it("prefers the musl package on a musl Linux", () => {
    const asked: string[] = [];
    resolveClaudePath(
      deps({
        preferMusl: () => true,
        resolveModule: (specifier) => {
          asked.push(specifier);
          throw new Error("not installed");
        },
      }),
    );
    expect(asked).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
      "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    ]);
  });

  it("falls back to the PATH when the package is not there", () => {
    const found = resolveClaudePath(
      deps({
        env: { PATH: "/usr/bin:/home/dev/bin" },
        exists: only("/home/dev/bin/claude"),
      }),
    );
    expect(found).toBe("/home/dev/bin/claude");
  });

  it("honours PATHEXT on Windows", () => {
    const found = resolveClaudePath(
      deps({
        platform: "win32",
        home: "C:\\Users\\dev",
        env: { PATH: "C:\\bin", PATHEXT: ".COM;.EXE;.CMD" },
        exists: only("C:\\bin\\claude.CMD"),
      }),
    );
    expect(found).toBe("C:\\bin\\claude.CMD");
  });

  it("looks in the native installer directories last", () => {
    const found = resolveClaudePath(
      deps({ env: { PATH: "/usr/bin" }, exists: only("/home/dev/.local/bin/claude") }),
    );
    expect(found).toBe("/home/dev/.local/bin/claude");
  });

  it("also knows the older ~/.claude/local location", () => {
    const found = resolveClaudePath(deps({ exists: only("/home/dev/.claude/local/claude") }));
    expect(found).toBe("/home/dev/.claude/local/claude");
  });

  it("returns null when the machine has no claude at all", () => {
    expect(resolveClaudePath(deps({ env: { PATH: "/usr/bin" } }))).toBeNull();
  });
});
