# Minimal Mode Refresh Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh Loupe's theme to Cool Slate, replace the theme toggle with an animated sun/moon SVG, fix the tab/close-button overlap in minimal mode, and fix phantom sessions between popover/window views.

**Architecture:** Five independent changes to the vanilla JS/CSS/HTML frontend, the Node.js WebSocket server, and the Swift native wrapper. Each task produces a standalone commit. No build step — just edit source files and test in browser.

**Tech Stack:** Vanilla JS, CSS custom properties, HTML, Node.js (ws), Swift/WKWebView

**Spec:** `docs/superpowers/specs/2026-03-30-minimal-mode-refresh-design.md`

---

## File Map

| File | Changes |
|---|---|
| `src/ui/styles.css` | Update `:root` dark vars, `[data-theme="light"]` light vars, replace `.theme-switch`/`.theme-slider` with `.theme-toggle`/`.sun-and-moon` rules, add minimal tab overrides, update `.minimal-topbar`, add compact pin toggle |
| `src/ui/index.html` | Replace both `<label class="theme-switch">` blocks with `<button class="theme-toggle">` SVG buttons |
| `src/ui/app.js` | Update theme toggle JS (checkbox → button), wrap tab labels in `<span class="tab-label">`, add `pruneSessionTab()`, handle `sessions`/`session_remove` messages |
| `src/server/index.js` | Add session tracking Map, extract session_id/label from log lines, send `sessions` message on connect, broadcast `session_remove` on prune |
| `native/app.swift` | Update NSColor values for Cool Slate dark/light backgrounds |

---

### Task 1: Cool Slate Color Palette (CSS)

**Files:**
- Modify: `src/ui/styles.css:4-31` (`:root` dark theme variables)
- Modify: `src/ui/styles.css:799-820` (`[data-theme="light"]` variables)

- [ ] **Step 1: Update dark theme `:root` variables**

In `src/ui/styles.css`, replace lines 4-31:

```css
:root {
  --bg: #0f172a;
  --surface: #1e293b;
  --surface-hover: #334155;
  --border: #475569;
  --border-light: #334155;
  --text: #f1f5f9;
  --text-muted: #94a3b8;
  --text-subtle: #64748b;
  --text-ghost: #526280;
  --text-dim: #475569;

  --accent: #8b5cf6;
  --accent-dim: rgba(139, 92, 246, 0.12);
  --accent-glow: rgba(139, 92, 246, 0.3);

  --blue: #3b82f6;
  --blue-dim: rgba(59, 130, 246, 0.08);
  --green: #4ade80;
  --red: #ef4444;
  --red-dim: rgba(239, 68, 68, 0.06);
  --result: #a1a1aa;
  --result-dim: rgba(161, 161, 170, 0.05);

  --font-mono: "SF Mono", "JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace;
  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --radius: 6px;
}
```

- [ ] **Step 2: Update light theme `[data-theme="light"]` variables**

Replace the light theme variable block (lines 799-821):

```css
[data-theme="light"],
[data-theme="light"] body {
  --bg: #f8fafc;
  --surface: #ffffff;
  --surface-hover: #f1f5f9;
  --border: #cbd5e1;
  --border-light: #e2e8f0;
  --text: #0f172a;
  --text-muted: #475569;
  --text-subtle: #94a3b8;
  --text-ghost: #94a3b8;
  --text-dim: #cbd5e1;
  --accent: #7c3aed;
  --accent-dim: rgba(124, 58, 237, 0.08);
  --accent-glow: rgba(124, 58, 237, 0.15);
  --blue: #2563eb;
  --blue-dim: rgba(37, 99, 235, 0.06);
  --green: #16a34a;
  --red: #dc2626;
  --red-dim: rgba(220, 38, 38, 0.06);
  --result: #64748b;
  --result-dim: rgba(100, 116, 139, 0.05);
}
```

- [ ] **Step 3: Update light mode grid layout background (consistency fix, not in spec)**

The current light grid-layout background `#c8c8d4` matches the old `--border` value. Update to match the new Cool Slate `--border` (`#cbd5e1`) for consistency:

In `src/ui/styles.css`, find the light grid-layout selector (line 382-384) and update:

```css
[data-theme="light"] .pane-container.grid-layout {
  background: #cbd5e1;
}
```

- [ ] **Step 4: Test in browser**

Open `http://localhost:8390` — verify:
- Dark theme has blue-tinted backgrounds (not neutral gray)
- Toggle to light — verify crisp white surfaces on slate-50 bg
- All text is readable in both themes
- Category colors (cyan, green, purple, red borders) still look correct
- Modal, filter menu, help overlay all render properly in both themes

- [ ] **Step 5: Commit**

