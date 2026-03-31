# Loupe UI Improvements

**Date:** 2026-03-29
**Status:** Approved
**Files affected:** `src/ui/styles.css`, `src/ui/app.js`, `src/ui/index.html`

---

## Problem

1. The app is too dark — base background `#09090b` feels oppressive, text colors are overly dimmed.
2. On wide windows, timestamps float far from log content due to `margin-left: auto` stretching across the full width.
3. No light mode option.
4. The type filter label click is one-way — clicking a label isolates that type, but clicking again doesn't return to "show all."
5. Tool Use (blue `#3b82f6`) and Thinking (violet `#8b5cf6`) colors are too similar.

---

## Changes

### 1. Lifted dark theme

Shift `:root` CSS variables to softer tones:

| Variable | Before | After |
|---|---|---|
| `--bg` | `#09090b` | `#16161a` |
| `--surface` | `#18181b` | `#1e1e24` |
| `--surface-hover` | `#1e1e22` | `#26262e` |
| `--border` | `#27272a` | `#2e2e36` |
| `--border-light` | `#1a1a1e` | `#222228` |
| `--text-dim` | `#52525b` | `#6b6b78` |
| `--text-ghost` | `#636370` | `#7a7a88` |

All other variables (`--text`, `--text-muted`, `--text-subtle`, `--accent`, `--green`, `--red`) stay unchanged.

### 2. Light mode

**CSS:** Add `[data-theme="light"]` selector on `<html>` overriding all CSS variables and hardcoded colors:

**Variable overrides:**

| Variable | Light value |
|---|---|
| `--bg` | `#f8f8fa` |
| `--surface` | `#ffffff` |
| `--surface-hover` | `#f0f0f4` |
| `--border` | `#d4d4dc` |
| `--border-light` | `#e4e4ea` |
| `--text` | `#1a1a2e` |
| `--text-muted` | `#4a4a5a` |
| `--text-subtle` | `#6b6b78` |
| `--text-ghost` | `#8a8a96` |
| `--text-dim` | `#9a9aa6` |
| `--accent` | `#7c3aed` |
| `--accent-dim` | `rgba(124, 58, 237, 0.08)` |
| `--accent-glow` | `rgba(124, 58, 237, 0.15)` |
| `--blue` | `#2563eb` |
| `--blue-dim` | `rgba(37, 99, 235, 0.06)` |
| `--green` | `#16a34a` |
| `--red` | `#dc2626` |
| `--red-dim` | `rgba(220, 38, 38, 0.06)` |
| `--result` | `#6b6b78` |
| `--result-dim` | `rgba(107, 107, 120, 0.05)` |

**Hardcoded color overrides in `[data-theme="light"]`:**

Entry border-left colors (darker for light bg contrast):
- `[data-category="tool_use"]` border-left: `#0891b2` (darker cyan)
- `[data-category="tool_result"]` border-left: `#16a34a` (darker green)
- `[data-category="error"]` border-left: `#dc2626`, background: `rgba(220, 38, 38, 0.04)`
- `[data-category="thinking"]` border-left: `#7c3aed` (darker violet)
- `[data-category="text"]` border-left: `#9a9aa6`

Entry badge text colors (darker for readability):
- `.cat-tool_use`: `#0891b2`
- `.cat-tool_result`: `#16a34a`
- `.cat-error`: `#dc2626`
- `.cat-thinking`: `#7c3aed`
- `.cat-text`: `#6b6b78`

Modal badge colors (same darker tones, lighter backgrounds):
- `.cat-tool_use`: color `#0891b2`, bg `rgba(8, 145, 178, 0.08)`
- `.cat-tool_result`: color `#16a34a`, bg `rgba(22, 163, 74, 0.06)`
- `.cat-error`: color `#dc2626`, bg `rgba(220, 38, 38, 0.06)`
- `.cat-thinking`: color `#7c3aed`, bg `rgba(124, 58, 237, 0.06)`
- `.cat-text`: color `#6b6b78`, bg `rgba(107, 107, 120, 0.04)`

JSON syntax colors:
- `.json-number`: `#b45309` (amber-700, readable on white)
- `.json-string`: `#16a34a`
- `.json-key`: `#2563eb`
- `.json-bool`: `#7c3aed`

Search highlight: `mark` background: `rgba(250, 204, 21, 0.4)` (stronger yellow)

