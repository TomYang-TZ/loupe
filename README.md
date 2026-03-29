# Loupe

Real-time log viewer for Claude Code sessions.

Streams tool calls, results, errors, and thinking blocks into a native macOS window that floats alongside your terminal. Automatically starts when Claude begins working.

## Install

```bash
git clone https://github.com/TomYang-TZ/loupe.git
cd loupe

bash scripts/install.sh
```

That's it. The installer:
1. Installs the Node dependency (`ws`)
2. Compiles the native macOS app (Swift)
3. Code-signs the app bundle
4. Configures Claude Code hooks in `~/.claude/settings.json`

Loupe will automatically open on your next Claude Code session.

## How it works

1. Claude Code fires `PreToolUse` / `PostToolUse` hooks on every tool call
2. `hook.sh` writes events to `~/.claude/logs/loupe.jsonl`
3. On first invocation, the hook starts:
   - **Node server** — tails the log file, streams via WebSocket
   - **Thinking watcher** — monitors Claude transcript files for thinking blocks
   - **Native app** — macOS floating window (WKWebView)
4. Events stream in real-time to the viewer

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `?` | Show all shortcuts |
| `/` | Focus search |
| `Esc` | Clear search / close help |
| `j` / `k` | Navigate entries |
| `Enter` | Expand / collapse entry |
| `e` | Toggle error filter |
| `g` | Jump to bottom |
| `0` | All Sessions view |
| `1`-`9` | Jump to session by index |
| `Cmd+Opt+Left/Right` | Cycle between sessions |

## Features

- **Compact one-liner cards** — click to expand full details
- **Color-coded** — blue (tool use), green (result), red (error), purple (thinking)
- **Multi-session** — auto-discovers sessions, grid panes in All tab
- **Draggable tabs** — reorder sessions by dragging
- **Stale detection** — idle sessions fade with time label, closeable
- **Recency** — time-based opacity fade for older entries
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
  install.sh          — Build, setup, and hook configuration
```

## Manual start

```bash
node src/server/index.js ~/.claude/logs/loupe.jsonl --json
node src/server/watcher.js ~/.claude/logs/loupe.jsonl
open http://localhost:8390
```