```bash
git add src/ui/styles.css
git commit -m "feat: update color palette to Cool Slate (dark + light)"
```

---

### Task 2: Sun/Moon Theme Toggle (HTML + CSS + JS)

**Files:**
- Modify: `src/ui/index.html:14-17` (header theme switch)
- Modify: `src/ui/index.html:30-33` (minimal topbar theme switch)
- Modify: `src/ui/styles.css:751-796` (remove old `.theme-switch` rules, add new `.theme-toggle` + `.sun-and-moon` rules)
- Modify: `src/ui/app.js:1106-1140` (theme toggle JS)
- Modify: `src/ui/app.js:1199-1241` (minimal topbar controls)

- [ ] **Step 1: Replace header theme switch HTML**

In `src/ui/index.html`, replace lines 14-17:

```html
<!-- Old -->
<label class="theme-switch" title="Toggle theme (⌘T)">
  <input type="checkbox" id="theme-toggle">
  <span class="theme-slider"></span>
</label>
```

With:

```html
<button id="theme-toggle" class="theme-toggle" title="Toggle theme (⌘T)" aria-label="Switch to light theme">
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

- [ ] **Step 2: Replace minimal topbar theme switch HTML**

In `src/ui/index.html`, replace lines 30-33:

```html
<!-- Old -->
<label class="theme-switch" title="Toggle theme (⌘T)">
  <input type="checkbox" id="theme-toggle-mini">
  <span class="theme-slider"></span>
</label>
```

With:

```html
<button id="theme-toggle-mini" class="theme-toggle" title="Toggle theme (⌘T)" aria-label="Switch to light theme">
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

- [ ] **Step 3: Replace CSS theme switch rules with sun/moon styles**

In `src/ui/styles.css`, remove lines 751-796 (the entire `/* ===== Theme Switch ===== */` section including `.theme-switch`, `.theme-switch input`, `.theme-slider`, `.theme-slider:before`, `.theme-switch input:checked + .theme-slider:before`).

Replace with:

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

- [ ] **Step 4: Update theme toggle JS in app.js**

Replace the theme toggle section (lines 1105-1140) with:

```js
// ===== Theme toggle =====
const themeBtn = document.getElementById("theme-toggle");
const themeBtnMini = document.getElementById("theme-toggle-mini");

function toggleTheme() {
  const current = document.documentElement.dataset.theme || "dark";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("loupe-theme", theme);
  // Update aria-labels
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  if (themeBtn) themeBtn.setAttribute("aria-label", label);
  if (themeBtnMini) themeBtnMini.setAttribute("aria-label", label);
  // Notify native macOS app to update window chrome
  if (window.webkit?.messageHandlers?.themeChange) {
    window.webkit.messageHandlers.themeChange.postMessage(theme);
  }
}

// Set initial state and bind click
if (themeBtn) {
  themeBtn.addEventListener("click", (e) => { e.preventDefault(); toggleTheme(); });
  const initialTheme = document.documentElement.dataset.theme || "dark";
  if (window.webkit?.messageHandlers?.themeChange) {
    window.webkit.messageHandlers.themeChange.postMessage(initialTheme);
  }
}
```

- [ ] **Step 5: Update minimal topbar theme toggle JS**

In the minimal topbar controls section (lines 1199-1241), remove the `miniThemeToggle` checkbox block (lines 1229-1240). Replace with:

```js
if (themeBtnMini) {
  themeBtnMini.addEventListener("click", (e) => { e.preventDefault(); toggleTheme(); });
}
```

Also remove the now-unused `miniThemeToggle` declaration at line 1203:
```js
// REMOVE this line:
const miniThemeToggle = document.getElementById("theme-toggle-mini");
```

Note: `themeBtnMini` is already declared at the top of the file (Step 4), so the click binding above is all that's needed.

- [ ] **Step 6: Test in browser**

- Click the sun/moon icon in the header — verify it toggles between sun (light) and crescent moon (dark) with smooth animation
- Press `⌘T` — verify keyboard shortcut still works
- Open `?mode=minimal` — verify the smaller toggle (18px) works in the minimal topbar
- Refresh page — verify theme persists via localStorage
- Test with reduced motion preference — verify no animations

- [ ] **Step 7: Commit**

```bash
git add src/ui/index.html src/ui/styles.css src/ui/app.js
git commit -m "feat: replace checkbox theme toggle with animated sun/moon SVG"
```

---

### Task 3: Minimal Mode Tab Bar Fix (CSS + JS)

**Files:**
- Modify: `src/ui/styles.css` (add `body.minimal` tab overrides after line 208)
- Modify: `src/ui/app.js:913` (wrap tab label in `<span class="tab-label">`)

- [ ] **Step 1: Add minimal-mode tab CSS**

In `src/ui/styles.css`, after the `.tab-close:hover` rule (line 208), add:

