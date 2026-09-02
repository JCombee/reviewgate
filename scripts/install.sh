#!/usr/bin/env bash
#
# ReviewGate installer for macOS and Linux.
#
# Downloads one self-contained binary from the newest GitHub release, checks its
# SHA-256 and drops it in ~/.local/bin. No Node, no npm, no checkout. Run it again to
# update; `reviewgate update` does the same thing from inside the binary.
#
#   curl -fsSL https://raw.githubusercontent.com/JCombee/reviewgate/main/scripts/install.sh | bash
#
# Options:
#   --version <tag>   install exactly this tag instead of the newest release
#   --dir <path>      install somewhere other than ~/.local/bin
#   --no-plugin       do not touch Claude Code; only place the binary
set -euo pipefail

REPO="${REVIEWGATE_REPO:-JCombee/reviewgate}"
INSTALL_DIR="${REVIEWGATE_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${REVIEWGATE_VERSION:-latest}"
WITH_PLUGIN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --no-plugin) WITH_PLUGIN=0; shift ;;
    -h|--help) sed -n '3,17p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl not found."

# --- which binary ------------------------------------------------------------

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) die "unsupported platform $(uname -s). Windows has scripts/install.ps1." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) die "unsupported architecture $(uname -m)." ;;
esac
asset="reviewgate-${os}-${arch}"

# --- which release -----------------------------------------------------------
#
# api.github.com allows 60 anonymous requests an hour per IP, which shared egress
# blows through quickly. Use a token when one is around; fall back to anonymous when
# the token turns out to be stale.

auth=()
if [ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
  auth=(-H "Authorization: Bearer ${GITHUB_TOKEN:-${GH_TOKEN}}")
elif command -v gh >/dev/null 2>&1; then
  if token="$(gh auth token --hostname github.com 2>/dev/null)" && [ -n "$token" ]; then
    auth=(-H "Authorization: Bearer ${token}")
  fi
fi

if [ "$VERSION" = "latest" ]; then
  say "Looking up the newest release"
  api="https://api.github.com/repos/${REPO}/releases/latest"
  body="$(curl -sSL -w '\n%{http_code}' "${auth[@]}" "$api" 2>/dev/null || true)"
  code="${body##*$'\n'}"
  if [ "$code" = "401" ] && [ ${#auth[@]} -gt 0 ]; then
    body="$(curl -sSL -w '\n%{http_code}' "$api" 2>/dev/null || true)"
    code="${body##*$'\n'}"
  fi
  [ "$code" = "200" ] || die "could not read the releases of ${REPO} (HTTP ${code:-none})."
  tag="$(printf '%s' "$body" | grep '"tag_name"' | head -n1 | cut -d'"' -f4)"
  [ -n "$tag" ] || die "${REPO} has no releases yet."
else
  case "$VERSION" in v*) tag="$VERSION" ;; *) tag="v$VERSION" ;; esac
fi
unset auth token

# --- download and verify -----------------------------------------------------

url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
tmp="$(mktemp -t reviewgate.XXXXXX)"
trap 'rm -f "$tmp" "$tmp.sha"' EXIT

say "Downloading ${asset} ${tag}"
curl -fsSL -o "$tmp" "$url" || die "${tag} has no ${asset}."
curl -fsSL -o "$tmp.sha" "${url}.sha256" || die "no checksum published for ${asset}."

expected="$(cut -d' ' -f1 < "$tmp.sha")"
if [ "$os" = "darwin" ]; then
  actual="$(shasum -a 256 "$tmp" | cut -d' ' -f1)"
else
  actual="$(sha256sum "$tmp" | cut -d' ' -f1)"
fi
[ "$actual" = "$expected" ] || die "checksum mismatch — refusing to install."

mkdir -p "$INSTALL_DIR"
chmod +x "$tmp"
mv -f "$tmp" "$INSTALL_DIR/reviewgate"
trap - EXIT
rm -f "$tmp.sha"
say "reviewgate ${tag} installed at ${INSTALL_DIR}/reviewgate"

# --- PATH --------------------------------------------------------------------
#
# The plugin runs `reviewgate hook`, so the gate only works when the shell that
# Claude Code starts can find it.

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    warn "$INSTALL_DIR is not on your PATH."
    echo "  Add this to your shell profile and open a new terminal:"
    echo ""
    echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    ;;
esac

# --- the Claude Code plugin --------------------------------------------------

if [ "$WITH_PLUGIN" -eq 1 ]; then
  if command -v claude >/dev/null 2>&1; then
    say "Installing the Claude Code plugin"
    # `add` fails when the marketplace is already there, which an update fixes. Both
    # keep their output: a clone that fails on the network reads as a mystery
    # otherwise, and that is exactly the case worth seeing.
    if ! claude plugin marketplace add "$REPO"; then
      claude plugin marketplace update reviewgate || true
    fi
    if ! claude plugin install reviewgate@reviewgate; then
      warn "could not install the plugin. Run this inside Claude Code:"
      echo "  /plugin marketplace add ${REPO}"
      echo "  /plugin install reviewgate@reviewgate"
    fi
  else
    cat <<MSG

The 'claude' CLI is not on your PATH. Run these inside Claude Code instead:

  /plugin marketplace add ${REPO}
  /plugin install reviewgate@reviewgate
MSG
  fi
fi

cat <<MSG

Done. Restart Claude Code so the gate picks up the hook.

  reviewgate --version    what you have
  reviewgate update       pull in the next release
MSG
