#!/bin/sh
# Statewave quickstart bootstrap (macOS / Linux).
#
# Gets a working Node 20+ runtime, then hands off to:
#     npx @statewavedev/connectors-cli quickstart
#
# Trust model: if a suitable Node is already on PATH it is used as-is and
# nothing is downloaded. Otherwise Node is fetched from the OFFICIAL nodejs.org
# distribution, its SHA-256 is verified against the published SHASUMS256.txt,
# and it is unpacked into a user-local prefix (no sudo, nothing outside $HOME).
# The install only happens after you consent (a prompt, or --yes for CI). We
# never claim Node is ready without first running `node --version` to confirm.
#
# Usage:
#     curl -fsSL https://raw.githubusercontent.com/smaramwbc/statewave-connectors/main/scripts/bootstrap.sh | sh
#     ./scripts/bootstrap.sh [--yes] [-- <args passed to quickstart>]
#
# Env:
#     STATEWAVE_HOME       install prefix root (default: $HOME/.statewave)
#     STATEWAVE_NODE_DIST  Node dist dir (default: https://nodejs.org/dist/latest-v22.x)
#     STATEWAVE_CLI_PKG    npm package to run (default: @statewavedev/connectors-cli@latest)
set -eu

MIN_NODE_MAJOR=20
NODE_DIST="${STATEWAVE_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}"
PREFIX="${STATEWAVE_HOME:-$HOME/.statewave}/node"
CLI_PKG="${STATEWAVE_CLI_PKG:-@statewavedev/connectors-cli@latest}"
ASSUME_YES=0

# --- pretty output (no color when not a tty) -------------------------------
if [ -t 1 ]; then B="$(printf '\033[1m')"; D="$(printf '\033[2m')"; Y="$(printf '\033[33m')"; R="$(printf '\033[31m')"; G="$(printf '\033[32m')"; Z="$(printf '\033[0m')"; else B=""; D=""; Y=""; R=""; G=""; Z=""; fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s\n' "${B}$*${Z}"; }
warn() { printf '%s\n' "${Y}!${Z} $*" >&2; }
die()  { printf '%s\n' "${R}✗${Z} $*" >&2; exit 1; }

# --- args ------------------------------------------------------------------
QS_ARGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || say "See script header for usage."
      exit 0 ;;
    --) shift; QS_ARGS="$*"; break ;;
    *)  die "unknown option: $1 (use --yes, or -- <quickstart args>)" ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

node_major() {
  # major version of the node binary in $1, or empty if it can't run
  _v="$("$1" --version 2>/dev/null || true)"   # e.g. v22.11.0
  _v="${_v#v}"; _v="${_v%%.*}"
  case "$_v" in (*[!0-9]*|"") printf '' ;; (*) printf '%s' "$_v" ;; esac
}

download() {
  # download url -> file; prefer curl, fall back to wget
  if have curl; then curl -fsSL "$1" -o "$2"
  elif have wget; then wget -qO "$2" "$1"
  else die "need curl or wget to download Node (or install Node 20+ yourself)"; fi
}

sha256_of() {
  if have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  elif have sha256sum; then sha256sum "$1" | awk '{print $1}'
  else printf ''; fi
}