```css
/* Minimal mode tab overrides */
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

- [ ] **Step 2: Wrap tab label text in span**

In `src/ui/app.js`, line 913, change the `tab.innerHTML` assignment from:

```js
tab.innerHTML = `${esc(info.label)}${shortcut}${staleLabel}<span class="tab-dot"></span><button class="tab-close" title="Remove">&times;</button>`;
```

To:

```js
tab.innerHTML = `<span class="tab-label">${esc(info.label)}</span>${shortcut}${staleLabel}<span class="tab-dot"></span><button class="tab-close" title="Remove">&times;</button>`;
```

- [ ] **Step 3: Test in browser**

Open `http://localhost:8390/?mode=minimal` with 3+ active sessions:
- Verify tab labels truncate with ellipsis at 80px max
- Verify × buttons never overlap tab text
- Verify clicking × still removes the session
- Verify activity dots still show up
- Open in full mode (`http://localhost:8390`) — verify tabs look identical to before (no visual regression)

- [ ] **Step 4: Commit**

```bash
git add src/ui/styles.css src/ui/app.js
git commit -m "fix: tab label/close button overlap in minimal mode"
```

---

### Task 4: Minimal Topbar Polish + Swift Background Colors

**Files:**
- Modify: `src/ui/styles.css:947-955` (`.minimal-topbar` background, gap, padding)
- Modify: `src/ui/styles.css` (add compact pin toggle rules after `.pin-toggle-knob` rules)
- Modify: `native/app.swift:19-21` (`themeChange` handler colors)
- Modify: `native/app.swift:68-69` (initial panel appearance colors)
- Modify: `native/app.swift:191-192` (window appearance colors)

- [ ] **Step 1: Update minimal topbar CSS**

In `src/ui/styles.css`, replace the `.minimal-topbar` rule (lines 947-955):

```css
.minimal-topbar {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  background: var(--surface);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}
```

- [ ] **Step 2: Add compact pin toggle rules for minimal mode**

After the `.pin-toggle.pinned .pin-toggle-knob { left: 14px; }` rule (line 944), add:

```css
/* Compact pin toggle for minimal mode */
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

- [ ] **Step 3: Update Swift native background colors**

In `native/app.swift`, update the `themeChange` handler (around line 19-21):

```swift
let bgColor = theme == "light"
    ? NSColor(red: 248.0/255, green: 250.0/255, blue: 252.0/255, alpha: 1.0)
    : NSColor(red: 15.0/255, green: 23.0/255, blue: 42.0/255, alpha: 1.0)
```

Update the initial panel setup (around line 69):

```swift
popoverPanel.backgroundColor = NSColor(red: 15.0/255, green: 23.0/255, blue: 42.0/255, alpha: 1.0)
```

Update the window setup (around line 192):

```swift
w.backgroundColor = NSColor(red: 15.0/255, green: 23.0/255, blue: 42.0/255, alpha: 1.0)
```

- [ ] **Step 4: Recompile Swift app**

```bash
cd /Users/tomyang/pal/logstream
# Check existing build command
head -20 scripts/install.sh
```

Run the Swift compile command from the install script to rebuild the native app.

- [ ] **Step 5: Test**

- Launch Loupe native app — verify the window chrome matches Cool Slate dark bg (#0f172a)
- Toggle to light — verify window chrome updates to #f8fafc
- In minimal mode — verify topbar has elevated surface background
- Verify pin toggle is slightly smaller but still functional
- Verify spacing is consistent (8px gap, 10px horizontal padding)

- [ ] **Step 6: Commit**

```bash
git add src/ui/styles.css native/app.swift
git commit -m "feat: polish minimal topbar and update Swift native bg colors"
```

---

### Task 5: Session Sync Fix (Server + Client)

**Files:**
- Modify: `src/server/index.js` (add session tracking, `sessions` message, `session_remove` broadcast)
- Modify: `src/ui/app.js` (handle `sessions` and `session_remove` messages, add `pruneSessionTab()`)

- [ ] **Step 1: Add server-side session tracking**

In `src/server/index.js`, after the dedup section (line 71) and before the file tailing section, add:

```js
// --- Session tracking ---
const knownSessions = new Map(); // sessionId -> { label, lastEventTs }

function extractSessionFromLine(line) {
  try {
    const obj = JSON.parse(line);
    // Unwrap hook envelope if present
    const inner = (obj._logstream_type && obj.data) ? obj.data : obj;
    const sessionId = inner.session_id;
    if (!sessionId) return null;
    // Extract label from cwd (last path segment)
    const cwd = inner.cwd;
    let label = sessionId.slice(0, 8);
    if (cwd) {
      const parts = cwd.split("/");
      label = parts[parts.length - 1] || parts[parts.length - 2] || cwd;
    }
    return { id: sessionId, label };
  } catch {
    return null;
  }
}

