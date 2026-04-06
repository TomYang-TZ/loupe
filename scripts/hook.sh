#!/bin/bash
# Loupe — Claude Code hook
# Logs events to loupe.jsonl. Start Loupe manually: npm start

set -e

LOG_DIR="$HOME/.claude/logs"
LOG_FILE="$LOG_DIR/loupe.jsonl"

mkdir -p "$LOG_DIR"

EVENT_TYPE="${1:-tool_event}"

INPUT=""
if [ ! -t 0 ]; then
    INPUT=$(cat)
fi

if [ -n "$INPUT" ]; then
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    # Collapse literal newlines to spaces — JSONL requires one JSON object per line
    printf '%s\n' "{\"_logstream_type\":\"$EVENT_TYPE\",\"_ts\":\"$TIMESTAMP\",\"data\":$(printf '%s' "$INPUT" | tr '\n' ' ')}" >> "$LOG_FILE"
fi

exit 0
