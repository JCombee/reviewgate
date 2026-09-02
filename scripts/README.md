# Install scripts

One script per platform. Both do the same four things: resolve the newest GitHub
release, download the binary for this platform, verify its SHA-256, and install the
Claude Code plugin. Running one again updates an existing install — the same thing
`reviewgate update` does from inside the binary.

Nothing is compiled and nothing is cloned: the binary carries the server, the CLI and
the web UI. Node, npm and git are not needed.

## One-liners

**macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/JCombee/reviewgate/main/scripts/install.sh | bash
```

**Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/JCombee/reviewgate/main/scripts/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/JCombee/reviewgate/main/scripts/install.ps1 | iex
```

## Options

| Flag | PowerShell | Does |
| --- | --- | --- |
| `--version <tag>` | `-Version <tag>` | install exactly this tag instead of the newest release |
| `--dir <path>` | `-InstallDir <path>` | install somewhere other than the default |
| `--no-plugin` | `-NoPlugin` | only place the binary, leave Claude Code alone |

The same three as environment variables: `REVIEWGATE_VERSION`,
`REVIEWGATE_INSTALL_DIR`, `REVIEWGATE_REPO` (to install from a fork).

To pass a flag on Windows, download first rather than piping to `iex`:

```powershell
irm https://raw.githubusercontent.com/JCombee/reviewgate/main/scripts/install.ps1 -OutFile install.ps1
.\install.ps1 -Version v0.2.0
```

## What it touches

| Path | Why |
| --- | --- |
| `~/.local/bin/reviewgate` | the binary (macOS, Linux) |
| `%LOCALAPPDATA%\Programs\reviewgate\reviewgate.exe` | the binary (Windows) |
| your user PATH | Windows only, and only when the install dir is not on it yet |
| the Claude Code plugin dir | the marketplace entry and the installed plugin |

On macOS and Linux the script never edits a shell profile: if `~/.local/bin` is not on
your PATH it prints the line to add and leaves the choice to you.

The plugin runs `reviewgate hook`, so the gate works as soon as the binary is on the
PATH of the shell Claude Code starts — whether that binary came from a release or from
`npm link` in a checkout.

## Rate limits

Resolving "newest release" hits `api.github.com`, which allows 60 anonymous requests
an hour per IP. Both scripts use `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` when
one is around, and fall back to an anonymous request when the token turns out to be
stale.

## The other scripts

| Script | Does |
| --- | --- |
| `embed-web.mjs` | inlines `packages/web/dist` into the server, so a binary carries the UI |
| `build-binaries.mjs` | compiles the per-platform binaries with `bun build --compile` |