function trackSession(line) {
  const info = extractSessionFromLine(line);
  if (!info) return;
  knownSessions.set(info.id, { label: info.label, lastEventTs: Date.now() });
}

function getSessionsList() {
  return [...knownSessions.entries()].map(([id, info]) => ({ id, label: info.label }));
}

// Prune sessions with no events for 5+ minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, info] of knownSessions) {
    if (info.lastEventTs < cutoff) {
      knownSessions.delete(id);
      broadcast(JSON.stringify({ type: "session_remove", id }));
    }
  }
}, 30000);
```

- [ ] **Step 2: Track sessions from incoming lines**

In the `readNewBytes()` function, inside the line processing loop (around line 105-109), add session tracking before broadcast:

```js
for (const line of lines) {
  if (line.trim() === "") continue;
  const msg = buildMessage(line);
  if (msg.json && isDuplicateThinking(msg.json)) continue;
  trackSession(line);  // <-- add this line
  broadcast(JSON.stringify(msg));
}
```

- [ ] **Step 3: Track sessions from backlog and send sessions message**

In the `sendBacklog()` function, track sessions from backlog lines, and send a `sessions` message after `backlog_done`:

After the line `ws.send(JSON.stringify({ type: "backlog_done" }));` (line 188), add:

```js
// Also track sessions from backlog for new clients
for (const line of backlog) {
  trackSession(line);
}
// Send current session list
ws.send(JSON.stringify({ type: "sessions", list: getSessionsList() }));
```

Note: Track from the original `backlog` lines (not truncated), since session info lives in the outer envelope.

- [ ] **Step 4: Add client-side session message handlers**

In `src/ui/app.js`, in the `ws.onmessage` handler (around line 396-399), add handlers for the new message types:

```js
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "reset") { resetAll(); return; }
  if (msg.type === "backlog_done") { scrollToBottom(); return; }
  if (msg.type === "sessions") { reconcileSessions(msg.list); return; }
  if (msg.type === "session_remove") { pruneSessionTab(msg.id); return; }
  if (msg.type === "line") handleLine(msg);
};
```

- [ ] **Step 5: Add `pruneSessionTab()` and `reconcileSessions()` functions**

In `src/ui/app.js`, after the `removeSession()` function (line 957), add:

```js
function pruneSessionTab(id) {
  sessions.delete(id);
  sessionOrder = sessionOrder.filter(s => s !== id);
  if (activeSession === id) activeSession = "all";
  rebuildTabs();
  rebuildView();
}

function reconcileSessions(serverList) {
  const serverIds = new Set(serverList.map(s => s.id));
  let changed = false;
  // Remove local sessions not in server's list (batch — no rebuild per removal)
  for (const id of [...sessions.keys()]) {
    if (!serverIds.has(id)) {
      sessions.delete(id);
      sessionOrder = sessionOrder.filter(s => s !== id);
      if (activeSession === id) activeSession = "all";
      changed = true;
    }
  }
  // Add missing sessions from server
  for (const s of serverList) {
    if (!sessions.has(s.id)) {
      sessions.set(s.id, { label: s.label, count: 0, color: nextSessionColor(), lastEventTs: null });
      changed = true;
    }
  }
  if (changed) {
    rebuildTabs();
    rebuildView();
  }
}
```

- [ ] **Step 6: Test session sync**

This requires the native app or two browser windows:
1. Open `http://localhost:8390/?mode=minimal` — wait for sessions to appear
2. Open `http://localhost:8390` in another tab — verify the same sessions appear
3. Let a session go idle for 5+ minutes — verify it gets pruned from both views
4. Close a session tab in one view — the other view should reconcile on next reconnect

- [ ] **Step 7: Commit**

```bash
git add src/server/index.js src/ui/app.js
git commit -m "fix: sync sessions between popover and window views"
```

---

## Verification Checklist

After all tasks are complete, run through the full testing matrix from the spec:

- [ ] Dark theme: blue-tinted Cool Slate backgrounds
- [ ] Light theme: crisp white on slate-50
- [ ] Sun/moon toggle: smooth animation both directions
- [ ] `⌘T` shortcut: still works
- [ ] `prefers-reduced-motion: reduce`: no animations
- [ ] Minimal tabs: × buttons never overlap labels (3+ sessions)
- [ ] Minimal tabs: long names truncate with ellipsis
- [ ] Minimal topbar: elevated surface background, consistent spacing
- [ ] Session sync: same sessions in both views
- [ ] Session prune: idle sessions removed after 5 min
- [ ] Swift: window chrome matches Cool Slate
- [ ] Theme persistence: survives page refresh
