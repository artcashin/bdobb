#!/usr/bin/env bash
#
# Runs OpenBB's own reference backend so BDOBB can be exercised against a
# real widgets.json without any private deployment.
#
# The reference backend is the spec's reference implementation: it serves ~70
# widgets covering most of the types and parameter patterns OpenBB Workspace
# supports. That makes it a neutral oracle — when BDOBB renders one of its
# widgets differently than the spec describes, the bug is BDOBB's, which is not
# a conclusion you can draw from testing against your own backend alone.
#
#   scripts/reference-backend.sh              # set up if needed, then run
#   PORT=8080 scripts/reference-backend.sh    # different port
#   REF_BACKEND_REF=<sha> scripts/…           # pin to a commit (see below)
#
# Requires: git, python3 (3.10+), and network access on first run.
#
# The checkout tracks OpenBB's main branch by default, so new widget types show
# up as they are added — and, equally, an upstream change can alter what the
# conformance suite sees. Set REF_BACKEND_REF to pin a commit when you want the
# environment frozen; CI should pin.
set -euo pipefail

REPO_URL="https://github.com/OpenBB-finance/backends-for-openbb.git"
PORT="${PORT:-7779}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKOUT="$ROOT/.reference-backend"
APP_DIR="$CHECKOUT/getting-started/reference-backend"

if [ ! -d "$CHECKOUT/.git" ]; then
  echo "[reference-backend] cloning $REPO_URL"
  if [ -n "${REF_BACKEND_REF:-}" ]; then
    git clone -q "$REPO_URL" "$CHECKOUT"
    git -C "$CHECKOUT" checkout -q "$REF_BACKEND_REF"
  else
    git clone -q --depth 1 "$REPO_URL" "$CHECKOUT"
  fi
fi

if [ ! -d "$APP_DIR" ]; then
  echo "[reference-backend] $APP_DIR is missing — upstream layout may have changed." >&2
  exit 1
fi

VENV="$APP_DIR/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "[reference-backend] creating virtualenv"
  python3 -m venv "$VENV"
  # Quiet, but not silent on failure: a broken install must not look like a
  # backend that simply refused to start later.
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$APP_DIR/requirements.txt"
fi

echo "[reference-backend] serving http://127.0.0.1:$PORT (widgets.json at /widgets.json)"
echo "[reference-backend] add it in BDOBB as a backend with that base URL, or set"
echo "[reference-backend]   VITE_OPENBB_API_URL=http://127.0.0.1:$PORT"
cd "$APP_DIR"
exec "$VENV/bin/uvicorn" main:app --host 127.0.0.1 --port "$PORT"
