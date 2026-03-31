# Minimal Mode Refresh — Cool Slate Theme & UI Polish

**Date:** 2026-03-30
**Status:** Approved
**Approach:** B — Themed Refresh
**Files affected:** `src/ui/styles.css`, `src/ui/app.js`, `src/ui/index.html`, `src/server/index.js`, `native/app.swift`

---

## Summary

Holistic refresh of Loupe's minimal mode and theme system: Cool Slate color palette (dark + light), animated sun/moon theme toggle, tab bar overflow fix, and session sync between popover/window WebViews.

---

## 1. Cool Slate Color Palette

Replace the current neutral grays with Tailwind Slate-based cool blue-tinted grays. Purple accent stays.

### Dark Theme (`:root`)

| Variable | Current | New |
|---|---|---|
| `--bg` | `#22222a` | `#0f172a` (slate-900) |
| `--surface` | `#2a2a34` | `#1e293b` (slate-800) |
| `--surface-hover` | `#34343e` | `#334155` (slate-700) |
| `--border` | `#42424e` | `#475569` (slate-600) |
| `--border-light` | `#32323c` | `#334155` (slate-700) |
| `--text` | `#fafafa` | `#f1f5f9` (slate-100) |
| `--text-muted` | `#b4b4be` | `#94a3b8` (slate-400) |
| `--text-subtle` | `#8b8b96` | `#64748b` (slate-500) |
| `--text-ghost` | `#8a8a96` | `#526280` (slate-500 +5% lightness) |
| `--text-dim` | `#7a7a88` | `#475569` (slate-600) |

Accent and semantic colors unchanged in dark mode (`--accent: #8b5cf6`, `--accent-dim: rgba(139, 92, 246, 0.12)`, `--accent-glow: rgba(139, 92, 246, 0.3)`, `--green: #4ade80`, `--red: #ef4444`, `--red-dim: rgba(239, 68, 68, 0.06)`, `--blue: #3b82f6`, `--blue-dim: rgba(59, 130, 246, 0.08)`, `--result: #a1a1aa`, `--result-dim: rgba(161, 161, 170, 0.05)`).

### Light Theme (`[data-theme="light"]`)

| Variable | Current | New |
|---|---|---|
| `--bg` | `#f5f5f7` | `#f8fafc` (slate-50) |
| `--surface` | `#ffffff` | `#ffffff` (unchanged) |
| `--surface-hover` | `#ededf2` | `#f1f5f9` (slate-100) |
| `--border` | `#c8c8d4` | `#cbd5e1` (slate-300) |
| `--border-light` | `#dcdce6` | `#e2e8f0` (slate-200) |
| `--text` | `#111118` | `#0f172a` (slate-900) |
| `--text-muted` | `#3a3a4a` | `#475569` (slate-600) |
| `--text-subtle` | `#55556a` | `#94a3b8` (slate-400) |
| `--text-ghost` | `#72728a` | `#94a3b8` (slate-400) |
| `--text-dim` | `#8a8aa0` | `#cbd5e1` (slate-300) |
| `--accent` | `#7c3aed` | `#7c3aed` (unchanged) |
| `--green` | `#16a34a` | `#16a34a` (unchanged) |
| `--red` | `#dc2626` | `#dc2626` (unchanged) |
| `--blue` | `#2563eb` | `#2563eb` (unchanged) |
| `--blue-dim` | `rgba(37, 99, 235, 0.06)` | `rgba(37, 99, 235, 0.06)` (unchanged) |
| `--accent-dim` | `rgba(124, 58, 237, 0.08)` | `rgba(124, 58, 237, 0.08)` (unchanged) |
| `--accent-glow` | `rgba(124, 58, 237, 0.15)` | `rgba(124, 58, 237, 0.15)` (unchanged) |
| `--red-dim` | `rgba(220, 38, 38, 0.06)` | `rgba(220, 38, 38, 0.06)` (unchanged) |
| `--result` | `#55556a` | `#64748b` (slate-500) |
| `--result-dim` | `rgba(85, 85, 106, 0.05)` | `rgba(100, 116, 139, 0.05)` |

