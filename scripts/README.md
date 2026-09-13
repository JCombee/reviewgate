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

## Installing what you have checked out

`install-local.mjs` is the other direction: it compiles the working tree and puts it
over the reviewgate you already have, so the next commit meets the code in front of
you rather than the newest release.

```bash
npm run install:local
```

One script for every platform, and Node rather than a shell: whoever has a checkout has
Node, and a single file cannot drift between a `.sh` and a `.ps1` half the way a pair
does. It needs [bun](https://bun.sh) — the same compiler `build-binaries.mjs` uses.

Without arguments it replaces the binary your PATH resolves `reviewgate` to, and picks
the target to match: on WSL that is the Windows install under
`%LOCALAPPDATA%\Programs\reviewgate`, because bash never resolves `reviewgate.exe`
under that name but Windows still runs it. With nothing installed yet it falls back to
the directory the native installer uses.

| Flag | Does |
| --- | --- |
| `--dir <path>` | install somewhere else instead of over the current install |
| `--target <name>` | a specific bun target, e.g. `bun-windows-x64` |
| `--version <v>` | the version to stamp (default `<package version>-local.<sha>`) |
| `--wrapper` | install a launcher for this checkout instead of compiling |
| `--dry-run` | print the target, the version and the destination, then stop |

Pass them through npm with a `--` in between: `npm run install:local -- --dry-run`.

### When bun will not compile

A checkout on a Windows drive cannot be compiled from inside WSL: bun fails with
`EINVAL opening root directory "/mnt/d/..."`. Compile it from PowerShell, or skip the
compiler:

```bash
npm run install:local -- --wrapper
```

That builds the checkout and installs a three-line launcher that runs it, so `reviewgate`
is the code in your working tree from then on — rebuild and it is live, no reinstall.
It needs Node at run time, reports `0.0.0-dev` (a version is compiled in, and a source
run has none), and `reviewgate update` leaves it alone: it refuses to replace a build
from source.

It runs `npm run build` and stops there. The embed step is for binaries only: it fills
a file that is a stub on purpose, and a source build reads the UI from
`packages/web/dist` anyway.

The build carries a `-local.<sha>` version so `reviewgate --version` says which one you
are on. It counts as the released version it was built from, so `reviewgate update`
will replace it as soon as a newer release exists — a local install is a thing you redo,
not a thing you keep. The plugin is untouched: it runs `reviewgate hook` and does not
care where the binary came from.

## The other scripts

| Script | Does |
| --- | --- |
| `embed-web.mjs` | inlines `packages/web/dist` into the server, so a binary carries the UI |
| `build-binaries.mjs` | compiles the per-platform binaries with `bun build --compile` |
| `install-local.mjs` | compiles the working tree and installs it over your current one |
