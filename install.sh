#!/bin/bash
# Install logstream: npm install, compile native app, code-sign
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== logstream installer ==="
echo ""

# 1. Install Node dependencies
echo "[1/4] Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --production 2>&1 | tail -1
echo "      Done"

# 2. Compile Swift native app
echo "[2/4] Compiling native macOS app..."
swiftc -O \
    -o "$SCRIPT_DIR/logstream-app" \
    "$SCRIPT_DIR/app.swift" \
    -framework Cocoa \
    -framework WebKit \
    2>&1

echo "      Built: $SCRIPT_DIR/logstream-app"

# 3. Assemble and code-sign .app bundle
echo "[3/4] Assembling app bundle..."
APP_DIR="$SCRIPT_DIR/Logstream.app/Contents"
mkdir -p "$APP_DIR/MacOS" "$APP_DIR/Resources"
cp "$SCRIPT_DIR/logstream-app" "$APP_DIR/MacOS/logstream-app"
cp "$SCRIPT_DIR/index.html" "$APP_DIR/Resources/index.html"

codesign --force --deep --sign - "$SCRIPT_DIR/Logstream.app" 2>&1
echo "      Signed: Logstream.app"

# 4. Setup
echo "[4/4] Setting permissions..."
chmod +x "$SCRIPT_DIR/hook.sh" "$SCRIPT_DIR/server.js"
mkdir -p "$HOME/.claude/logs"
echo "      Done"

echo ""
echo "=== Installation complete ==="
