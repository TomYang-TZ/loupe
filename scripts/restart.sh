#!/bin/bash
# Loupe — restart the server and native app
set -e

LOUPE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.claude/logs"
LOG_FILE="$LOG_DIR/loupe.jsonl"
PID_FILE="$LOG_DIR/loupe.pid"
MODE_FILE="$LOG_DIR/loupe-mode"
PORT=8390

# Display mode: window | ghostty | island
LOUPE_MODE="window"
[ -f "$MODE_FILE" ] && LOUPE_MODE=$(cat "$MODE_FILE" | tr -d '[:space:]')

echo "Restarting Loupe (mode: $LOUPE_MODE)..."

# Kill native app
pkill -f "Loupe.app/Contents/MacOS/loupe" 2>/dev/null && echo "  Stopped native app" || true

# Kill any TUI processes
pkill -f "src/tui/index.js" 2>/dev/null && echo "  Stopped TUI" || true

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

# Launch viewer based on mode
case "$LOUPE_MODE" in
    ghostty)
        if pgrep -x "ghostty" > /dev/null 2>&1; then
            "$LOUPE_DIR/scripts/ghostty-split.sh" "$PORT" &
            echo "  Opened Ghostty TUI split"
        else
            echo "  Warning: Ghostty not running, falling back to window mode"
            APP_BUNDLE="$LOUPE_DIR/Loupe.app"
            [ -d "$APP_BUNDLE" ] && LOUPE_PORT="$PORT" LOUPE_SERVER_PID="$SERVER_PID" open "$APP_BUNDLE" && echo "  Opened Loupe.app"
        fi
        ;;
    island)
        APP_BUNDLE="$LOUPE_DIR/Loupe.app"
        if [ -d "$APP_BUNDLE" ]; then
            LOUPE_PORT="$PORT" LOUPE_SERVER_PID="$SERVER_PID" open "$APP_BUNDLE"
            echo "  Opened Loupe.app (Dynamic Island mode)"
        else
            echo "  Warning: Loupe.app not found — run scripts/install.sh to build it"
        fi
        ;;
    *)
        APP_BUNDLE="$LOUPE_DIR/Loupe.app"
        if [ -d "$APP_BUNDLE" ]; then
            LOUPE_PORT="$PORT" LOUPE_SERVER_PID="$SERVER_PID" open "$APP_BUNDLE"
            echo "  Opened Loupe.app"
        else
            echo "  Warning: Loupe.app not found — run scripts/install.sh to build it"
        fi
        ;;
esac

echo "Done."
