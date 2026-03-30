# Loupe

Real-time log viewer for Claude Code sessions. Streams tool calls, results, errors, and thinking blocks into a floating macOS window.

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
| `Cmd+T` | Toggle theme |
| `/` | Search |
| `j`/`k` | Navigate entries |
| `e` | Toggle error filter |
| `1`-`9` | Jump to session |

## Manual start

```bash
node src/server/index.js ~/.claude/logs/loupe.jsonl --json
open Loupe.app
```
