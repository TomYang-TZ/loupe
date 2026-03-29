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
   - **Node server** -- tails the log file, streams via WebSocket
   - **Thinking watcher** -- monitors Claude transcript files for thinking blocks
   - **Native app** -- macOS floating window (WKWebView)
4. Events stream in real-time to the viewer

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `?` | Show all shortcuts |
| `/` | Focus search |
| `Esc` | Clear search / close help |
| `j` / `k` | Navigate entries |
| `Enter` | Open entry detail |
| `e` | Toggle error filter |
| `g` | Jump to bottom |
| `0` | All Sessions view |
| `1`-`9` | Jump to session by index |
| `Cmd+Opt+Left/Right` | Cycle between sessions |
| `Cmd+T` | Toggle light/dark theme |
| `Cmd+`/`Cmd-` | Zoom in/out |
| `Cmd+Shift+`/`Cmd+Shift-` | Add/remove columns |

## Features

- **Light/dark theme** -- animated toggle switch, `Cmd+T` shortcut, persists via localStorage. Native window chrome matches theme.
- **Compact one-liner cards** -- click to expand full details in a modal
- **Color-coded types** -- cyan (tool use), green (result), red (error), purple (thinking)
- **Multi-session** -- auto-discovers sessions, resizable grid panes in All tab
- **Resizable panes** -- drag pane edges to resize columns and rows
- **Column control** -- `+`/`-` buttons or `Cmd+Shift+`/`-` to adjust grid columns
- **Zoom** -- `Cmd+`/`Cmd-` to scale log entries, persists across restarts
- **Draggable tabs** -- reorder sessions by dragging
- **Session-aware clear** -- clears only the active session, or everything on All tab
- **Stale detection** -- idle sessions fade with time label, closeable
- **Smart summaries** -- auto-extracts file paths, commands, output previews
- **Filter toggle** -- click type label to isolate, click again to show all
- **Dedup** -- server-side deduplication of thinking entries
- **Smart backlog** -- only loads entries from the last 5 minutes on connect

## Project structure

```
src/
  server/index.js    -- HTTP + WebSocket server, backlog dedup
  server/watcher.js  -- Thinking block transcript watcher (single-instance)
  ui/index.html      -- HTML entry point
  ui/styles.css      -- Styles (dark + light themes)
  ui/app.js          -- Client JavaScript
native/
  app.swift           -- macOS native window (WKWebView, theme sync, zoom/column shortcuts)
  Info.plist          -- App bundle manifest
scripts/
  hook.sh             -- Claude Code hook
  install.sh          -- Build, setup, and hook configuration
```

## Manual start

```bash
node src/server/index.js ~/.claude/logs/loupe.jsonl --json
node src/server/watcher.js ~/.claude/logs/loupe.jsonl
open http://localhost:8390
```