Light mode category border-left colors stay as-is from current CSS (`#0369a1` cyan, `#16a34a` green, `#dc2626` red, `#c026d3` violet, `#55556a` text).

### Swift Native Background Colors (`app.swift`)

Update `NSColor` values for window chrome to match Cool Slate:

| Theme | Current | New |
|---|---|---|
| Dark bg | `rgb(34, 34, 42)` | `rgb(15, 23, 42)` — `#0f172a` |
| Light bg | `rgb(245, 245, 247)` | `rgb(248, 250, 252)` — `#f8fafc` |

Update in both `themeChange` handler and initial panel/window setup.

### `data-theme` attribute strategy

The dark theme variables stay in `:root` (no `[data-theme]` qualifier) — this is the default. The `[data-theme="dark"]` selectors used for the sun/moon icon state work because `initTheme()` in app.js always sets `document.documentElement.dataset.theme` to `"dark"` or `"light"` on page load. No change needed to this strategy.

---

## 2. Sun/Moon Theme Toggle

Replace the checkbox-based `.theme-switch` with an animated SVG sun/moon button, adapted from the reference implementation.

### HTML

Replace both theme switch labels (header + minimal topbar) with:

```html
<button id="theme-toggle" class="theme-toggle" title="Toggle theme (⌘T)" aria-label="dark">
  <svg class="sun-and-moon" aria-hidden="true" width="22" height="22" viewBox="0 0 24 24">
    <mask class="moon" id="moon-mask">
      <rect x="0" y="0" width="100%" height="100%" fill="white" />
      <circle cx="24" cy="10" r="6" fill="black" />
    </mask>
    <circle class="sun" cx="12" cy="12" r="6" mask="url(#moon-mask)" fill="currentColor" />
    <g class="sun-beams" stroke="currentColor">
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </g>
  </svg>
</button>
```

**Minimal topbar variant** (different IDs and size to avoid SVG ID collisions):

```html
<button id="theme-toggle-mini" class="theme-toggle" title="Toggle theme (⌘T)" aria-label="dark">
  <svg class="sun-and-moon" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
    <mask class="moon" id="moon-mask-mini">
      <rect x="0" y="0" width="100%" height="100%" fill="white" />
      <circle cx="24" cy="10" r="6" fill="black" />
    </mask>
    <circle class="sun" cx="12" cy="12" r="6" mask="url(#moon-mask-mini)" fill="currentColor" />
    <g class="sun-beams" stroke="currentColor">
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </g>
  </svg>
</button>
```

**Icon sizing:**
- Full mode header: `width="22" height="22"`
- Minimal topbar: `width="18" height="18"`

### CSS

Remove the old `.theme-switch`, `.theme-slider`, `.theme-switch input` rules entirely.

Add new styles:

