#!/bin/bash
# Loupe uninstaller: stop processes, remove hooks, clean up
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SETTINGS_FILE="$HOME/.claude/settings.json"
LOG_DIR="$HOME/.claude/logs"

echo ""
echo "  Loupe — Uninstall"
echo "  =================="
echo ""

# 1. Stop everything
echo "[1/4] Stopping Loupe..."
bash "$SCRIPT_DIR/loupe.sh" stop 2>/dev/null || true
echo "      Done"

# 2. Remove hooks from settings.json
echo "[2/4] Removing Claude Code hooks..."
if [ -f "$SETTINGS_FILE" ]; then
    node -e "
const fs = require('fs');
const path = '$SETTINGS_FILE';
const settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
if (settings.hooks) {
  for (const ht of Object.keys(settings.hooks)) {
    settings.hooks[ht] = (settings.hooks[ht] || []).filter(h =>
      !(h.hooks || []).some(hh => hh.command?.includes('loupe') || hh.command?.includes('logstream'))
    );
    if (settings.hooks[ht].length === 0) delete settings.hooks[ht];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
console.log('      Removed hooks from ' + path);
"
else
    echo "      No settings file found"
fi

# 3. Clean up runtime files
echo "[3/4] Cleaning up..."
rm -f "$LOG_DIR/loupe.pid"
rm -f "$LOG_DIR/loupe-tui.pid"
rm -f "$LOG_DIR/loupe-mode"
rm -f "$LOG_DIR/loupe-server.log"
rm -f "$LOG_DIR/loupe-show-window"
echo "      Removed PID and log files"

# 4. Remove app bundle
echo "[4/4] Removing app bundle..."
rm -rf "$PROJECT_DIR/Loupe.app"
rm -f "$PROJECT_DIR/native/loupe"
echo "      Removed Loupe.app"

echo ""
echo "  Uninstall complete."
echo "  Project files remain in $PROJECT_DIR — delete manually if needed."
echo ""