# --- 1. reuse an existing good Node ----------------------------------------
NODE_BIN=""
if have node && [ "$(node_major node)" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  NODE_BIN="$(command -v node)"
  step "Node $(node --version) found on PATH — using it."
elif [ -x "$PREFIX/bin/node" ] && [ "$(node_major "$PREFIX/bin/node")" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  NODE_BIN="$PREFIX/bin/node"
  PATH="$PREFIX/bin:$PATH"; export PATH
  step "Node $("$NODE_BIN" --version) found in $PREFIX — using it."
fi

# --- 2. otherwise fetch Node from the official dist (consented) -------------
if [ -z "$NODE_BIN" ]; then
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Darwin) NODE_OS="darwin" ;;
    Linux)  NODE_OS="linux" ;;
    *) die "unsupported OS '$os' — install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org and re-run." ;;
  esac
  case "$arch" in
    x86_64|amd64)  NODE_ARCH="x64" ;;
    arm64|aarch64) NODE_ARCH="arm64" ;;
    armv7l)        NODE_ARCH="armv7l" ;;
    *) die "unsupported CPU '$arch' — install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org and re-run." ;;
  esac

  if have node; then warn "Node $(node --version) is older than the required v${MIN_NODE_MAJOR}."; fi
  say ""
  say "Node ${MIN_NODE_MAJOR}+ is required and was not found."
  say "  ${B}Source${Z}  ${NODE_DIST}  (official nodejs.org distribution)"
  say "  ${B}Install${Z} ${PREFIX}   (your home directory — no sudo, nothing system-wide)"
  say "  ${B}Verify${Z}  SHA-256 checked against the published SHASUMS256.txt"
  if [ "$ASSUME_YES" -ne 1 ]; then
    if [ -t 0 ]; then
      printf '%s' "Download and install Node there now? [Y/n] "
      read -r reply || reply=""
      case "$reply" in [Nn]*) die "Aborted. Install Node ${MIN_NODE_MAJOR}+ yourself, then re-run." ;; esac
    else
      die "Non-interactive shell: re-run with --yes to auto-install Node to ${PREFIX}, or install Node ${MIN_NODE_MAJOR}+ yourself."
    fi
  fi

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/statewave-node.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  step "Resolving latest Node from ${NODE_DIST} ..."
  download "${NODE_DIST}/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  pat=" node-v.*-${NODE_OS}-${NODE_ARCH}\.tar\.gz\$"
  line="$(grep -E "$pat" "$tmp/SHASUMS256.txt" | head -1 || true)"
  [ -n "$line" ] || die "no Node build for ${NODE_OS}-${NODE_ARCH} at ${NODE_DIST} — install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org."
  want_sha="$(printf '%s' "$line" | awk '{print $1}')"
  file="$(printf '%s' "$line" | awk '{print $NF}')"

  step "Downloading ${file} ..."
  download "${NODE_DIST}/${file}" "$tmp/$file"

  step "Verifying SHA-256 ..."
  got_sha="$(sha256_of "$tmp/$file")"
  [ -n "$got_sha" ] || die "no sha256 tool (shasum/sha256sum) available to verify the download."
  [ "$got_sha" = "$want_sha" ] || die "checksum mismatch for ${file} — refusing to install. expected ${want_sha}, got ${got_sha}."

  step "Unpacking to ${PREFIX} ..."
  tar -xzf "$tmp/$file" -C "$tmp"
  extracted="$tmp/${file%.tar.gz}"
  [ -x "$extracted/bin/node" ] || die "unexpected Node archive layout — ${extracted}/bin/node missing."
  mkdir -p "$(dirname "$PREFIX")"
  rm -rf "$PREFIX"
  mv "$extracted" "$PREFIX"

  NODE_BIN="$PREFIX/bin/node"
  PATH="$PREFIX/bin:$PATH"; export PATH

  # Verify it actually runs before claiming success.
  got_major="$(node_major "$NODE_BIN")"
  { [ -n "$got_major" ] && [ "$got_major" -ge "$MIN_NODE_MAJOR" ]; } 2>/dev/null \
    || die "Node was unpacked but '$NODE_BIN --version' did not report v${MIN_NODE_MAJOR}+."
  say "${G}✓${Z} Node $("$NODE_BIN" --version) installed in ${PREFIX} and verified."
  say "${D}  (add ${PREFIX}/bin to PATH to reuse it: export PATH=\"${PREFIX}/bin:\$PATH\")${Z}"
fi

# --- 3. hand off to quickstart ---------------------------------------------
have npx || die "npx not found next to node ($NODE_BIN) — your Node install looks incomplete."
say ""
step "Starting Statewave quickstart ..."
# shellcheck disable=SC2086  # intentional word-split of pass-through args
exec npx -y "$CLI_PKG" quickstart $QS_ARGS
