# Loupe_

Real-time observer for Claude Code sessions. Streams tool calls, thinking blocks, approvals, errors, and agent activity into three display modes.

## Install

```bash
bash scripts/install.sh
```

Configures 17 Claude Code hooks and compiles the native app. Loupe auto-starts on your next session.

```bash
./loupe              # start (if not running)
./loupe restart      # kill and restart
./loupe stop         # stop everything
```

## Display Modes

### Window (default)

Native macOS app. Live event stream grouped by query, status bar (session state, errors, agents, tasks), multi-session vertical stacking with draggable panes.

### Dynamic Island

Notch-anchored pill. Adapts width to content. Pulses on approval/done, shows agent count, strikethrough on approve, red flash on reject.

Toggle: `Cmd+Shift+I`

### TUI

Interactive terminal dashboard. Auto-opens in Ghostty splits alongside the window.

- Queries grouped by session, collapsible
- `↑`/`↓` navigate, `→` drill in, `←` back out, `Enter` expand/collapse
- Detail view for full thinking text, prompts, tool I/O
- Agent tree pane, status line, session tabs (`1`-`9`)
```bash
LOUPE_PORT=8390 node src/tui/index.js
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Cmd+Shift+L` | Show/hide window |
| `Cmd+Shift+I` | Toggle Dynamic Island |
| `Cmd+Shift+M` | Compact/full mode |
| `m` | Toggle map |
| `/` | Search |
| `j`/`k` | Navigate |
| `1`-`9` | Switch session |

## Web Access

```
http://localhost:8390
```
