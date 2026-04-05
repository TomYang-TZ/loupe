# Loupe

Real-time log viewer and behavioral map for Claude Code sessions. Streams tool calls, thinking blocks, and errors into a floating macOS window with three display modes and multi-session support.

## Display Modes

Switch modes with `scripts/mode.sh [window|ghostty|island]`, then restart with `scripts/restart.sh`.

### Window (default)

Native macOS app with compact and full layouts. Shows live event stream with status bar, replay analysis, and behavioral maps.

### Dynamic Island

Notch-anchored floating pill at the top of the screen. Always-visible glanceable status.

- **Collapsed pill**: phase dot, label, active tool + file detail
- **Expanded card** (hover): user query, recent tool history, file/token/error counts, elapsed time
- **Approval flow**: pulsing amber → strikethrough on approve, "rejected" flash on deny
- **Agent tracking**: shows running/completed agent count during parallel work
- Toggle: `Cmd+Shift+I`

### Ghostty TUI

Terminal-based dashboard for Ghostty splits. Connects to the WebSocket server and renders a live ANSI-colored event stream.

```bash
# Open as a left split in Ghostty
bash scripts/ghostty-split.sh

# Or run standalone in any terminal
LOUPE_PORT=8390 node src/tui/index.js
```

## Maps

Toggle the telescope button (or `m`) to open the map section. Switch between modes with the **Files / Flow** pill.

### Files (Gravity Map)

Force-directed graph of files the agent touches. Nodes = files, edges = behavioral dependencies (prerequisite, coupling, validation). Files cluster by directory and session. Recently active nodes show momentum phase rings — colored borders indicating what the agent was doing when it last touched that file.

### Flow (Momentum Map)

Force-directed graph of thought-action spans — each thinking block plus its subsequent tool calls. Two-layer state system:

- **Fill color** = workflow phase: exploring (purple), implementing (green), testing (cyan), debugging (red), planning (amber)
- **Ring style** = progress signal: approaching (solid green), drifting (dashed yellow), stuck (pulsing red), breakthrough (glowing blue)

Nodes cluster by session + phase. Each session gets an organic background in its color. Six zero-ML detectors (looping, narrowing, backtracking, explosion, breakthrough, goal drift) run on sliding windows using string matching and set operations.

## Install

```bash
bash scripts/install.sh
```

Installs deps, compiles the native app, and configures 17 Claude Code hooks (tool use, permissions, sessions, agents, tasks, errors). Loupe auto-starts on your next session.

## Keyboard shortcuts

Press `?` in the app for all shortcuts.

| Key | Action |
|-----|--------|
| `Cmd+Shift+L` | Show/hide window |
| `Cmd+Shift+I` | Toggle Dynamic Island |
| `Cmd+Shift+M` | Toggle compact/full mode |
| `Cmd+Shift+N` | Toggle Files/Flow mode |
| `Cmd+T` | Toggle theme |
| `m` | Toggle map |
| `/` | Search |
| `j`/`k` | Navigate entries |
| `1` | All sessions |
| `2`-`9` | Jump to session |

## Web access

Loupe runs a local server — you can also open it in any browser at:

```
http://localhost:8390
```

## Manual start

```bash
node src/server/index.js ~/.claude/logs/loupe.jsonl --json --port 8390
open Loupe.app
```
