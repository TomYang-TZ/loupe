#!/bin/bash
# Loupe — launch, restart, or stop
# Usage: loupe [start|restart|stop] [--port PORT]

set -e

LOUPE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.claude/logs"
LOG_FILE="$LOG_DIR/loupe.jsonl"
PID_FILE="$LOG_DIR/loupe.pid"
MODE_FILE="$LOG_DIR/loupe-mode"
PORT=8390

# Parse args
CMD="${1:-start}"
if [ "$CMD" = "--restart" ]; then CMD="restart"; fi
shift 2>/dev/null || true
while [[ $# -gt 0 ]]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        *) shift ;;
    esac
done

# Display mode
LOUPE_MODE="window"
[ -f "$MODE_FILE" ] && LOUPE_MODE=$(cat "$MODE_FILE" | tr -d '[:space:]')

TUI_PID_FILE="$LOG_DIR/loupe-tui.pid"

stop_all() {
    pkill -f "Loupe.app/Contents/MacOS/loupe" 2>/dev/null && echo "  Stopped app" || true
    if [ -f "$TUI_PID_FILE" ]; then
        kill "$(cat "$TUI_PID_FILE")" 2>/dev/null && echo "  Stopped TUI (pid $(cat "$TUI_PID_FILE"))" || true
        rm -f "$TUI_PID_FILE"
    fi
    if [ -f "$PID_FILE" ]; then
        kill "$(cat "$PID_FILE")" 2>/dev/null && echo "  Stopped server (pid $(cat "$PID_FILE"))" || true
        rm -f "$PID_FILE"
    fi
    lsof -ti:"$PORT" 2>/dev/null | xargs kill 2>/dev/null || true
}

start_server() {
    mkdir -p "$LOG_DIR"
    touch "$LOG_FILE"

    if [ ! -d "$LOUPE_DIR/node_modules/ws" ]; then
        cd "$LOUPE_DIR" && npm install --production > /dev/null 2>&1
    fi

    nohup node "$LOUPE_DIR/src/server/index.js" "$LOG_FILE" --json --port "$PORT" \
        > "$LOG_DIR/loupe-server.log" 2>&1 &
    SERVER_PID=$!
    echo "$SERVER_PID" > "$PID_FILE"
    echo "  Server started (pid $SERVER_PID, port $PORT)"
    sleep 0.5
}

start_viewer() {
    # Open native app (for dynamic island)
    open_app

    # Run TUI in the current terminal (foreground)
    echo "  Starting TUI..."
    exec env LOUPE_PORT="$PORT" node "$LOUPE_DIR/src/tui/index.js"
}

open_app() {
    APP_BUNDLE="$LOUPE_DIR/Loupe.app"
    if [ -d "$APP_BUNDLE" ] && ! pgrep -f "Loupe.app/Contents/MacOS/loupe" > /dev/null 2>&1; then
        open "$APP_BUNDLE" --args --island-only
        echo "  Opened dynamic island"
    fi
}

server_running() {
    if [ -f "$PID_FILE" ]; then
        kill -0 "$(cat "$PID_FILE")" 2>/dev/null && return 0
        rm -f "$PID_FILE"
    fi
    lsof -ti:"$PORT" >/dev/null 2>&1 && return 0
    return 1
}

case "$CMD" in
    start)
        if server_running; then
            echo "Loupe already running."
            exit 0
        fi
        echo "Starting Loupe (mode: $LOUPE_MODE)..."
        start_server
        start_viewer
        echo "Done."
        ;;
    restart)
        echo "Restarting Loupe (mode: $LOUPE_MODE)..."
        stop_all
        sleep 0.5
        start_server
        start_viewer
        echo "Done."
        ;;
    stop)
        echo "Stopping Loupe..."
        stop_all
        echo "Done."
        ;;
    *)
        echo "Usage: loupe [start|restart|stop] [--port PORT]"
        exit 1
        ;;
esac
