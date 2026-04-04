# Loupe

Real-time log viewer and behavioral map for Claude Code sessions. Streams tool calls, thinking blocks, and errors into a floating macOS window with two map modes and multi-session support.

## Branch: feature/dynamic-island

This branch adds three new display modes alongside the existing native window:

### Dynamic Island (done)
A notch-anchored floating pill at the top of the screen. Shows live session status at a glance.

- **Collapsed pill**: phase dot, phase label, active tool + file detail
- **Expanded card** (hover to expand): user query, stats (files/tokens/errors/sessions), elapsed time, recent tool history
- **Warm animation**: subtle glow + size growth before expanding
- Toggle: `Cmd+Shift+I`

### TUI Companion (done)
Terminal-based dashboard (`src/tui/index.js`) for use in Ghostty splits. Connects to the WebSocket server and renders a live ANSI-colored event stream with phase, tool, and stats.

### Ghostty Integration (done)
AppleScript-based auto-split (`scripts/ghostty-split.sh`) that opens the TUI in a left split of the focused Ghostty terminal.

### Mode Toggle (done)
Switch display modes via `scripts/mode.sh [window|ghostty|island]`. Writes to `~/.claude/logs/loupe-mode`, read by `hook.sh` and `restart.sh`.

### Not yet done
- Test TUI companion in a live Ghostty split
- Test full mode switching cycle (window → ghostty → island → window)
- Ghostty split: handle case where split already exists (avoid duplicates)
- Island: no data shows when no active session (could show "waiting for session")
- Island: collapsed pill could animate the tool name when it changes
- Merge prep: restore main repo files after testing (app.js, Loupe.app binary)

---

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

Installs deps, compiles the native app, and configures Claude Code hooks. Loupe auto-starts on your next session.

## Keyboard shortcuts

Press `?` in the app for all shortcuts.

| Key | Action |
|-----|--------|
| `Cmd+Shift+L` | Show/hide window |
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
