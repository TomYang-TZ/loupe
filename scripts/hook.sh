#!/bin/bash
# Loupe — Claude Code hook
# Logs tool events and auto-starts the viewer on first invocation

set -e

LOUPE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.claude/logs"
LOG_FILE="$LOG_DIR/loupe.jsonl"
PID_FILE="$LOG_DIR/loupe.pid"
PORT=8390

mkdir -p "$LOG_DIR"

EVENT_TYPE="${1:-tool_event}"

INPUT=""
if [ ! -t 0 ]; then
    INPUT=$(cat)
fi

if [ -n "$INPUT" ]; then
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    echo "{\"_logstream_type\":\"$EVENT_TYPE\",\"_ts\":\"$TIMESTAMP\",\"data\":$INPUT}" >> "$LOG_FILE"
fi

server_running() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        rm -f "$PID_FILE"
    fi
    if lsof -ti:"$PORT" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

if ! server_running; then
    touch "$LOG_FILE"

    if [ ! -d "$LOUPE_DIR/node_modules/ws" ]; then
        cd "$LOUPE_DIR" && npm install --production > /dev/null 2>&1
    fi

    # Start server (it spawns the thinking watcher as a child process)
    nohup node "$LOUPE_DIR/src/server/index.js" "$LOG_FILE" --json --port "$PORT" \
        > "$LOG_DIR/loupe-server.log" 2>&1 &
    SERVER_PID=$!
    echo "$SERVER_PID" > "$PID_FILE"

    sleep 0.5

    # Open TUI split (detects tmux, Ghostty, iTerm2, Kitty, fallback)
    "$LOUPE_DIR/scripts/open-tui.sh" "$PORT" >/dev/null 2>&1 || true

    # Open native app for dynamic island (window hidden by default)
    APP_BUNDLE="$LOUPE_DIR/Loupe.app"
    if [ -d "$APP_BUNDLE" ] && ! pgrep -f "Loupe.app/Contents/MacOS/loupe" > /dev/null 2>&1; then
        open "$APP_BUNDLE" --args --island-only
    fi
fi

exit 0
