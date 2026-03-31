# Universe Map — Design Spec

**Date:** 2026-03-31
**Status:** Approved
**Goal:** Replace the 2D Canvas + 3D-Force-Graph dual map with a single, custom Three.js universe visualization that feels like a deep space observatory.

---

## 1. Architecture

### What Changes

| Remove | Add |
|--------|-----|
| `gravity.js` (2D Canvas renderer, 27KB) | `universe.js` (unified Three.js renderer) |
| `gravity3d.js` (3D-Force-Graph wrapper, 7KB) | |
| `3D-Force-Graph` dependency | `three/examples/jsm/controls/OrbitControls` |
| `three-spritetext` dependency | `three/examples/jsm/postprocessing/*` (EffectComposer, UnrealBloomPass) |
| 2D/3D view toggle in UI | |

Keep: `Three.js` (rendering), `D3.js` (force simulation only).

### Module Structure

```
universe.js (main orchestrator)
├── Scene setup (WebGLRenderer, PerspectiveCamera, OrbitControls)
├── BackgroundLayer
│   ├── StarField (3 parallax layers, InstancedBufferGeometry points)
│   └── NebulaPlanes (2-3 semi-transparent fog planes)
├── NodeSystem
│   ├── InstancedMesh for star cores (custom ShaderMaterial)
│   ├── Corona glow (baked into fragment shader)
│   └── OrbitalSystem (for blue giant nodes, importance 26+)
├── EdgeSystem
│   ├── BufferGeometry with per-vertex opacity/color
│   └── Photon particles (small spheres animated along edges on hover)
├── ForceLayout (D3 force simulation → position updates)
├── Interaction (Raycaster, hover, click, camera fly-to)
└── HUD (HTML overlay for stats, filters, tooltips)
```

### Data Flow

Unchanged from current architecture. `app.js` calls `Universe.addEntry()` instead of `Gravity.addEntry()` + `Gravity3D.addEntry()`. The public API surface is identical — file path extraction, tool-to-action mapping, and edge building all stay in the same place.

### Data Structures (preserved from gravity.js)

- `nodes` Map: `{filepath → {id, label, dir, accessCount, readCount, editCount, execCount, lastAction, lastAccessTs, x, y, z, vx, vy, vz}}`
- `edges` Map: `{key → {source, target, type, weight, lastTs}}`
- `activeFiles` Map: `{filepath → timestamp}`
- `pulses` Array: `[{source, target, type, startTime, duration}]`

Only change: nodes gain `z, vz` for 3D positioning.

---

## 2. Visual Design

### 2.1 Mood

Deep space observatory — Hubble/JWST-like. Realistic star colors, muted nebula, understated elegance. The data is the star of the show; space is the quiet backdrop.

### 2.2 Node Rendering — Star Classification

Node importance = `editCount * 3 + execCount * 2 + readCount` (unchanged).

| Class | Importance | Core Size | Color | Corona | Notes |
|-------|-----------|-----------|-------|--------|-------|
| Red Dwarf | 1-3 | 0.8-1.2 units | `#ff6b4a` | Faint, 2x core radius | Barely touched files |
| Orange Dwarf | 4-8 | 1.5-2.0 units | `#ff9f43` | Visible, 2.5x core | Moderate activity |
| Yellow Star | 9-15 | 2.5-3.5 units | `#ffd93d` | Clear, 3x core | Frequently accessed |
| White Star | 16-25 | 4.0-5.0 units | `#f0f0ff` | Prominent, 3.5x core | Heavy use |
| Blue Giant | 26+ | 5.5-7.0 units | `#7eb8ff` | Intense, 4x core + orbital system | Core files |

**Corona shader:** Radial gradient baked into fragment shader. Opacity falls off with `exp(-distance)`. Color matches star class but at ~10-15% opacity.

**Recency overlay (applied on top of classification):**

| State | Condition | Effect |
|-------|-----------|--------|
| Active | < 30s since last access | Full brightness, subtle pulse animation (2s cycle) |
| Warm | < 2min | 70% brightness, steady |
| Stale | > 2min | 35% brightness, nearly dormant |
| Hidden | > 30min | Removed from scene |

### 2.3 Orbital Systems (Blue Giants only)

