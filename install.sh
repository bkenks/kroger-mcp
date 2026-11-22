#!/usr/bin/env bash
# Installs (or updates) the Kroger MCP server and builds it.
#
#   curl -fsSL https://raw.githubusercontent.com/bkenks/kroger-mcp/main/install.sh | bash
#
# Environment overrides:
#   KROGER_MCP_HOME   install directory (default: ~/.local/share/kroger-mcp)
#   KROGER_MCP_REPO   git URL to install from (default: the GitHub repo)
#   KROGER_MCP_REF    branch or tag to install (default: main)
set -euo pipefail

REPO="${KROGER_MCP_REPO:-https://github.com/bkenks/kroger-mcp.git}"
REF="${KROGER_MCP_REF:-main}"
DIR="${KROGER_MCP_HOME:-$HOME/.local/share/kroger-mcp}"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git is required."
command -v node >/dev/null || die "Node.js 22 or newer is required (https://nodejs.org)."
command -v npm >/dev/null || die "npm is required (it ships with Node.js)."
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' ||
  die "Node.js 22 or newer is required; found $(node --version)."

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR ..."
  git -C "$DIR" fetch --quiet --depth 1 origin "$REF"
  git -C "$DIR" checkout --quiet --force FETCH_HEAD
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and isn't a kroger-mcp checkout; set KROGER_MCP_HOME to another directory."
else
  say "Installing to $DIR ..."
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DIR"
fi

cd "$DIR"
say "Installing dependencies and building ..."
# Lifecycle scripts aren't needed to build (TypeScript only), so skip them.
npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
npm run --silent build
npm prune --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error

NODE_BIN="$(node -p 'process.execPath')"
ENTRY="$DIR/dist/index.js"
cat <<MSG

Kroger MCP server installed.

Next steps:
  1. Add your Kroger API credentials and log in (run this in your terminal):
       "$NODE_BIN" "$ENTRY" setup
  2. Register it with your AI app as a stdio MCP server:
       command: $NODE_BIN
       args:    $ENTRY
     e.g. Claude Code:  claude mcp add --scope user kroger -- "$NODE_BIN" "$ENTRY"
  3. Check everything:  "$NODE_BIN" "$ENTRY" status

KROGER_MCP_ENTRY=$ENTRY
KROGER_MCP_NODE=$NODE_BIN
MSG
