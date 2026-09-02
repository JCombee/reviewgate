#!/usr/bin/env bash
#
# ReviewGate installer for macOS and Linux.
#
# Clones (or updates) the repo, builds it with npm, registers the marketplace and
# installs the plugin. Safe to run again: it updates in place.
#
#   curl -fsSL https://raw.githubusercontent.com/JCombee/reviewgate/main/scripts/install.sh | bash
#
# Environment:
#   REVIEWGATE_HOME  where to keep the checkout (default ~/.reviewgate)
#   REVIEWGATE_REF   branch or tag to install (default main)
set -euo pipefail

REPO_URL="${REVIEWGATE_REPO:-https://github.com/JCombee/reviewgate.git}"
REF="${REVIEWGATE_REF:-main}"
HOME_DIR="${REVIEWGATE_HOME:-$HOME/.reviewgate}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- requirements ------------------------------------------------------------

command -v git >/dev/null 2>&1 || die "git not found. Install git and run again."
command -v node >/dev/null 2>&1 || die "node not found. Install Node.js 20 or newer: https://nodejs.org"
command -v npm >/dev/null 2>&1 || die "npm not found. It ships with Node.js: https://nodejs.org"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or newer required, found $(node -v)."

# --- the checkout ------------------------------------------------------------
#
# Running from inside a clone uses that clone; piped from curl there is no script
# path, so fall back to REVIEWGATE_HOME.

SRC_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$SCRIPT_DIR/../package.json" ] && grep -q '"reviewgate-monorepo"' "$SCRIPT_DIR/../package.json"; then
    SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  fi
fi

if [ -z "$SRC_DIR" ]; then
  if [ -d "$HOME_DIR/.git" ]; then
    say "Updating $HOME_DIR"
    git -C "$HOME_DIR" fetch --depth 1 origin "$REF"
    git -C "$HOME_DIR" checkout -q FETCH_HEAD
  else
    say "Cloning into $HOME_DIR"
    rm -rf "$HOME_DIR"
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$HOME_DIR"
  fi
  SRC_DIR="$HOME_DIR"
else
  say "Using the checkout at $SRC_DIR"
fi

# --- build -------------------------------------------------------------------

say "Installing dependencies"
(cd "$SRC_DIR" && npm install --no-audit --no-fund)

say "Building"
(cd "$SRC_DIR" && npm run build)

CLI="$SRC_DIR/packages/cli/bin/reviewgate.mjs"
[ -f "$CLI" ] || die "Build finished but $CLI is missing."

say "Pointing Claude Code at the CLI"
node "$SRC_DIR/scripts/lib/set-env.mjs" "$CLI"

# --- the plugin --------------------------------------------------------------

if command -v claude >/dev/null 2>&1; then
  say "Registering the marketplace"
  claude plugin marketplace add "$SRC_DIR" || \
    claude plugin marketplace update reviewgate || true
  say "Installing the plugin"
  claude plugin install reviewgate@reviewgate
else
  cat <<MSG

The 'claude' CLI is not on your PATH, so the plugin was not installed. Run these two
inside Claude Code instead:

  /plugin marketplace add $SRC_DIR
  /plugin install reviewgate@reviewgate
MSG
fi

cat <<MSG

ReviewGate is installed.

  checkout : $SRC_DIR
  cli      : $CLI

Restart Claude Code so it picks up the hook. Optionally put the CLI on your PATH:

  npm link --workspace @reviewgate/cli   # from $SRC_DIR
MSG