Files in the same directory as a Blue Giant node become its orbiters:
- Orbiters are small star dots (sized by their own importance) placed on circular orbit rings
- 1-3 orbit rings per system depending on orbiter count
- Rings are faint lines (8% opacity of the blue giant's color)
- Orbiters rotate slowly (12-30s per revolution, different speeds per ring)
- Orbiter color = their own action type color (green/orange/blue)
- Only triggered when a node crosses importance 26 AND has ≥2 same-directory neighbors

### 2.4 Edge Rendering

**Default state:** 5% opacity, 0.5px width. Nearly invisible.

**Edge colors (per-vertex, by relationship type):**

| Type | Color | When |
|------|-------|------|
| Prerequisite (Read→Edit) | `#8b5cf6` (purple) | File read then edited |
| Coupling (Edit→Edit) | `#f97316` (orange) | Two files edited in sequence |
| Validation (Edit→Run) | `#4ade80` (green) | File edited then executed |
| Discovery (Search→Read) | `#3b82f6` (blue) | File found via search |
| Sequential | `#475569` (gray) | Default sequential access |

**Hover reveal:** When a node is hovered, its connected edges transition to 25-35% opacity over 400ms. Unconnected nodes dim to 15% opacity.

**Photon particles:** On hover, small glowing spheres (2 unit radius) travel along revealed edges. Speed: 2000-2500ms per traversal. Smooth ease-in-out (`t² * (3 - 2t)`). Fade in at start, fade out at end.

**Click lock:** Clicking a node locks the hover state (connections stay revealed). Click empty space or press Escape to unlock.

### 2.5 Background

**Three parallax star layers (InstancedBufferGeometry points):**

| Layer | Count | Size Range | Opacity Range | Drift Speed | Twinkle |
|-------|-------|-----------|---------------|-------------|---------|
| Far | 800 | 0.3-0.8 units | 0.15-0.35 | 0.001x camera | 2% of stars |
| Mid | 200 | 0.6-1.2 units | 0.25-0.55 | 0.003x camera | 8% of stars |
| Near | 50 | 1.0-2.0 units | 0.5-0.85 | 0.008x camera | 20% of stars |

Star colors: 60% white, 20% blue-white (`#ccd4ff`), 10% warm white (`#ffe8c0`), 10% amber (`#ffcca0`).

Parallax: star layers shift proportionally to camera movement, creating depth perception. Far layer moves slowest, near layer fastest.

Twinkle: sinusoidal opacity oscillation (2.5-4s period, random phase offset).

**Nebula planes (2-3 PlaneGeometry with transparent gradient textures):**

| Nebula | Color | Size | Animation |
|--------|-------|------|-----------|
| Purple | `rgba(60, 40, 120, 0.12)` | 600×350 units | 25s breathe cycle, slight drift |
| Blue | `rgba(30, 60, 100, 0.10)` | 500×400 units | 30s breathe cycle |
| Red-brown | `rgba(80, 30, 50, 0.08)` | 400×250 units | 20s breathe cycle |

Breathing: slow scale oscillation (1.0-1.08x) with slight position drift. Opacity varies ±15% during cycle.

Nebula planes are placed at z-depths behind the data nodes but in front of the far star layer.

### 2.6 Labels

- Font: `SF Mono`, `JetBrains Mono`, Menlo, monospace
- Rendered as Three.js Sprite with CanvasTexture (not SpriteText dependency)
- Positioned below node in screen space
- Hidden by default. Shown on:
  - Hover (the hovered node + its connected neighbors)
  - Click (locked)
  - Always visible for nodes with importance ≥ 9 when zoom > 0.8
- Filename only by default. Directory shown on hover/click.
- Opacity matches node recency state

---

## 3. Camera & Navigation

### OrbitControls Configuration

- **Orbit:** Left-click drag to rotate around the scene center
- **Zoom:** Scroll wheel (min distance: 50 units, max: 800 units)
- **Pan:** Right-click drag to pan
- **Damping:** enabled (factor 0.08) for smooth deceleration

### Auto-Focus

- Camera smoothly drifts toward the weighted center of active files (accessed < 2min)
- Lerp factor: 0.05 per frame (same as current 2D implementation)
- Disabled when user manually orbits/pans (sets `userDragged = true`)
- Re-enabled on reset

### Fly-To

- Double-click a node: smooth 1000ms camera animation to that star
- Camera stops at `node position + 100 unit offset` along the camera's forward axis
- Uses cubic ease-in-out interpolation

### Semantic Zoom

| Zoom Level | Visible Nodes | Labels | Detail |
|-----------|---------------|--------|--------|
| Far (< 0.5) | Importance ≥ 5 only | None | Pure starscape, overview |
| Mid (0.5-0.8) | Importance ≥ 2 | Importance ≥ 15 | Working view |
| Close (> 0.8) | All | Importance ≥ 9 | Full detail, orbital systems visible |

### Reset

- Escape key or UI button
- Returns camera to default position `{x: 0, y: 0, z: 350}`
- Clears node selection
- Re-enables auto-focus

---

## 4. Filters

### Primary Filter Bar (always visible, top of viewport)

| Filter | Behavior |
|--------|----------|
| **All** | Show all nodes |
| **Read** | Show only nodes with readCount > 0 |
| **Edit** | Show only nodes with editCount > 0 |
| **Exec** | Show only nodes with execCount > 0 |

Non-matching nodes fade to 10% opacity (not hidden, so spatial context is preserved).

### Secondary Filters (collapsible panel)

**Recency:**
- Active (< 30s)
- Warm (< 2min)
- All (including stale)

**Directory:** Dynamic list based on directories present in the current session. Click to isolate.

### Filter rendering

Filtered-out nodes: opacity drops to 0.1, corona disabled, labels hidden. Edges connected to filtered-out nodes also drop to 0.02 opacity. This preserves the spatial layout while focusing attention.

---

## 5. Post-Processing

### EffectComposer Pipeline

1. **RenderPass** — standard scene render
2. **UnrealBloomPass** — selective bloom
   - Strength: 0.4
   - Radius: 0.6
   - Threshold: 0.7 (only bright objects bloom — star cores and active edges)
   - Background stars are below threshold, so they don't bloom
3. **Output** — to screen

### CSS Overlay Effects

- **Vignette:** CSS `box-shadow: inset 0 0 200px rgba(0,0,0,0.5)` on the canvas container. Cheaper than a shader pass, same visual result.

### What We're NOT Doing

- No chromatic aberration
- No film grain
- No depth of field
- No motion blur
- Keeping it clean and observatory-like

---

## 6. Performance

### Rendering Strategy

| Component | Technique | Draw Calls |
|-----------|-----------|-----------|
| Background stars | 3× InstancedBufferGeometry (Points) | 3 |
| Data node cores | 1× InstancedMesh (SphereGeometry) | 1 |
| Node coronas | Baked into core fragment shader | 0 (same mesh) |
| Edges | 1× BufferGeometry (LineSegments) | 1 |
| Nebula planes | 2-3× PlaneGeometry | 2-3 |
| Orbital rings | InstancedMesh per blue giant | 0-5 |
| Photon particles | Small InstancedMesh (only on hover) | 0-1 |
| Labels | Sprites (created on demand) | variable |
| **Total** | | **~10-15** |

### Update Strategy

- D3 force simulation: runs in `requestAnimationFrame`, writes positions to InstancedMesh instance matrices
- `instanceMatrix.needsUpdate = true` only when positions change
- Raycasting: throttled to mousemove events (not every frame)
- Edge opacity updates: only on hover state change (not every frame)
- Label creation: lazy, only when a node becomes visible at current zoom level

### Performance Target

- **60fps** on MacBook Pro (M-series) with 100+ file nodes
- **Fallback:** if average frame time exceeds 16ms over 30 frames:
  - Reduce background star count by 50%
  - Disable bloom pass
  - Reduce nebula count to 1

---

## 7. HUD (HTML Overlay)

All HUD elements are HTML positioned over the WebGL canvas. Not rendered in 3D.

### Stats (top-right corner)

```
{visible}/{total} files · {edges} connections · zoom {level}
```

Same information as current implementation, same position.

### Filter Bar (top-center)

```
[ All ] [ Read ] [ Edit ] [ Exec ]     [ ▼ More Filters ]
```

Pill-style buttons. Active filter highlighted. "More Filters" opens recency + directory panel.

### Tooltip (near hovered node)

Glassmorphic panel (`background: rgba(5,5,16,0.85)`, `backdrop-filter: blur(12px)`):

```
filename.js  · src/ui/
Read 12  Edit 8  Exec 3
Yellow Star · Importance 14
```

Positioned in screen space near the hovered node. Follows node if scene is orbiting.

### Legend (bottom-left, collapsible)

Star classification color reference + edge type colors. Same info as current legend but updated for new visual language. Hidden by default, toggle button to show.

---

## 8. Migration Path

### Files to Delete

- `src/ui/gravity.js`
- `src/ui/gravity3d.js`

### Files to Create

- `src/ui/universe.js` — main renderer module

### Files to Modify

- `src/ui/index.html` — remove 3D-Force-Graph + three-spritetext script tags, remove 2D/3D toggle, add postprocessing imports
- `src/ui/app.js` — replace `Gravity.*` and `Gravity3D.*` calls with `Universe.*` calls
- `src/ui/styles.css` — remove 2D gravity styles, update HUD styles for new filter bar and tooltip design

### API Compatibility

The public API that `app.js` consumes stays the same shape:

```javascript
// Before
Gravity.init(canvas);
Gravity.addEntry(entry);
Gravity3D.init(container);
Gravity3D.addEntry(entry);

// After
Universe.init(container);
Universe.addEntry(entry);
```

Internal data structures (nodes, edges, activeFiles) are preserved. The force simulation configuration is preserved. Only the rendering layer changes.
