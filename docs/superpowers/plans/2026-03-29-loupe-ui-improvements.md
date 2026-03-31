# Loupe UI Improvements Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Loupe's visual design: lift dark theme, add light mode, fix timestamp gap, add filter toggle-back, differentiate Use/Think colors.

**Architecture:** All changes are in the frontend layer (vanilla JS/HTML/CSS). CSS variables drive theming; `[data-theme="light"]` overrides handle light mode. No server changes needed.

**Tech Stack:** Vanilla JS, CSS custom properties, HTML, localStorage

**Spec:** `docs/superpowers/specs/2026-03-29-loupe-ui-improvements-design.md`

---

## File Map

| File | Role | Changes |
|---|---|---|
| `src/ui/styles.css` | All styling | Lift dark palette, add `[data-theme="light"]` block, entry-row max-width, cyan tool_use colors |
| `src/ui/app.js` | Client logic | Theme toggle function, keyboard shortcut, filter label toggle, FILTER_TYPES cyan color, help overlay update |
| `src/ui/index.html` | HTML shell | Theme toggle button in header |

---

### Task 1: Lift dark theme palette

**Files:**
- Modify: `src/ui/styles.css:4-31` (`:root` variables)

- [ ] **Step 1: Update `:root` CSS variables**

In `styles.css`, replace the 7 variables in `:root`:

```css
/* Before → After */
--bg: #09090b;            /* → */ --bg: #16161a;
--surface: #18181b;       /* → */ --surface: #1e1e24;
--surface-hover: #1e1e22; /* → */ --surface-hover: #26262e;
--border: #27272a;        /* → */ --border: #2e2e36;
--border-light: #1a1a1e;  /* → */ --border-light: #222228;
--text-dim: #52525b;      /* → */ --text-dim: #6b6b78;
--text-ghost: #636370;    /* → */ --text-ghost: #7a7a88;
```

All other `:root` variables remain unchanged.

- [ ] **Step 2: Visual check**

Run: `cd /Users/tomyang/pal/logstream && node src/server/index.js`
Open in browser. Verify the background is noticeably lighter than before but still clearly dark. Text should be more readable.

- [ ] **Step 3: Commit**

```bash
git add src/ui/styles.css
git commit -m "style: lift dark theme palette to softer tones"
```

---

### Task 2: Tool Use color — blue to cyan

**Files:**
- Modify: `src/ui/styles.css:468,491,576` (hardcoded tool_use colors)
- Modify: `src/ui/app.js:605` (FILTER_TYPES color)

- [ ] **Step 1: Update CSS hardcoded tool_use colors**

In `styles.css`, change these 3 rules:

```css
/* Line 468: entry border */
.log-entry[data-category="tool_use"] { border-left-color: #06b6d4; }

/* Line 491: badge text */
.entry-badge.cat-tool_use { color: #22d3ee; }

/* Line 576: modal badge */
.modal-badge.cat-tool_use { color: #22d3ee; background: rgba(6,182,212,0.12); }
```

- [ ] **Step 2: Update JS FILTER_TYPES color**

In `app.js` line 605, change the tool_use color:

```js
// Before:
{ key: "tool_use", label: "Tool Use", color: "#3b82f6" },
// After:
{ key: "tool_use", label: "Tool Use", color: "#06b6d4" },
```

- [ ] **Step 3: Visual check**

Reload the app. Verify tool_use entries have a cyan border-left and badge, clearly distinct from thinking entries (violet).

- [ ] **Step 4: Commit**

```bash
git add src/ui/styles.css src/ui/app.js
git commit -m "style: change tool_use color from blue to cyan for distinction from thinking"
```

---

### Task 3: Entry row max-width

**Files:**
- Modify: `src/ui/styles.css:475-480` (`.entry-row` rule)

- [ ] **Step 1: Add max-width to `.entry-row`**

In `styles.css`, add `max-width: 1200px;` to the `.entry-row` rule:

```css
.entry-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
  max-width: 1200px;
}
```

- [ ] **Step 2: Visual check**

Resize the window very wide (>1400px). Verify the timestamp stays close to the summary text, and the hover background + border-left still span the full width of the entry.

- [ ] **Step 3: Commit**

```bash
git add src/ui/styles.css
git commit -m "style: cap entry-row width at 1200px to keep timestamp near content"
```

---

### Task 4: Filter label toggle-back

**Files:**
- Modify: `src/ui/app.js:641-648` (label.onclick in `buildFilterMenu`)

- [ ] **Step 1: Update label.onclick handler**

In `app.js`, replace the `label.onclick` handler inside `buildFilterMenu()` (lines 641-648):