```css
/* ===== Sun/Moon Theme Toggle ===== */
.theme-toggle {
  --icon-fill: var(--text-muted);
  --icon-fill-hover: var(--text);
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.sun-and-moon > :is(.moon, .sun, .sun-beams) {
  transform-origin: center center;
}
.sun-and-moon > :is(.moon, .sun) {
  fill: var(--icon-fill);
}
.sun-and-moon > .sun-beams {
  stroke: var(--icon-fill);
  stroke-width: 2px;
  stroke-linecap: round;
}

.theme-toggle:is(:hover, :focus-visible) .sun-and-moon > :is(.moon, .sun) {
  fill: var(--icon-fill-hover);
}
.theme-toggle:is(:hover, :focus-visible) .sun-and-moon > .sun-beams {
  stroke: var(--icon-fill-hover);
}

/* Dark mode icon state */
[data-theme="dark"] .sun-and-moon > .sun {
  transform: scale(1.75);
}
[data-theme="dark"] .sun-and-moon > .sun-beams {
  opacity: 0;
}
[data-theme="dark"] .sun-and-moon > .moon > circle {
  transform: translate(-7px);
}
@supports (cx: 1) {
  [data-theme="dark"] .sun-and-moon > .moon > circle {
    transform: translate(0);
    cx: 17;
  }
}

/* Animations (respects reduced motion) */
@media (prefers-reduced-motion: no-preference) {
  .sun-and-moon > .sun {
    transition: transform .5s cubic-bezier(.5, 1.25, .75, 1.25);
  }
  .sun-and-moon > .sun-beams {
    transition: transform .5s cubic-bezier(.5, 1.5, .75, 1.25), opacity .5s cubic-bezier(.25, 0, .3, 1);
  }
  .sun-and-moon .moon > circle {
    transition: transform .25s cubic-bezier(0, 0, 0, 1);
  }
  @supports (cx: 1) {
    .sun-and-moon .moon > circle {
      transition: cx .25s cubic-bezier(0, 0, 0, 1);
    }
  }
  [data-theme="dark"] .sun-and-moon > .sun {
    transform: scale(1.75);
    transition-timing-function: cubic-bezier(.25, 0, .3, 1);
    transition-duration: .25s;
  }
  [data-theme="dark"] .sun-and-moon > .sun-beams {
    transform: rotate(-25deg);
    transition-duration: .15s;
  }
  [data-theme="dark"] .sun-and-moon > .moon > circle {
    transition-delay: .25s;
    transition-duration: .5s;
  }
}
```

### JS

- Remove the checkbox references: `themeToggle` (line ~1106, `document.getElementById("theme-toggle")` — currently used as checkbox) and `miniThemeToggle` (line ~1203, `document.getElementById("theme-toggle-mini")`)
- Replace with button references: `const themeBtn = document.getElementById("theme-toggle")` and `const themeBtnMini = document.getElementById("theme-toggle-mini")`
- `toggleTheme()` stays the same (flips `data-theme`, saves to localStorage, notifies Swift)
- `applyTheme()`: remove `themeToggle.checked = ...` checkbox sync logic. Add aria-label update:
  ```js
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  if (themeBtn) themeBtn.setAttribute("aria-label", label);
  if (themeBtnMini) themeBtnMini.setAttribute("aria-label", label);
  ```
- Both buttons get `onclick = (e) => { e.preventDefault(); toggleTheme(); }`
- `⌘T` shortcut stays unchanged

---

## 3. Minimal Mode Tab Bar Fix

### Problem

Tabs use inline layout with `display: inline` close button and `position: absolute` activity dot. In the compact minimal mode width, tab labels overflow and × buttons overlap adjacent tab text.

### Fix

Add minimal-mode-specific tab styles:

```css
body.minimal .session-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  font-size: 10px;
  flex-shrink: 0;
}

body.minimal .session-tab .tab-label {
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
}

body.minimal .tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  font-size: 9px;
  flex-shrink: 0;
  border-radius: 3px;
  line-height: 1;
}

body.minimal .session-tab .tab-dot {
  position: static;
  flex-shrink: 0;
  margin-right: -2px;
}
```

### JS Change

In `rebuildTabs()`, wrap the tab label text in a `<span class="tab-label">` so CSS can target it for truncation:

```js
// Current:
tab.innerHTML = `${esc(info.label)}${shortcut}${staleLabel}<span class="tab-dot"></span><button class="tab-close">×</button>`;

// New:
tab.innerHTML = `<span class="tab-label">${esc(info.label)}</span>${shortcut}${staleLabel}<span class="tab-dot"></span><button class="tab-close" title="Remove">×</button>`;
```

This is a safe change — the `.tab-label` span is added globally in the JS, but the CSS rules that constrain it (`max-width`, ellipsis) are all scoped behind `body.minimal`, so full mode tabs render identically to before.

---

## 4. Minimal Topbar Polish

Elevate the minimal topbar background to `--surface` with a border, matching the Cool Slate depth hierarchy.

Changes from current values:
- `background`: `var(--bg)` → `var(--surface)` (gives depth separation)
- `gap`: `6px` → `8px` (slightly more breathing room between controls)
- `padding`: `5px 8px` → `5px 10px` (wider horizontal padding for balance)

