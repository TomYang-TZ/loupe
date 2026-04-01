#!/bin/bash
# Loupe — restart the server and native app
set -e

LOUPE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.claude/logs"
LOG_FILE="$LOG_DIR/loupe.jsonl"
PID_FILE="$LOG_DIR/loupe.pid"
PORT=8390

echo "Restarting Loupe..."

# Kill native app
pkill -f "Loupe.app/Contents/MacOS/loupe" 2>/dev/null && echo "  Stopped native app" || true

# Kill server
if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null && echo "  Stopped server (pid $(cat "$PID_FILE"))" || true
    rm -f "$PID_FILE"
fi

# Also kill any orphaned server on the port
lsof -ti:"$PORT" 2>/dev/null | xargs kill 2>/dev/null || true

sleep 0.5

# Start server
touch "$LOG_FILE"
nohup node "$LOUPE_DIR/src/server/index.js" "$LOG_FILE" --json --port "$PORT" \
    > "$LOG_DIR/loupe-server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"
echo "  Started server (pid $SERVER_PID)"

sleep 0.5

# Launch native app
APP_BUNDLE="$LOUPE_DIR/Loupe.app"
if [ -d "$APP_BUNDLE" ]; then
    LOUPE_PORT="$PORT" LOUPE_SERVER_PID="$SERVER_PID" open "$APP_BUNDLE"
    echo "  Opened Loupe.app"
else
    echo "  Warning: Loupe.app not found — run scripts/install.sh to build it"
fi

echo "Done."