```js
// Before:
label.onclick = (e) => {
  e.stopPropagation();
  hiddenTypes.clear();
  FILTER_TYPES.forEach(t => { if (t.key !== ft.key) hiddenTypes.add(t.key); });
  buildFilterMenu();
  updateFilterLabel();
  rebuildView();
};

// After:
label.onclick = (e) => {
  e.stopPropagation();
  const isAlreadySolo = hiddenTypes.size === FILTER_TYPES.length - 1 && !hiddenTypes.has(ft.key);
  if (isAlreadySolo) {
    hiddenTypes.clear();
  } else {
    hiddenTypes.clear();
    FILTER_TYPES.forEach(t => { if (t.key !== ft.key) hiddenTypes.add(t.key); });
  }
  buildFilterMenu();
  updateFilterLabel();
  rebuildView();
};
```

- [ ] **Step 2: Manual test**

1. Open filter dropdown, click "Thinking" label → only thinking entries shown, trigger says "Thinking"
2. Click "Thinking" label again → all entries shown, trigger says "All types"
3. Click "Error" label → only errors shown
4. Click "Tool Use" label → only tool_use shown (switches, not reset)
5. Verify `e` keyboard shortcut still works independently

- [ ] **Step 3: Commit**

```bash
git add src/ui/app.js
git commit -m "feat: filter label click toggles back to show-all when already isolated"
```

---

### Task 5: Light mode — CSS

**Files:**
- Modify: `src/ui/styles.css` (add `[data-theme="light"]` block before the `@media (prefers-reduced-motion)` rule at end of file)

- [ ] **Step 1: Add the light theme CSS block**

Insert before the `@media (prefers-reduced-motion)` rule (before line 749). This is one large CSS block:

```css
/* ===== Light Theme ===== */
[data-theme="light"],
[data-theme="light"] body {
  --bg: #f8f8fa;
  --surface: #ffffff;
  --surface-hover: #f0f0f4;
  --border: #d4d4dc;
  --border-light: #e4e4ea;
  --text: #1a1a2e;
  --text-muted: #4a4a5a;
  --text-subtle: #6b6b78;
  --text-ghost: #8a8a96;
  --text-dim: #9a9aa6;
  --accent: #7c3aed;
  --accent-dim: rgba(124, 58, 237, 0.08);
  --accent-glow: rgba(124, 58, 237, 0.15);
  --blue: #2563eb;
  --blue-dim: rgba(37, 99, 235, 0.06);
  --green: #16a34a;
  --red: #dc2626;
  --red-dim: rgba(220, 38, 38, 0.06);
  --result: #6b6b78;
  --result-dim: rgba(107, 107, 120, 0.05);
}

/* Light: entry border-left colors */
[data-theme="light"] .log-entry[data-category="tool_use"] { border-left-color: #0891b2; }
[data-theme="light"] .log-entry[data-category="tool_result"] { border-left-color: #16a34a; }
[data-theme="light"] .log-entry[data-category="error"] { border-left-color: #dc2626; background: rgba(220, 38, 38, 0.04); }
[data-theme="light"] .log-entry[data-category="thinking"] { border-left-color: #7c3aed; }
[data-theme="light"] .log-entry[data-category="text"] { border-left-color: #9a9aa6; }

/* Light: entry badge text colors */
[data-theme="light"] .entry-badge.cat-tool_use { color: #0891b2; }
[data-theme="light"] .entry-badge.cat-tool_result { color: #16a34a; }
[data-theme="light"] .entry-badge.cat-error { color: #dc2626; }
[data-theme="light"] .entry-badge.cat-thinking { color: #7c3aed; }
[data-theme="light"] .entry-badge.cat-text { color: #6b6b78; }

/* Light: modal badge colors */
[data-theme="light"] .modal-badge.cat-tool_use { color: #0891b2; background: rgba(8, 145, 178, 0.08); }
[data-theme="light"] .modal-badge.cat-tool_result { color: #16a34a; background: rgba(22, 163, 74, 0.06); }
[data-theme="light"] .modal-badge.cat-error { color: #dc2626; background: rgba(220, 38, 38, 0.06); }
[data-theme="light"] .modal-badge.cat-thinking { color: #7c3aed; background: rgba(124, 58, 237, 0.06); }
[data-theme="light"] .modal-badge.cat-text { color: #6b6b78; background: rgba(107, 107, 120, 0.04); }

/* Light: JSON syntax colors */
[data-theme="light"] .modal-code .json-key { color: #2563eb; }
[data-theme="light"] .modal-code .json-string { color: #16a34a; }
[data-theme="light"] .modal-code .json-number { color: #b45309; }
[data-theme="light"] .modal-code .json-bool { color: #7c3aed; }

/* Light: search highlight */
[data-theme="light"] mark { background: rgba(250, 204, 21, 0.4); }

/* Light: box shadows */
[data-theme="light"] .filter-menu { box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1); }
[data-theme="light"] .modal-panel { box-shadow: 0 24px 64px rgba(0, 0, 0, 0.15); }
[data-theme="light"] .help-panel { box-shadow: 0 16px 48px rgba(0, 0, 0, 0.1); }

/* Light: overlays */
[data-theme="light"] .modal-overlay { background: rgba(0, 0, 0, 0.3); backdrop-filter: blur(4px); }
[data-theme="light"] #help-overlay { background: rgba(0, 0, 0, 0.2); backdrop-filter: blur(4px); }
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/styles.css
git commit -m "style: add light theme CSS overrides"
```

