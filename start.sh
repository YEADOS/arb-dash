#!/bin/sh
# Start the control panel, replacing any instance already on the port.
set -e
cd "$(dirname "$0")"
PORT="${ARBITER_DASH_PORT:-7777}"
pid=$(lsof -ti "TCP:$PORT" -sTCP:LISTEN 2>/dev/null || true)
[ -n "$pid" ] && kill "$pid" 2>/dev/null && sleep 1
exec node server.js
