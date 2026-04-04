#!/bin/bash
# Loupe — switch display mode
# Usage: mode.sh [window|ghostty|island]

MODE_FILE="$HOME/.claude/logs/loupe-mode"
mkdir -p "$(dirname "$MODE_FILE")"

if [ -z "$1" ]; then
  CURRENT="window"
  [ -f "$MODE_FILE" ] && CURRENT=$(cat "$MODE_FILE" | tr -d '[:space:]')
  echo "Current mode: $CURRENT"
  echo ""
  echo "Usage: $(basename "$0") <mode>"
  echo "  window   — Standalone native window (default)"
  echo "  ghostty  — TUI companion in Ghostty left split"
  echo "  island   — Dynamic Island pill at screen top"
  exit 0
fi

case "$1" in
  window|ghostty|island)
    echo "$1" > "$MODE_FILE"
    echo "Loupe mode set to: $1"
    echo "Restart Loupe to apply (scripts/restart.sh)"
    ;;
  *)
    echo "Unknown mode: $1"
    echo "Options: window, ghostty, island"
    exit 1
    ;;
esac
