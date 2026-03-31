# 2D Universe Map — Design Spec

**Date:** 2026-03-31
**Goal:** Revert to 2D Canvas rendering with universe aesthetic, add edge hover labels, support light/dark mode.

## Approach

Restore `gravity.js` from git as the base. Reskin with universe visuals. Add edge hover feature. Remove Three.js 3D code.

## Visual Design

### Dark Mode (background: #050510)
- **Star field:** 3 layers of dots on canvas (small/dim far, medium mid, bright near) with color temperature variation (white, blue-white, warm white, amber)
- **Nebula:** 2-3 soft radial gradient blobs painted behind nodes
- **Nodes:** Star classification by importance — Red Dwarf (#ff6b4a), Orange Dwarf (#ff9f43), Yellow Star (#ffd93d), White Star (#f0f0ff), Blue Giant (#7eb8ff). Radial gradient glow. Size 3-20px.
- **Edges:** Color by type (prerequisite purple, coupling orange, validation green, discovery blue, sequential gray). Low default opacity.

### Light Mode (background: #f0f1f5)
- **Star field:** Subtle gray dots at lower opacity
- **Nebula:** Faint pastel washes
- **Nodes:** Same classification colors but slightly muted. Halos are softer.
- **Edges:** Darker lines on light background, higher base opacity.

### Edge Hover Labels
- Hit detect: mouse within ~8px of edge line segment
- Show label at edge midpoint: "Read → Edit", "Edit → Edit", etc.
- Styled as small tooltip (glassmorphic dark, or light bg in light mode)
- Appears/disappears with 200ms transition

### Filter Bar
- All / Read / Edit / Exec buttons (kept from current HTML)
- Non-matching nodes fade to 10% opacity, matching stay full

## Files Changed
- Restore: `src/ui/gravity.js` (from git, then modify)
- Delete: `src/ui/universe.js`
- Modify: `src/ui/index.html` (remove Three.js addons, restore gravity.js script)
- Modify: `src/ui/app.js` (restore Gravity.* calls, wire filter)
- Modify: `src/ui/styles.css` (keep filter bar + tooltip styles)