```css
.minimal-topbar {
  display: none;
  align-items: center;
  gap: 8px;                                      /* was: 6px */
  padding: 5px 10px;                              /* was: 5px 8px */
  background: var(--surface);                     /* was: var(--bg) */
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}
```

Pin toggle track size reduced slightly for the compact layout:

```css
body.minimal .pin-toggle-track {
  width: 26px;
  height: 14px;
}
body.minimal .pin-toggle-knob {
  width: 10px;
  height: 10px;
}
body.minimal .pin-toggle.unpinned .pin-toggle-knob { left: 2px; }
body.minimal .pin-toggle.pinned .pin-toggle-knob { left: 14px; }
```

---

## 5. Session Sync Fix (Phantom Session Bug)

### Problem

Popover (minimal) and window mode are separate WKWebView instances with independent WebSocket connections. Each receives a backlog on connect (last 5 min / 200 entries). If a session's events have aged out of the backlog by the time window mode connects, that view never learns about the session — but minimal mode still has it in memory.

### Fix

Add server-side session tracking and a `sessions` protocol message.

**Server (`src/server/index.js`):**

1. Maintain a `Map<sessionId, {label, lastEventTs}>` of known sessions
2. Extract session info from each log line by parsing JSON and reading `session_id` field. Use the same `cwd`-based label extraction that `extractSessionLabel()` does on the client (take the last path segment of `cwd`). If the line is not valid JSON or has no `session_id`, skip it for session tracking purposes (still broadcast the line as-is).
3. On new WebSocket connection, send a `sessions` message after the backlog:
   ```json
   {"type": "sessions", "list": [{"id": "abc123", "label": "Session 1"}, ...]}
   ```
4. Periodically (every 30s), prune sessions with no events for 5+ minutes and broadcast:
   ```json
   {"type": "session_remove", "id": "abc123"}
   ```

**Client (`src/ui/app.js`):**

1. Handle `sessions` message: reconcile local `sessions` Map — remove any local sessions not in the server's list. For sessions in the server's list that are missing locally, add them with defaults: `count: 0`, `color: nextSessionColor()`, `lastEventTs: null`, `label` from the server message.
2. Handle `session_remove` message: **do NOT call existing `removeSession()`** (which destructively deletes all log entries for that session). Instead, add a new `pruneSessionTab(id)` function that only removes the session from `sessions` Map and `sessionOrder` array, rebuilds tabs, and switches to "all" if the pruned session was active. Log entries in the `entries` array are preserved.
   ```js
   function pruneSessionTab(id) {
     sessions.delete(id);
     sessionOrder = sessionOrder.filter(s => s !== id);
     if (activeSession === id) activeSession = "all";
     rebuildTabs();
     rebuildView();
   }
   ```
3. This runs on every WebSocket connect, so switching modes (which triggers a new page load + new WS connection) always gets a fresh, accurate session list

---

## Testing

- [ ] Dark theme: verify Cool Slate colors render correctly — bg should have a blue tint, not neutral gray
- [ ] Light theme: verify surfaces are crisp white on slate-50 background
- [ ] Sun/moon toggle: verify animation in both directions (light→dark, dark→light)
- [ ] Sun/moon toggle: verify `⌘T` shortcut still works
- [ ] Sun/moon toggle: verify `prefers-reduced-motion: reduce` disables animations
- [ ] Minimal mode tabs: with 3+ sessions, verify × buttons never overlap tab labels
- [ ] Minimal mode tabs: verify long session names truncate with ellipsis
- [ ] Minimal topbar: verify elevated surface background and consistent spacing
- [ ] Session sync: open in minimal mode, wait for sessions, switch to window mode — same sessions should appear
- [ ] Session sync: leave a session idle 5+ min — verify it gets pruned in both views
- [ ] Swift: verify window chrome colors match Cool Slate palette in both themes
- [ ] Theme persistence: refresh page, verify theme survives via localStorage
