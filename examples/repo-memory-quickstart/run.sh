#!/usr/bin/env bash
# Repo-memory quickstart for Statewave Connectors.
#
# Walks through:
#   1. doctor              — environment diagnostics
#   2. markdown dry-run    — local sample-docs/ folder
#   3. github dry-run      — public repo (no auth required)
#   4. mcp --list-tools    — print the MCP tool surface
#
# Honest defaults: this script never ingests. It runs everything dry-run-only.
# Set STATEWAVE_URL and re-run with INGEST=1 to send the markdown episodes
# to a running Statewave instance.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="node ${REPO_ROOT}/packages/cli/dist/index.js"
SAMPLE_DOCS="$(cd "$(dirname "$0")/sample-docs" && pwd)"
SUBJECT="${SUBJECT:-repo:smaramwbc/statewave-connectors}"
GH_REPO="${GH_REPO:-smaramwbc/statewave-connectors}"

if [ ! -d "${REPO_ROOT}/packages/cli/dist" ]; then
  echo "==> Building the workspace (one-time)"
  (cd "$REPO_ROOT" && pnpm install --frozen-lockfile=false >/dev/null && pnpm build >/dev/null)
fi

echo "==> 1. doctor"
$CLI doctor || true
echo

echo "==> 2. markdown dry-run on sample-docs/"
$CLI sync markdown \
  --path "$SAMPLE_DOCS" \
  --subject "$SUBJECT" \
  --dry-run
echo

echo "==> 3. github dry-run on $GH_REPO (skipped if you're offline)"
if $CLI sync github \
     --repo "$GH_REPO" \
     --subject "$SUBJECT" \
     --include releases \
     --max-items 5 \
     --dry-run 2>/tmp/sw-gh.err; then
  :
else
  echo "  (GitHub dry-run failed — likely offline or rate-limited)"
  cat /tmp/sw-gh.err
fi
echo

echo "==> 4. MCP tool surface"
if [ -n "${STATEWAVE_URL:-}" ]; then
  $CLI mcp start --list-tools | head -40
else
  echo "  STATEWAVE_URL not set — skipping mcp tool listing."
  echo "  Run \`STATEWAVE_URL=http://localhost:8000 $0\` to print the tool surface."
fi
echo

if [ "${INGEST:-0}" = "1" ]; then
  if [ -z "${STATEWAVE_URL:-}" ]; then
    echo "INGEST=1 requires STATEWAVE_URL to be set. Aborting." >&2
    exit 2
  fi
  echo "==> INGEST=1 — sending sample-docs/ episodes to $STATEWAVE_URL"
  $CLI sync markdown \
    --path "$SAMPLE_DOCS" \
    --subject "$SUBJECT"
fi

echo "Done. See README.md for the next-step prompts."
