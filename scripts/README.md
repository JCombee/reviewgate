# Install scripts

One script per platform. Each does the same four things: clone or update the repo,
build it with npm, write `REVIEWGATE_CLI` into `~/.claude/settings.json`, and install
the plugin from the marketplace in this repo.

Running one again updates an existing install; nothing is duplicated.

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

## From a checkout

The scripts notice they are inside a clone and build that clone instead of fetching
one:

```bash
./scripts/install.sh          # macOS, Linux
```

```powershell
.\scripts\install.ps1         # Windows
```

## Options

| Variable | Parameter | Does |
| --- | --- | --- |
| `REVIEWGATE_HOME` | `-InstallDir` | where the checkout lives (default `~/.reviewgate`) |
| `REVIEWGATE_REF` | `-Ref` | branch or tag to install (default `main`) |
| `REVIEWGATE_REPO` | `-RepoUrl` | clone from somewhere else, e.g. a fork |

To pass a parameter on Windows, download first rather than piping to `iex`:

```powershell
irm https://raw.githubusercontent.com/JCombee/reviewgate/main/scripts/install.ps1 -OutFile install.ps1
.\install.ps1 -InstallDir D:\tools\reviewgate
```

## Requirements

Node.js 20 or newer, npm and git. The script stops with a clear message if one of
them is missing.

## What it touches

| Path | Why |
| --- | --- |
| `~/.reviewgate` | the checkout and its build |
| `~/.claude/settings.json` | one key, `env.REVIEWGATE_CLI`; the old file is kept as `.reviewgate-backup` |
| the Claude Code plugin dir | the marketplace entry and the installed plugin |

`lib/set-env.mjs` does the settings edit for both platforms. A settings file that does
not parse is left untouched and printed instead: a bad install must not cost you your
configuration.
