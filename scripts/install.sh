#!/bin/bash
# Loupe installer: npm install, compile native app, configure Claude Code hooks
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SETTINGS_FILE="$HOME/.claude/settings.json"
HOOK_PATH="$SCRIPT_DIR/hook.sh"

echo ""
echo "  Loupe — Real-time log viewer for Claude Code"
echo "  ============================================="
echo ""

# 1. Install Node dependencies
echo "[1/5] Installing dependencies..."
cd "$PROJECT_DIR"
npm install --production 2>&1 | tail -1
echo "      Done"

# 2. Compile Swift native app
echo "[2/5] Compiling native macOS app..."
swiftc -O \
    -o "$PROJECT_DIR/native/loupe" \
    "$PROJECT_DIR/native/app.swift" \
    -framework Cocoa \
    -framework WebKit \
    2>&1
echo "      Built: native/loupe"

# 3. Assemble and code-sign .app bundle
echo "[3/5] Assembling app bundle..."
APP_DIR="$PROJECT_DIR/Loupe.app/Contents"
mkdir -p "$APP_DIR/MacOS" "$APP_DIR/Resources"
cp "$PROJECT_DIR/native/loupe" "$APP_DIR/MacOS/loupe"
cp "$PROJECT_DIR/native/Info.plist" "$APP_DIR/Info.plist"

codesign --force --deep --sign - "$PROJECT_DIR/Loupe.app" 2>&1
echo "      Signed: Loupe.app"

# 4. Permissions + directories
echo "[4/5] Setting permissions..."
chmod +x "$HOOK_PATH"
mkdir -p "$HOME/.claude/logs"
echo "      Done"

# 5. Configure Claude Code hooks
echo "[5/5] Configuring Claude Code hooks..."

if [ ! -f "$SETTINGS_FILE" ]; then
    echo '{}' > "$SETTINGS_FILE"
fi

# Use node to safely merge hooks into settings.json
node -e "
const fs = require('fs');
const path = '$SETTINGS_FILE';
const hookCmd = '$HOOK_PATH';

const settings = JSON.parse(fs.readFileSync(path, 'utf-8'));
if (!settings.hooks) settings.hooks = {};

const hookTypes = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'];

function hasLoupeHook(arr) {
  return (arr || []).some(h =>
    h.hooks?.some(hh => hh.command?.includes('loupe') || hh.command?.includes('logstream'))
  );
}

for (const ht of hookTypes) {
  const hook = {
    hooks: [{ type: 'command', command: hookCmd + ' ' + ht, async: true }]
  };
  if (!hasLoupeHook(settings.hooks[ht])) {
    if (!settings.hooks[ht]) settings.hooks[ht] = [];
    settings.hooks[ht].push(hook);
  }
}

fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
console.log('      Hooks configured in ' + path);
"

echo ""
echo "  Installation complete!"
echo ""
echo "  Loupe will automatically open when you start a Claude Code session."
echo "  Press ? in the viewer to see keyboard shortcuts."
echo ""
