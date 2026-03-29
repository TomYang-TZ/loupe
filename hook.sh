#!/bin/bash
# Claude Code hook — logs tool events and auto-starts logstream
# Receives JSON on stdin from Claude Code hooks (PreToolUse / PostToolUse)

set -e

LOGSTREAM_DIR="$HOME/pal/logstream"
LOG_DIR="$HOME/.claude/logs"
LOG_FILE="$LOG_DIR/logstream.jsonl"
PID_FILE="$LOG_DIR/logstream.pid"
PORT=8390

mkdir -p "$LOG_DIR"

# Determine event type from first argument or env
EVENT_TYPE="${1:-tool_event}"

# Read stdin (hook input JSON)
INPUT=""
if [ ! -t 0 ]; then
    INPUT=$(cat)
fi

# Append event to log file with metadata
if [ -n "$INPUT" ]; then
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    # Wrap the hook data with our metadata
    echo "{\"_logstream_type\":\"$EVENT_TYPE\",\"_ts\":\"$TIMESTAMP\",\"data\":$INPUT}" >> "$LOG_FILE"
fi

# Check if server is already running
server_running() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        rm -f "$PID_FILE"
    fi
    # Also check if port is in use
    if lsof -ti:"$PORT" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

# Start logstream server + native app if not running
if ! server_running; then
    touch "$LOG_FILE"

    # Ensure dependencies are installed
    if [ ! -d "$LOGSTREAM_DIR/node_modules/ws" ]; then
        cd "$LOGSTREAM_DIR" && npm install --production > /dev/null 2>&1
    fi

    # Start server in background
    nohup node "$LOGSTREAM_DIR/server.js" "$LOG_FILE" --json --port "$PORT" \
        > "$LOG_DIR/logstream-server.log" 2>&1 &
    SERVER_PID=$!
    echo "$SERVER_PID" > "$PID_FILE"

    # Start thinking watcher (reads Claude transcript files for thinking blocks)
    THINKER_PID_FILE="$LOG_DIR/logstream-thinker.pid"
    nohup node "$LOGSTREAM_DIR/thinking-watcher.js" "$LOG_FILE" \
        > "$LOG_DIR/logstream-thinker.log" 2>&1 &
    echo "$!" > "$THINKER_PID_FILE"

    # Wait for server to be ready
    sleep 0.5

    # Launch native app
    APP_BUNDLE="$LOGSTREAM_DIR/Logstream.app"
    if [ -d "$APP_BUNDLE" ]; then
        LOGSTREAM_PORT="$PORT" LOGSTREAM_SERVER_PID="$SERVER_PID" \
            nohup "$APP_BUNDLE/Contents/MacOS/logstream-app" > /dev/null 2>&1 &
    fi
fi

exit 0
