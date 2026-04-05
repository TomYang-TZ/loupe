#!/bin/bash
# Loupe — generate icon and all derived assets
# Requires: Python 3 + Pillow (pip install Pillow)
#
# Generates: native/icon_1024.png, native/Loupe.iconset/*, native/Loupe.icns,
#            docs/images/logo.png, docs/images/favicon.png, docs/images/social-preview.png
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 1. Generate all PNGs via gen-icon.py (master, iconset, favicon, logo, social preview)
echo "Generating icon assets..."
python3 "$SCRIPT_DIR/gen-icon.py"

# 2. Compile .icns from iconset
ICONSET_DIR="$PROJECT_DIR/native/Loupe.iconset"
if [ -d "$ICONSET_DIR" ]; then
    iconutil -c icns "$ICONSET_DIR" -o "$PROJECT_DIR/native/Loupe.icns"
    echo "Compiled: native/Loupe.icns"
fi

echo ""
echo "Done. Update Loupe.app by running: bash scripts/install.sh"
