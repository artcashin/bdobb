#!/bin/sh
# Starts Libre Terminal with its own launcher (which supervises and restarts its services), then
# runs the guard in the foreground.
set -eu
cd /opt/libre-terminal

# A previous container's pid records mean nothing in this one.
rm -f local/run/*.json 2>/dev/null || true

# Optional API keys: mount a file at /run/libre/api_keys.env (see compose.yaml). The launcher applies
# it on start when it has changed.
if [ -s /run/libre/api_keys.env ]; then
  cp /run/libre/api_keys.env local/api_keys.env
  chmod 600 local/api_keys.env
fi

.venv-v5/bin/python scripts/launcher.py start --no-browser --no-wait
exec python /opt/guard/guard.py
