#!/bin/bash
# Loupe — Open TUI companion in a Ghostty right split
# Usage: ghostty-split.sh [port]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PORT="${1:-8390}"
TUI_CMD="LOUPE_PORT=$PORT node $PROJECT_DIR/src/tui/index.js"

# Check if Ghostty is running
if ! osascript -e 'tell application "System Events" to (name of processes) contains "ghostty"' 2>/dev/null | grep -q "true"; then
  echo "Ghostty is not running."
  exit 1
fi

# Simulate Cmd+D (new_split:right) then type the TUI command
osascript -e "
tell application \"Ghostty\" to activate
delay 0.3
tell application \"System Events\"
  keystroke \"d\" using command down
  delay 0.5
  keystroke \"$TUI_CMD\"
  delay 0.1
  key code 36
end tell
"

exit 0