Box shadows (lighter):
- `.filter-menu`: `box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1)`
- `.modal-panel`: `box-shadow: 0 24px 64px rgba(0, 0, 0, 0.15)`
- `.help-panel`: `box-shadow: 0 16px 48px rgba(0, 0, 0, 0.1)`

Modal overlay (light only): `background: rgba(0, 0, 0, 0.3)`, `backdrop-filter: blur(4px)`. Dark mode keeps existing `rgba(0, 0, 0, 0.65)` / `blur(8px)`.
Help overlay (light only): `background: rgba(0, 0, 0, 0.2)`, `backdrop-filter: blur(4px)`. Dark mode keeps existing `rgba(0, 0, 0, 0.6)` / `blur(4px)`.

**HTML:** Add a theme toggle button in the header `.stats` div, as the first child (before the connection status span). Use a `<button>` with class `btn btn-sm theme-toggle`:

```html
<button class="btn btn-sm theme-toggle" id="theme-toggle" title="Toggle theme (T)">&#9789;</button>
```

Icon: `&#9789;` (crescent moon) when dark mode is active, `&#9788;` (sun) when light mode is active.

**JS:**
- `T` keyboard shortcut toggles theme (added to keydown handler, guarded against search focus).
- Theme stored in `localStorage` under key `loupe-theme` (`"light"` or `"dark"`).
- On page load (top of app.js), read from localStorage and apply `data-theme` attribute to `<html>`. Default to `"dark"` if no stored value. No `data-theme` attribute in static HTML — the `:root` variables handle dark mode without it, and JS sets it immediately on load.
- `toggleTheme()` function: flips `document.documentElement.dataset.theme`, updates localStorage, updates button icon.
- Add `T` to the help overlay under Actions: `<kbd>T</kbd> <span>Toggle theme</span>`.

**SESSION_COLORS (JS):** No change needed — these are used for session tab/pane dot colors only, which work on both light and dark backgrounds since they're small accent elements.

### 3. Entry row max-width

Add `max-width: 1200px` to `.entry-row` in CSS. Left-aligned (no centering). The `.log-entry` container stays full-width so border-left and hover background span the pane. Only the inner flex row is constrained to prevent the timestamp from drifting far from content.

### 4. Filter label toggle

In `buildFilterMenu()` in `app.js`, update the `label.onclick` handler:

```js
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

If the clicked type is already the only one shown, reset to show all. Otherwise, isolate as before.

Note: The `e` key shortcut has its own toggle heuristic (if nothing hidden, isolate errors; otherwise show all). This is intentionally different from the label toggle — `e` is a quick errors-only shortcut, label click is per-type isolation. No unification needed.

### 5. Tool Use color: blue to cyan

| Location | Before | After |
|---|---|---|
| `FILTER_TYPES` tool_use color (JS) | `#3b82f6` | `#06b6d4` |
| `.log-entry[data-category="tool_use"]` border-left (CSS) | `#3b82f6` | `#06b6d4` |
| `.entry-badge.cat-tool_use` color (CSS) | `#60a5fa` | `#22d3ee` |
| `.modal-badge.cat-tool_use` color (CSS) | `#60a5fa` | `#22d3ee` |
| `.modal-badge.cat-tool_use` background (CSS) | `rgba(59,130,246,0.12)` | `rgba(6,182,212,0.12)` |

The `--blue` CSS variable is unchanged in dark mode (used for JSON key highlighting in modals, unrelated to tool_use entry color). In light mode, `--blue` is overridden to `#2563eb` for better contrast on light backgrounds (see Section 2).

Light mode uses darker cyan variants for tool_use as specified in Section 2.

---

## Testing

- Verify dark theme looks lifted (not washed out) on both small and large windows.
- Toggle light mode via header icon and `T` shortcut; verify all elements are readable.
- In light mode, verify: entry badges, border-left colors, modal badges, JSON syntax colors, search highlights, box shadows, overlays all look correct.
- Refresh page and confirm theme persists via localStorage.
- Resize window wide and verify timestamp stays near content (max-width 1200px).
- In filter menu, click a label to isolate a type, click same label again to show all.
- Verify `e` shortcut still toggles errors independently of label click state.
- Verify tool_use entries are cyan and clearly distinguishable from thinking (violet) in both themes.
- Verify `T` appears in help overlay under Actions.
