# Claude Glass

Real-time log viewer for Claude Code sessions.

Streams tool calls, results, errors, and thinking blocks into a native macOS window that floats alongside your terminal. Automatically starts when Claude begins working.

## Install

```bash
# Clone
git clone https://github.com/TomYang-TZ/claude-glass.git ~/pal/logstream
cd ~/pal/logstream

# Install + build
bash scripts/install.sh
```

This compiles the native macOS app and installs the Node dependency (`ws`).

## Setup

Add these hooks to `~/.claude/settings.json` inside the `"hooks"` object:

```json
"PreToolUse": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "/Users/YOUR_USERNAME/pal/logstream/scripts/hook.sh PreToolUse",
        "async": true
      }
    ]
  }
],
"PostToolUse": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "/Users/YOUR_USERNAME/pal/logstream/scripts/hook.sh PostToolUse",
        "async": true
      }
    ]
  }
]
```

Replace `YOUR_USERNAME` with your macOS username.

## How it works

1. Claude Code fires `PreToolUse` / `PostToolUse` hooks on every tool call
2. `hook.sh` writes events to `~/.claude/logs/logstream.jsonl`
3. On first invocation, the hook starts:
   - **Node server** (`src/server/index.js`) — tails the log file, streams via WebSocket
   - **Thinking watcher** (`src/server/watcher.js`) — monitors Claude transcript files for thinking blocks
   - **Native app** (`Logstream.app`) — macOS window with WKWebView
4. Events stream in real-time to the floating window

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search |
| `Esc` | Clear search |
| `j` / `k` | Navigate entries |
| `Enter` | Expand / collapse entry |
| `e` | Toggle error filter |
| `g` | Jump to bottom |
| `0` | Switch to All Sessions |
| `1`-`9` | Switch to session by index |

## Features

- **Compact one-liner cards** — click to expand full details
- **Color-coded** — blue (tool use), green (result), red (error), purple (thinking)
- **Multi-session** — auto-discovers sessions, split panes in All tab
- **Resizable panes** — drag the separator between session panes
- **Recency emphasis** — recent entries are larger and brighter, older ones fade
- **Smart summaries** — auto-extracts file paths, commands, output previews
- **Relative timestamps** — `+0.5s`, `+1.2s` for pacing awareness

## Project structure

```
src/
  server/index.js    — HTTP + WebSocket server
  server/watcher.js  — Thinking block transcript watcher
  ui/index.html      — HTML entry point
  ui/styles.css      — Styles
  ui/app.js          — Client JavaScript
native/
  app.swift           — macOS native window (WKWebView)
  Info.plist          — App bundle manifest
scripts/
  hook.sh             — Claude Code hook
  install.sh          — Build + setup
```

## Manual start

```bash
# Start server
node src/server/index.js ~/.claude/logs/logstream.jsonl --json

# Start thinking watcher
node src/server/watcher.js ~/.claude/logs/logstream.jsonl

# Open in browser (or launch native app)
open http://localhost:8390
```
