#!/bin/bash
# Loupe — Open TUI companion in a Ghostty left split
# Usage: ghostty-split.sh [port]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PORT="${1:-8390}"
TUI_CMD="LOUPE_PORT=$PORT node $PROJECT_DIR/src/tui/index.js"

# Check if Ghostty is running
if ! pgrep -x "ghostty" > /dev/null 2>&1; then
  echo "Ghostty is not running."
  exit 1
fi

# Use AppleScript to create a left split in the focused Ghostty terminal
osascript -e "
tell application \"Ghostty\"
  set t to focused terminal of front window
  set cfg to new surface configuration
  set command of cfg to \"$TUI_CMD\"
  split t direction left with configuration cfg
end tell
" 2>/dev/null

exit 0
