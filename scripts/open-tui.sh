#!/bin/bash
# Loupe — Open TUI in a terminal split or new window
# Detects tmux, Ghostty, iTerm2, Kitty; falls back to new window
# Usage: open-tui.sh [port]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PORT="${1:-8390}"
TUI_CMD="LOUPE_PORT=$PORT node $PROJECT_DIR/src/tui/index.js"

# 1. tmux — works in any terminal
if [ -n "$TMUX" ]; then
  tmux split-window -h "$TUI_CMD"
  echo "tui:tmux"
  exit 0
fi

# 2. Ghostty
if osascript -e 'tell application "System Events" to (name of processes) contains "ghostty"' 2>/dev/null | grep -q "true"; then
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
  echo "tui:ghostty"
  exit 0
fi

# 3. iTerm2
if osascript -e 'tell application "System Events" to (name of processes) contains "iTerm2"' 2>/dev/null | grep -q "true"; then
  osascript -e "
tell application \"iTerm2\"
  tell current session of current tab of current window
    split vertically with default profile command \"$TUI_CMD\"
  end tell
end tell
"
  echo "tui:iterm2"
  exit 0
fi

# 4. Kitty (remote control must be enabled)
if command -v kitty &>/dev/null && kitty @ ls &>/dev/null 2>&1; then
  kitty @ launch --type=split --location=vsplit $TUI_CMD
  echo "tui:kitty"
  exit 0
fi

# 5. Fallback — new terminal window
TERM_APP="${TERM_PROGRAM:-Terminal}"
case "$TERM_APP" in
  *ghostty*|*Ghostty*)
    open -na Ghostty.app --args -e "$TUI_CMD"
    ;;
  *iTerm*|*iterm*)
    osascript -e "tell application \"iTerm2\" to create window with default profile command \"$TUI_CMD\""
    ;;
  *)
    osascript -e "tell application \"Terminal\" to do script \"$TUI_CMD\""
    ;;
esac
echo "tui:window"
exit 0