---

### Task 6: Light mode — HTML toggle button

**Files:**
- Modify: `src/ui/index.html:13-16` (header `.stats` div)

- [ ] **Step 1: Add theme toggle button**

In `index.html`, add the button as the first child of the `.stats` div (before the connection status span):

```html
<!-- Before: -->
    <div class="stats">
      <span><span class="conn-dot connecting" id="conn-dot"></span><span id="conn-status">connecting</span></span>

<!-- After: -->
    <div class="stats">
      <button class="btn btn-sm theme-toggle" id="theme-toggle" title="Toggle theme (T)">&#9789;</button>
      <span><span class="conn-dot connecting" id="conn-dot"></span><span id="conn-status">connecting</span></span>
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/index.html
git commit -m "feat: add theme toggle button to header"
```

---

### Task 7: Light mode — JS logic

**Files:**
- Modify: `src/ui/app.js` (top of file for init, new `toggleTheme` function, keyboard handler, help overlay)

- [ ] **Step 1: Add theme init at top of app.js**

Insert after line 1 (`"use strict";`), before line 3 (`// ===== State =====`):

```js
// ===== Theme =====
(function initTheme() {
  const saved = localStorage.getItem("loupe-theme") || "dark";
  document.documentElement.dataset.theme = saved;
})();
```

- [ ] **Step 2: Add toggleTheme function and button wiring**

Insert after the `connect();` call at the bottom of app.js (after line 926), before the end of file:

```js
// ===== Theme toggle =====
const themeToggle = document.getElementById("theme-toggle");

function toggleTheme() {
  const current = document.documentElement.dataset.theme || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("loupe-theme", next);
  if (themeToggle) themeToggle.innerHTML = next === "dark" ? "&#9789;" : "&#9788;";
}

// Set initial icon
if (themeToggle) {
  themeToggle.innerHTML = (document.documentElement.dataset.theme || "dark") === "dark" ? "&#9789;" : "&#9788;";
  themeToggle.addEventListener("click", toggleTheme);
}
```

- [ ] **Step 3: Add `T` keyboard shortcut**

In the `keydown` handler (around line 874), add after the `if (e.key === "?" && !inSearch)` line:

```js
  if (e.key === "T" && !inSearch) { toggleTheme(); return; }
```

Note: uppercase `T` (shift+t) to avoid conflicts. Must be placed after the modal-open check and before the `inSearch` return.

- [ ] **Step 4: Add `T` to help overlay**

In the `toggleHelp()` function, add a new row in the Actions section (after the `e` row):

```html
<div class="help-row"><kbd>T</kbd> <span>Toggle theme</span></div>
```

Find this in the template string inside `toggleHelp()`:
```js
            <div class="help-row"><kbd>e</kbd> <span>Toggle errors</span></div>
```
Add after it:
```js
            <div class="help-row"><kbd>T</kbd> <span>Toggle theme</span></div>
```

- [ ] **Step 5: Manual test**

1. Load app — should be dark theme (default)
2. Click moon icon in header → switches to light mode, icon becomes sun
3. Press `T` → switches back to dark, icon becomes moon
4. Refresh page → theme persists from localStorage
5. Press `?` → help overlay shows `T` under Actions
6. In light mode, verify: backgrounds are light, text is dark, entry colors are readable, modal looks correct, JSON syntax colors are visible

- [ ] **Step 6: Commit**

```bash
git add src/ui/app.js
git commit -m "feat: add light/dark theme toggle with T shortcut and localStorage persistence"
```

---

### Task 8: Final integration test

- [ ] **Step 1: Full visual pass — dark mode**

1. Launch app with `node src/server/index.js`
2. Trigger some Claude Code events (or use existing log data)
3. Verify: lifted dark background, cyan tool_use, violet thinking, all 5 badge colors distinct
4. Widen window past 1400px — timestamp stays near text
5. Filter dropdown: click label to isolate, click again to show all

- [ ] **Step 2: Full visual pass — light mode**

1. Press `T` to switch to light mode
2. Verify: white/light-gray background, all entry borders visible, badges readable
3. Open a detail modal — check JSON syntax colors (blue keys, green strings, amber numbers, violet bools)
4. Search for text — yellow highlight is visible
5. Filter dropdown works same as dark mode

- [ ] **Step 3: Edge cases**

1. Clear localStorage, refresh — defaults to dark
2. Set `localStorage.setItem("loupe-theme", "light")`, refresh — starts in light mode with sun icon
3. Resize window from narrow to very wide — timestamp gap stays reasonable
4. Toggle theme while modal is open — colors update correctly
