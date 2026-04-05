#!/bin/bash
# Loupe — Claude Code hook
# Logs tool events and auto-starts the viewer on first invocation

set -e

LOUPE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.claude/logs"
LOG_FILE="$LOG_DIR/loupe.jsonl"
PID_FILE="$LOG_DIR/loupe.pid"
MODE_FILE="$LOG_DIR/loupe-mode"
PORT=8390

# Display mode: window | ghostty | island (default: window)
# Set via: echo "ghostty" > ~/.claude/logs/loupe-mode
LOUPE_MODE="window"
if [ -f "$MODE_FILE" ]; then
    LOUPE_MODE=$(cat "$MODE_FILE" | tr -d '[:space:]')
fi

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

    # Launch viewer based on mode
    case "$LOUPE_MODE" in
        ghostty)
            # Open TUI in Ghostty left split (if Ghostty is running)
            if pgrep -x "ghostty" > /dev/null 2>&1; then
                "$LOUPE_DIR/scripts/ghostty-split.sh" "$PORT" &
            else
                # Fallback to native app if Ghostty not running
                APP_BUNDLE="$LOUPE_DIR/Loupe.app"
                if [ -d "$APP_BUNDLE" ] && ! pgrep -f "Loupe.app/Contents/MacOS/loupe" > /dev/null 2>&1; then
                    LOUPE_PORT="$PORT" LOUPE_SERVER_PID="$SERVER_PID" open "$APP_BUNDLE"
                fi
            fi
            ;;
        island)
            # Launch native app (island is built into it, enabled by default)
            APP_BUNDLE="$LOUPE_DIR/Loupe.app"
            if [ -d "$APP_BUNDLE" ] && ! pgrep -f "Loupe.app/Contents/MacOS/loupe" > /dev/null 2>&1; then
                LOUPE_PORT="$PORT" LOUPE_SERVER_PID="$SERVER_PID" open "$APP_BUNDLE"
            fi
            ;;
        *)
            # Default: window mode (native app + TUI split in Ghostty)
            APP_BUNDLE="$LOUPE_DIR/Loupe.app"
            if [ -d "$APP_BUNDLE" ] && ! pgrep -f "Loupe.app/Contents/MacOS/loupe" > /dev/null 2>&1; then
                LOUPE_PORT="$PORT" LOUPE_SERVER_PID="$SERVER_PID" open "$APP_BUNDLE"
            fi
            # Also open TUI in Ghostty split if Ghostty is running
            if pgrep -x "ghostty" > /dev/null 2>&1; then
                "$LOUPE_DIR/scripts/ghostty-split.sh" "$PORT" &
            fi
            ;;
    esac
fi

exit 0
