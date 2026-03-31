# Universe Map Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 2D Canvas + 3D-Force-Graph dual map with a single custom Three.js universe visualization that feels like a deep space observatory.

**Architecture:** Single `universe.js` module using raw Three.js for rendering and D3.js for force-directed layout. All data processing logic (file path extraction, edge classification, node importance) is preserved from existing `gravity.js`. The module exposes the same public API shape so `app.js` integration is a straightforward find-and-replace.

**Tech Stack:** Three.js (WebGLRenderer, InstancedMesh, ShaderMaterial, EffectComposer, UnrealBloomPass, OrbitControls), D3.js (forceSimulation), vanilla JS.

**Spec:** `docs/superpowers/specs/2026-03-31-universe-map-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/ui/universe.js` | Create | Main module — scene setup, data processing, all rendering subsystems, public API |
| `src/ui/app.js` | Modify | Replace all `Gravity.*` / `Gravity3D.*` calls with `Universe.*`, remove 2D/3D toggle logic |
| `src/ui/index.html` | Modify | Remove 3D-Force-Graph + three-spritetext scripts, remove 2D/3D toggle markup, add OrbitControls + postprocessing imports, add universe.js script |
| `src/ui/styles.css` | Modify | Remove 2D-specific gravity styles, update HUD/tooltip/filter styles for universe |
| `src/ui/gravity.js` | Delete | Replaced by universe.js |
| `src/ui/gravity3d.js` | Delete | Replaced by universe.js |

`universe.js` is a single file (not split into modules) because loupe uses vanilla JS with script tags — no bundler. All subsystems (background, nodes, edges, interaction, HUD) are organized as internal functions within the IIFE.

---

## Task 1: Scaffold universe.js with Scene Setup & Public API Shell

**Files:**
- Create: `src/ui/universe.js`

This task creates the bare module with Three.js scene, camera, renderer, OrbitControls, resize handling, and all public API methods as stubs. No visual content yet — just a black scene that renders.

- [ ] **Step 1: Create universe.js with IIFE structure and scene setup**

```javascript
// src/ui/universe.js
const Universe = (function () {
  "use strict";

  // ── Constants ──
  const GLOW_DURATION = 30000;       // 30s — "active"
  const WARM_DURATION = 120000;      // 2min — "warm"
  const STALE_CUTOFF = 30 * 60000;   // 30min — hidden
  const DEFAULT_CAM_Z = 350;
  const MIN_DISTANCE = 50;
  const MAX_DISTANCE = 800;

  // Star classification thresholds
  const STAR_CLASSES = [
    { name: "Red Dwarf",    minImp: 1,  maxImp: 3,  minSize: 0.8, maxSize: 1.2, color: new THREE.Color("#ff6b4a"), coronaMul: 2.0 },
    { name: "Orange Dwarf", minImp: 4,  maxImp: 8,  minSize: 1.5, maxSize: 2.0, color: new THREE.Color("#ff9f43"), coronaMul: 2.5 },
    { name: "Yellow Star",  minImp: 9,  maxImp: 15, minSize: 2.5, maxSize: 3.5, color: new THREE.Color("#ffd93d"), coronaMul: 3.0 },
    { name: "White Star",   minImp: 16, maxImp: 25, minSize: 4.0, maxSize: 5.0, color: new THREE.Color("#f0f0ff"), coronaMul: 3.5 },
    { name: "Blue Giant",   minImp: 26, maxImp: Infinity, minSize: 5.5, maxSize: 7.0, color: new THREE.Color("#7eb8ff"), coronaMul: 4.0 },
  ];

  // Edge type colors
  const EDGE_COLORS = {
    prerequisite: new THREE.Color("#8b5cf6"),
    coupling:     new THREE.Color("#f97316"),
    validation:   new THREE.Color("#4ade80"),
    discovery:    new THREE.Color("#3b82f6"),
    sequence:     new THREE.Color("#475569"),
  };

  // ── State ──
  let container, renderer, scene, camera, controls, composer;
  let animFrameId = null;
  let resizeObserver = null;

  // Data
  const nodes = new Map();
  const edges = new Map();
  const activeFiles = new Map();
  const pulses = [];
  const lastToolBySession = new Map();

  // Interaction state
  let hoveredNode = null;
  let selectedNode = null;
  let userDragged = false;
  let flyingTo = false;
  let activeFilter = "all"; // "all", "read", "edit", "exec"

  // ── Helpers ──
  function getImportance(n) {
    return (n.editCount || 0) * 3 + (n.execCount || 0) * 2 + (n.readCount || 0);
  }

  function getStarClass(importance) {
    for (const sc of STAR_CLASSES) {
      if (importance >= sc.minImp && importance <= sc.maxImp) return sc;
    }
    return STAR_CLASSES[0];
  }

  function getZoomLevel() {
    if (!camera) return 0.5;
    const dist = camera.position.length();
    return Math.max(0, Math.min(1, 1 - (dist - MIN_DISTANCE) / (MAX_DISTANCE - MIN_DISTANCE)));
  }

  // ── Scene Setup ──
  function createScene(el) {
    container = el;
    const w = container.clientWidth;
    const h = container.clientHeight;

    scene = new THREE.Scene();
    scene.background = new THREE.Color("#050510");

    camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 2000);
    camera.position.set(0, 0, DEFAULT_CAM_Z);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // OrbitControls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = MIN_DISTANCE;
    controls.maxDistance = MAX_DISTANCE;
    controls.addEventListener("start", () => { userDragged = true; });

    // ResizeObserver
    resizeObserver = new ResizeObserver(() => {
      const w2 = container.clientWidth;
      const h2 = container.clientHeight;
      renderer.setSize(w2, h2);
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(container);
  }

  // ── Render Loop ──
  function animate() {
    animFrameId = requestAnimationFrame(animate);
    controls.update();
    // TODO: update force layout positions
    // TODO: update background parallax
    // TODO: update node instances
    // TODO: update edge geometry
    // TODO: update orbital rotations
    // TODO: update photon particles
    // TODO: auto-focus camera
    if (composer) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }

  // ── Data Processing (preserved from gravity.js) ──
  function extractFilePath(entry) {
    try {
      const j = typeof entry.json === "string" ? JSON.parse(entry.json) : entry.json;
      const ti = j.tool_input || j.input || {};
      if (ti.file_path) return ti.file_path;
      if (ti.path) return ti.path;
      if (ti.command) {
        const m = ti.command.match(/(?:^|\s)(\/[^\s;|&]+)/);
        if (m) return m[1];
      }
    } catch (_) {}
    return null;
  }

  function extractToolName(entry) {
    try {
      const j = typeof entry.json === "string" ? JSON.parse(entry.json) : entry.json;
      return j.tool_name || null;
    } catch (_) {}
    return null;
  }

  function toolToAction(tool) {
    if (!tool) return "read";
    const t = tool.toLowerCase();
    if (["edit", "write", "notebookedit"].includes(t)) return "edit";
    if (["bash", "agent"].includes(t)) return "exec";
    return "read";
  }

  function classifyEdge(prevAction, prevFile, currAction, currFile) {
    if (prevAction === "read" && currAction === "edit") return "prerequisite";
    if (prevAction === "edit" && currAction === "edit" && prevFile !== currFile) return "coupling";
    if (prevAction === "edit" && currAction === "exec") return "validation";
    if (["read"].includes(prevAction) && currAction === "read" && prevFile !== currFile) return "discovery";
    return "sequence";
  }

  function processEntry(entry) {
    try {
      const j = typeof entry.json === "string" ? JSON.parse(entry.json) : entry.json;
      if (j.hook !== "PreToolUse") return;
    } catch (_) { return; }

    const fp = extractFilePath(entry);
    if (!fp || !fp.startsWith("/") || fp.includes("node_modules/") || fp.includes(".git/")) return;

    const tool = extractToolName(entry);
    const action = toolToAction(tool);
    const now = Date.now();
    const sessionId = entry.sessionId || "default";
    const label = fp.split("/").pop();
    const dir = fp.substring(0, fp.lastIndexOf("/"));

    // Upsert node
    let node = nodes.get(fp);
    if (!node) {
      node = { id: fp, label, dir, accessCount: 0, readCount: 0, editCount: 0, execCount: 0,
               lastAction: action, lastAccessTs: now, x: (Math.random() - 0.5) * 100,
               y: (Math.random() - 0.5) * 100, z: (Math.random() - 0.5) * 20,
               vx: 0, vy: 0, vz: 0 };
      nodes.set(fp, node);
    }
    node.accessCount++;
    node[action + "Count"]++;
    node.lastAction = action;
    node.lastAccessTs = now;
    activeFiles.set(fp, now);

    // Edge from previous file in this session
    const prev = lastToolBySession.get(sessionId);
    if (prev && prev.file !== fp) {
      const edgeType = classifyEdge(prev.action, prev.file, action, fp);
      const key = prev.file < fp ? `${prev.file}|${fp}` : `${fp}|${prev.file}`;
      let edge = edges.get(key);
      if (!edge) {
        edge = { source: prev.file, target: fp, type: edgeType, weight: 0, lastTs: now };
        edges.set(key, edge);
      }
      edge.weight++;
      edge.lastTs = now;
      edge.type = edgeType;
    }
    lastToolBySession.set(sessionId, { tool, action, file: fp, ts: now });
  }

  // ── Public API ──
  function init(el) {
    createScene(el);
    animate();
    // Load history
    fetch("/api/file-accesses").then(r => r.json()).then(list => {
      if (Array.isArray(list)) addEntries(list);
    }).catch(() => {});
  }

  function addEntry(entry) {
    processEntry(entry);
    // TODO: rebuild visuals (debounced)
  }

  function addEntries(list) {
    for (const e of list) processEntry(e);
    // TODO: rebuild visuals immediately
  }

  function getTooltip() {
    const n = hoveredNode || selectedNode;
    if (!n) return null;
    const imp = getImportance(n);
    const sc = getStarClass(imp);
    return {
      label: n.label, dir: n.dir, file: n.id,
      readCount: n.readCount, editCount: n.editCount, execCount: n.execCount,
      classification: sc.name, importance: imp,
    };
  }

  function getStats() {
    const now = Date.now();
    let visible = 0;
    nodes.forEach(n => {
      if (now - n.lastAccessTs < STALE_CUTOFF) visible++;
    });
    return { visible, total: nodes.size, edges: edges.size, zoom: getZoomLevel().toFixed(2) };
  }

  function resize() {
    // Handled by ResizeObserver — this is a no-op for API compatibility
  }

  function zoom(factor) {
    if (!camera) return;
    const dir = camera.position.clone().normalize();
    const dist = camera.position.length();
    const newDist = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, dist / factor));
    camera.position.copy(dir.multiplyScalar(newDist));
  }

  function deselect() {
    selectedNode = null;
    hoveredNode = null;
    // TODO: reset edge/node visuals
  }

  function destroy() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (resizeObserver) resizeObserver.disconnect();
    if (controls) controls.dispose();
    if (renderer) {
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
    // TODO: dispose all geometries, materials, textures
    nodes.clear();
    edges.clear();
    activeFiles.clear();
    pulses.length = 0;
  }

  function reset() {
    nodes.clear();
    edges.clear();
    activeFiles.clear();
    pulses.length = 0;
    lastToolBySession.clear();
    hoveredNode = null;
    selectedNode = null;
    userDragged = false;
    // TODO: clear scene objects, reset camera
    if (camera) camera.position.set(0, 0, DEFAULT_CAM_Z);
  }

  function setFilter(type) {
    activeFilter = type;
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b.dataset.filter === type));
    rebuildNodes(); // will be defined in Task 3
  }

  return { init, addEntry, addEntries, getTooltip, getStats, resize, zoom, deselect, destroy, reset, setFilter };
})();
```

- [ ] **Step 2: Verify the file is syntactically valid**

Run: `cd /Users/tomyang/pal/loupe && node -c src/ui/universe.js`
Expected: no output (syntax OK)

- [ ] **Step 3: Commit**

```bash
git add src/ui/universe.js
git commit -m "feat: scaffold universe.js with scene setup and public API shell"
```

---

## Task 2: Background — Star Field & Nebula

**Files:**
- Modify: `src/ui/universe.js`

Add the 3-layer parallax star field (InstancedBufferGeometry Points) and 2-3 nebula planes (PlaneGeometry with procedural CanvasTexture). Background stars use a custom ShaderMaterial for per-point size, color, opacity, and twinkle.

- [ ] **Step 1: Add star field creation function after the helpers section**

Inside the IIFE, after `getZoomLevel()`, add:

```javascript
  // ── Background: Star Field ──
  const starLayers = [];

  function createStarField() {
    const configs = [
      { count: 800, sizeRange: [0.3, 0.8], opRange: [0.15, 0.35], drift: 0.001, twinkle: 0.02 },
      { count: 200, sizeRange: [0.6, 1.2], opRange: [0.25, 0.55], drift: 0.003, twinkle: 0.08 },
      { count: 50,  sizeRange: [1.0, 2.0], opRange: [0.5, 0.85],  drift: 0.008, twinkle: 0.20 },
    ];
    const colorPool = [
      new THREE.Color("#ffffff"), new THREE.Color("#ffffff"), new THREE.Color("#ffffff"),
      new THREE.Color("#ffffff"), new THREE.Color("#ffffff"), new THREE.Color("#ffffff"),
      new THREE.Color("#ccd4ff"), new THREE.Color("#ccd4ff"),
      new THREE.Color("#ffe8c0"),
      new THREE.Color("#ffcca0"),
    ];

    for (const cfg of configs) {
      const positions = new Float32Array(cfg.count * 3);
      const colors = new Float32Array(cfg.count * 3);
      const sizes = new Float32Array(cfg.count);
      const opacities = new Float32Array(cfg.count);
      const twinklePhase = new Float32Array(cfg.count);
      const twinkleSpeed = new Float32Array(cfg.count);

      for (let i = 0; i < cfg.count; i++) {
        positions[i * 3]     = (Math.random() - 0.5) * 1200;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 800;
        positions[i * 3 + 2] = -200 - Math.random() * 300; // behind data nodes
        const c = colorPool[Math.floor(Math.random() * colorPool.length)];
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
        sizes[i] = cfg.sizeRange[0] + Math.random() * (cfg.sizeRange[1] - cfg.sizeRange[0]);
        opacities[i] = cfg.opRange[0] + Math.random() * (cfg.opRange[1] - cfg.opRange[0]);
        twinklePhase[i] = Math.random() < cfg.twinkle ? Math.random() * Math.PI * 2 : -1; // -1 = no twinkle
        twinkleSpeed[i] = 2.5 + Math.random() * 1.5; // 2.5-4s period
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
      geo.setAttribute("aOpacity", new THREE.BufferAttribute(opacities, 1));

      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 } },
        vertexShader: `
          attribute float size;
          attribute float aOpacity;
          varying float vOpacity;
          varying vec3 vColor;
          void main() {
            vColor = color;
            vOpacity = aOpacity;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * (300.0 / -mv.z);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          varying float vOpacity;
          varying vec3 vColor;
          void main() {
            float d = length(gl_PointCoord - 0.5) * 2.0;
            if (d > 1.0) discard;
            float alpha = vOpacity * (1.0 - d * d);
            gl_FragColor = vec4(vColor, alpha);
          }
        `,
        transparent: true,
        depthWrite: false,
        vertexColors: true,
      });

      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      scene.add(points);
      starLayers.push({ points, drift: cfg.drift, twinklePhase, twinkleSpeed, opacities, geo });
    }
  }

  function updateStarParallax() {
    if (!camera) return;
    for (const layer of starLayers) {
      const offset = camera.position.clone().multiplyScalar(-layer.drift);
      layer.points.position.set(offset.x, offset.y, 0);
    }
    // Twinkle
    const t = performance.now() / 1000;
    for (const layer of starLayers) {
      const opAttr = layer.geo.getAttribute("aOpacity");
      let changed = false;
      for (let i = 0; i < layer.twinklePhase.length; i++) {
        if (layer.twinklePhase[i] >= 0) {
          const base = layer.opacities[i];
          const phase = layer.twinklePhase[i];
          const speed = layer.twinkleSpeed[i];
          opAttr.array[i] = base * (0.6 + 0.4 * Math.sin(t / speed * Math.PI * 2 + phase));
          changed = true;
        }
      }
      if (changed) opAttr.needsUpdate = true;
    }
  }
```

- [ ] **Step 2: Add nebula creation function**

```javascript
  // ── Background: Nebula ──
  const nebulaPlanes = [];

  function createNebula() {
    const configs = [
      { color: [60, 40, 120], alpha: 0.12, w: 600, h: 350, z: -180, x: -150, y: 80, breathe: 25 },
      { color: [30, 60, 100], alpha: 0.10, w: 500, h: 400, z: -220, x: 200, y: -100, breathe: 30 },
      { color: [80, 30, 50],  alpha: 0.08, w: 400, h: 250, z: -160, x: 50, y: -150, breathe: 20 },
    ];

    for (const cfg of configs) {
      // Procedural texture via canvas
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d");
      const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      grad.addColorStop(0, `rgba(${cfg.color[0]}, ${cfg.color[1]}, ${cfg.color[2]}, ${cfg.alpha})`);
      grad.addColorStop(0.4, `rgba(${cfg.color[0]}, ${cfg.color[1]}, ${cfg.color[2]}, ${cfg.alpha * 0.5})`);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 256);
      const tex = new THREE.CanvasTexture(canvas);

      const geo = new THREE.PlaneGeometry(cfg.w, cfg.h);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cfg.x, cfg.y, cfg.z);
      scene.add(mesh);
      nebulaPlanes.push({ mesh, breathe: cfg.breathe, baseX: cfg.x, baseY: cfg.y, baseScale: 1 });
    }
  }

  function updateNebula() {
    const t = performance.now() / 1000;
    for (const n of nebulaPlanes) {
      const phase = t / n.breathe * Math.PI * 2;
      const s = 1 + 0.08 * Math.sin(phase);
      n.mesh.scale.set(s, s, 1);
      n.mesh.position.x = n.baseX + Math.sin(phase * 0.7) * 5;
      n.mesh.position.y = n.baseY + Math.cos(phase * 0.5) * 3;
      n.mesh.material.opacity = 0.85 + 0.15 * Math.sin(phase);
    }
  }
```

- [ ] **Step 3: Wire background creation into init and render loop**

In `createScene()`, after the ResizeObserver block, add:
```javascript
    createStarField();
    createNebula();
```

In `animate()`, before the render call, replace the parallax/background TODOs:
```javascript
    updateStarParallax();
    updateNebula();
```

- [ ] **Step 4: Verify syntax**

Run: `cd /Users/tomyang/pal/loupe && node -c src/ui/universe.js`
Expected: no output (syntax OK)

- [ ] **Step 5: Commit**

```bash
git add src/ui/universe.js
git commit -m "feat: add parallax star field and breathing nebula background"
```

---

## Task 3: Node System — Star Classification & Corona Shader

**Files:**
- Modify: `src/ui/universe.js`

Add the InstancedMesh for data nodes with a custom ShaderMaterial that renders both the star core and the corona glow in a single pass. Per-instance attributes: matrix (position + scale), color, coreRadius, opacity.

- [ ] **Step 1: Add node system variables and creation function**

After the nebula section, add:

```javascript
  // ── Node System ──
  const MAX_NODES = 500;
  let nodeInstancedMesh = null;
  let nodeColorAttr = null;
  let nodeCoreRadiusAttr = null;
  let nodeOpacityAttr = null;
  let nodeIndexMap = new Map(); // filepath → instance index
  let nodeCount = 0;
  const _dummy = new THREE.Object3D();
  const _color = new THREE.Color();

  const starVertexShader = `
    attribute float instanceCoreRadius;
    attribute float instanceOpacity;
    attribute vec3 instanceColor;
    varying vec3 vColor;
    varying float vCoreRadius;
    varying float vOpacity;
    varying vec2 vUv;
    void main() {
      vColor = instanceColor;
      vCoreRadius = instanceCoreRadius;
      vOpacity = instanceOpacity;
      vUv = uv;
      vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
    }
  `;

  const starFragmentShader = `
    uniform float uTime;
    varying vec3 vColor;
    varying float vCoreRadius;
    varying float vOpacity;
    varying vec2 vUv;
    void main() {
      float dist = length(vUv - 0.5) * 2.0;
      // Core: solid bright center
      float coreEdge = 0.3;
      float core = smoothstep(coreEdge + 0.05, coreEdge - 0.05, dist);
      // Corona: exponential falloff
      float corona = exp(-dist * 3.0) * 0.15;
      float alpha = (core + corona) * vOpacity;
      if (alpha < 0.001) discard;
      vec3 col = vColor * (core + corona * 0.5);
      gl_FragColor = vec4(col, alpha);
    }
  `;

  function createNodeSystem() {
    const geo = new THREE.PlaneGeometry(1, 1); // billboard quad
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: starVertexShader,
      fragmentShader: starFragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    nodeInstancedMesh = new THREE.InstancedMesh(geo, mat, MAX_NODES);
    nodeInstancedMesh.count = 0;
    nodeInstancedMesh.frustumCulled = false;
    nodeInstancedMesh.layers.enable(1); // bloom layer

    // Per-instance attributes
    nodeColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 3), 3);
    nodeCoreRadiusAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES), 1);
    nodeOpacityAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES), 1);

    nodeInstancedMesh.geometry.setAttribute("instanceColor", nodeColorAttr);
    nodeInstancedMesh.geometry.setAttribute("instanceCoreRadius", nodeCoreRadiusAttr);
    nodeInstancedMesh.geometry.setAttribute("instanceOpacity", nodeOpacityAttr);

    scene.add(nodeInstancedMesh);
  }

  function rebuildNodes() {
    const now = Date.now();
    const zoom = getZoomLevel();
    nodeIndexMap.clear();
    let idx = 0;

    nodes.forEach((n, fp) => {
      if (now - n.lastAccessTs > STALE_CUTOFF) return;
      if (idx >= MAX_NODES) return;

      const imp = getImportance(n);
      if (imp < 1) return;

      // Semantic zoom: hide low-importance nodes when zoomed out
      if (zoom < 0.5 && imp < 5) return;
      if (zoom >= 0.5 && zoom < 0.8 && imp < 2) return;

      // Filter: non-matching nodes get reduced opacity (handled below)
      const matchesFilter = activeFilter === "all" ||
        (activeFilter === "read" && n.readCount > 0) ||
        (activeFilter === "edit" && n.editCount > 0) ||
        (activeFilter === "exec" && n.execCount > 0);

      const sc = getStarClass(imp);
      const t = Math.min(1, (imp - sc.minImp) / Math.max(1, sc.maxImp - sc.minImp));
      const coreSize = sc.minSize + t * (sc.maxSize - sc.minSize);
      const billboardSize = coreSize * sc.coronaMul * 2;

      // Recency
      const age = now - n.lastAccessTs;
      let opacity = 0.35; // stale
      if (age < GLOW_DURATION) opacity = 1.0;
      else if (age < WARM_DURATION) opacity = 0.7;

      // Active pulse: modulate opacity for nodes < 30s old
      if (age < GLOW_DURATION) {
        const pulse = 0.85 + 0.15 * Math.sin(performance.now() / 1000 * Math.PI); // 2s cycle
        opacity *= pulse;
      }

      // Filter dimming
      if (!matchesFilter) opacity = 0.1;

      _dummy.position.set(n.x || 0, n.y || 0, n.z || 0);
      _dummy.scale.set(billboardSize, billboardSize, 1);
      _dummy.lookAt(camera.position); // billboard
      _dummy.updateMatrix();
      nodeInstancedMesh.setMatrixAt(idx, _dummy.matrix);

      _color.copy(sc.color);
      nodeColorAttr.setXYZ(idx, _color.r, _color.g, _color.b);
      nodeCoreRadiusAttr.setX(idx, coreSize);
      nodeOpacityAttr.setX(idx, opacity);

      nodeIndexMap.set(fp, idx);
      idx++;
    });

    nodeInstancedMesh.count = idx;
    nodeInstancedMesh.instanceMatrix.needsUpdate = true;
    nodeColorAttr.needsUpdate = true;
    nodeCoreRadiusAttr.needsUpdate = true;
    nodeOpacityAttr.needsUpdate = true;
    nodeCount = idx;
  }

  function updateNodePositions() {
    const now = Date.now();
    nodes.forEach((n, fp) => {
      const idx = nodeIndexMap.get(fp);
      if (idx === undefined) return;

      const imp = getImportance(n);
      const sc = getStarClass(imp);
      const t = Math.min(1, (imp - sc.minImp) / Math.max(1, sc.maxImp - sc.minImp));
      const coreSize = sc.minSize + t * (sc.maxSize - sc.minSize);
      const billboardSize = coreSize * sc.coronaMul * 2;

      _dummy.position.set(n.x || 0, n.y || 0, n.z || 0);
      _dummy.scale.set(billboardSize, billboardSize, 1);
      _dummy.lookAt(camera.position);
      _dummy.updateMatrix();
      nodeInstancedMesh.setMatrixAt(idx, _dummy.matrix);
    });

    if (nodeCount > 0) nodeInstancedMesh.instanceMatrix.needsUpdate = true;
  }
```

- [ ] **Step 2: Wire into init and render loop**

In `createScene()`, after `createNebula()`:
```javascript
    createNodeSystem();
```

In `animate()`, replace the node instances TODO:
```javascript
    updateNodePositions();
```

In `addEntry()` and `addEntries()`, replace the rebuild TODO with a call:
```javascript
  // addEntry — debounced rebuild
  let rebuildTimer = null;
  function addEntry(entry) {
    processEntry(entry);
    if (!rebuildTimer) rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuildNodes(); }, 100);
  }

  function addEntries(list) {
    for (const e of list) processEntry(e);
    rebuildNodes();
  }
```

- [ ] **Step 3: Verify syntax**

Run: `cd /Users/tomyang/pal/loupe && node -c src/ui/universe.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/ui/universe.js
git commit -m "feat: add star classification node system with corona shader"
```

---

## Task 4: Force Layout — D3 Simulation in 3D

**Files:**
- Modify: `src/ui/universe.js`

Wire up the D3 force simulation to position nodes in 3D space. Includes charge, link, center, collision, cluster force, and z-force.

- [ ] **Step 1: Add force layout section**

After the node system section:

```javascript
  // ── Force Layout ──
  let simulation = null;

  function clusterForce(strength) {
    let nodeArray;
    function force(alpha) {
      const groups = new Map();
      for (const n of nodeArray) {
        if (!n.dir) continue;
        if (!groups.has(n.dir)) groups.set(n.dir, { cx: 0, cy: 0, cz: 0, count: 0 });
        const g = groups.get(n.dir);
        g.cx += n.x || 0; g.cy += n.y || 0; g.cz += n.z || 0;
        g.count++;
      }
      groups.forEach(g => { g.cx /= g.count; g.cy /= g.count; g.cz /= g.count; });
      for (const n of nodeArray) {
        const g = groups.get(n.dir);
        if (!g) continue;
        n.vx += (g.cx - (n.x || 0)) * strength * alpha;
        n.vy += (g.cy - (n.y || 0)) * strength * alpha;
        n.vz = (n.vz || 0) + (g.cz - (n.z || 0)) * strength * alpha;
      }
    }
    force.initialize = function(nodes) { nodeArray = nodes; };
    return force;
  }

  function initSimulation() {
    const nodeArray = Array.from(nodes.values()).filter(n => Date.now() - n.lastAccessTs < STALE_CUTOFF);
    const edgeArray = [];
    edges.forEach(e => {
      if (nodes.has(e.source) && nodes.has(e.target)) {
        edgeArray.push({ source: e.source, target: e.target, weight: e.weight });
      }
    });

    if (simulation) simulation.stop();

    simulation = d3.forceSimulation(nodeArray)
      .force("charge", d3.forceManyBody().strength(-80).distanceMax(400))
      .force("link", d3.forceLink(edgeArray).id(d => d.id).distance(80).strength(e => 0.04 + (e.weight || 0) * 0.003))
      .force("center", d3.forceCenter(0, 0).strength(0.01))
      .force("collide", d3.forceCollide(d => {
        const imp = getImportance(d);
        const sc = getStarClass(imp);
        return sc.maxSize + 2;
      }))
      .force("cluster", clusterForce(0.15))
      .force("z", d3.forceZ(0).strength(0.01))
      .alphaDecay(0.02)
      .velocityDecay(0.3)
      .on("tick", () => {
        // D3 updates x,y on tick; we also handle z manually
        for (const n of nodeArray) {
          n.z = (n.z || 0) + (n.vz || 0);
          n.vz = (n.vz || 0) * 0.7; // damping
        }
      });

    // Warmup
    for (let i = 0; i < 100; i++) simulation.tick();
  }
```

- [ ] **Step 2: Wire into rebuild**

At the end of `rebuildNodes()`, add:
```javascript
    initSimulation();
```

- [ ] **Step 3: Verify syntax**

Run: `cd /Users/tomyang/pal/loupe && node -c src/ui/universe.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/ui/universe.js
git commit -m "feat: add D3 force layout simulation for 3D node positioning"
```

---

## Task 5: Edge System — Faint Lines with Hover Reveal

**Files:**
- Modify: `src/ui/universe.js`

Add BufferGeometry-based edge rendering. Edges are nearly invisible by default (5% opacity) and reveal on hover.

- [ ] **Step 1: Add edge system**

After force layout section:

```javascript
  // ── Edge System ──
  let edgeMesh = null;
  let edgePositionAttr = null;
  let edgeColorAttr = null;
  const MAX_EDGES = 1000;

  function createEdgeSystem() {
    const geo = new THREE.BufferGeometry();
    edgePositionAttr = new THREE.BufferAttribute(new Float32Array(MAX_EDGES * 6), 3); // 2 verts per edge
    edgeColorAttr = new THREE.BufferAttribute(new Float32Array(MAX_EDGES * 8), 4);   // rgba per vert
    geo.setAttribute("position", edgePositionAttr);
    geo.setAttribute("color", edgeColorAttr);
    edgePositionAttr.setUsage(THREE.DynamicDrawUsage);
    edgeColorAttr.setUsage(THREE.DynamicDrawUsage);

    // Custom ShaderMaterial to support per-vertex alpha (LineBasicMaterial ignores 4th color component)
    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec4 color;
        varying vec4 vColor;
        void main() {
          vColor = color;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec4 vColor;
        void main() {
          gl_FragColor = vColor;
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    edgeMesh = new THREE.LineSegments(geo, mat);
    edgeMesh.frustumCulled = false;
    scene.add(edgeMesh);
  }

  function updateEdges() {
    if (!edgeMesh) return;
    const now = Date.now();
    let idx = 0;

    edges.forEach((e, key) => {
      if (idx >= MAX_EDGES) return;
      const srcNode = nodes.get(e.source);
      const tgtNode = nodes.get(e.target);
      if (!srcNode || !tgtNode) return;
      if (now - srcNode.lastAccessTs > STALE_CUTOFF || now - tgtNode.lastAccessTs > STALE_CUTOFF) return;

      const c = EDGE_COLORS[e.type] || EDGE_COLORS.sequence;

      // Determine opacity
      let alpha = 0.05; // default: nearly invisible
      const hovered = hoveredNode || selectedNode;
      if (hovered) {
        if (e.source === hovered.id || e.target === hovered.id) {
          alpha = 0.3; // connected to hovered node
        } else {
          alpha = 0.02; // dim further when something is hovered
        }
      }

      // Filter: dim edges connected to filtered-out nodes
      if (activeFilter !== "all") {
        const srcMatch = activeFilter === "all" || (srcNode[activeFilter + "Count"] || 0) > 0;
        const tgtMatch = activeFilter === "all" || (tgtNode[activeFilter + "Count"] || 0) > 0;
        if (!srcMatch || !tgtMatch) alpha = 0.02;
      }

      const vi = idx * 6;
      edgePositionAttr.array[vi]     = srcNode.x || 0;
      edgePositionAttr.array[vi + 1] = srcNode.y || 0;
      edgePositionAttr.array[vi + 2] = srcNode.z || 0;
      edgePositionAttr.array[vi + 3] = tgtNode.x || 0;
      edgePositionAttr.array[vi + 4] = tgtNode.y || 0;
      edgePositionAttr.array[vi + 5] = tgtNode.z || 0;

      const ci = idx * 8;
      edgeColorAttr.array[ci]     = c.r; edgeColorAttr.array[ci + 1] = c.g;
      edgeColorAttr.array[ci + 2] = c.b; edgeColorAttr.array[ci + 3] = alpha;
      edgeColorAttr.array[ci + 4] = c.r; edgeColorAttr.array[ci + 5] = c.g;
      edgeColorAttr.array[ci + 6] = c.b; edgeColorAttr.array[ci + 7] = alpha;

      idx++;
    });

    edgeMesh.geometry.setDrawRange(0, idx * 2);
    edgePositionAttr.needsUpdate = true;
    edgeColorAttr.needsUpdate = true;
  }
```

- [ ] **Step 2: Wire into init and render loop**

In `createScene()`, after `createNodeSystem()`:
```javascript
    createEdgeSystem();
```

In `animate()`, replace the edge geometry TODO:
```javascript
    updateEdges();
```

- [ ] **Step 3: Verify syntax**

Run: `cd /Users/tomyang/pal/loupe && node -c src/ui/universe.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/ui/universe.js
git commit -m "feat: add edge system with faint lines and hover reveal"
```

---

## Task 6: Interaction — Raycasting, Hover, Click, Fly-To

**Files:**
- Modify: `src/ui/universe.js`

Add mouse interaction: raycasting against node positions for hover/click, double-click fly-to animation, auto-focus camera, and Escape to reset.

- [ ] **Step 1: Add interaction system**

After edge system section:

```javascript
  // ── Interaction ──
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let flyToStart = null, flyToEnd = null, flyToTime = 0;

  function setupInteraction() {
    const el = renderer.domElement;

    el.addEventListener("mousemove", (e) => {
      const rect = el.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      performRaycast();
    });

    el.addEventListener("click", (e) => {
      if (hoveredNode) {
        selectedNode = hoveredNode;
      } else {
        selectedNode = null;
      }
    });

    el.addEventListener("dblclick", (e) => {
      if (hoveredNode) startFlyTo(hoveredNode);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        selectedNode = null;
        hoveredNode = null;
        userDragged = false;
        camera.position.set(0, 0, DEFAULT_CAM_Z);
        controls.target.set(0, 0, 0);
      }
    });
  }

  function performRaycast() {
    raycaster.setFromCamera(mouse, camera);
    // Check against node positions (sphere intersection)
    let closest = null;
    let closestDist = Infinity;
    const now = Date.now();

    nodes.forEach((n, fp) => {
      if (now - n.lastAccessTs > STALE_CUTOFF) return;
      const imp = getImportance(n);
      const sc = getStarClass(imp);
      const pos = new THREE.Vector3(n.x || 0, n.y || 0, n.z || 0);
      const sphere = new THREE.Sphere(pos, sc.maxSize * 1.5); // generous hit area
      const intersect = raycaster.ray.intersectSphere(sphere, new THREE.Vector3());
      if (intersect) {
        const d = camera.position.distanceTo(pos);
        if (d < closestDist) { closestDist = d; closest = n; }
      }
    });

    hoveredNode = closest;
  }

  function startFlyTo(node) {
    flyingTo = true;
    flyToStart = camera.position.clone();
    const target = new THREE.Vector3(node.x || 0, node.y || 0, node.z || 0);
    const dir = camera.position.clone().sub(target).normalize();
    flyToEnd = target.clone().add(dir.multiplyScalar(100));
    flyToTime = 0;
  }

  function updateFlyTo(dt) {
    if (!flyingTo) return;
    flyToTime += dt;
    const duration = 1.0; // 1 second
    let t = Math.min(1, flyToTime / duration);
    // Cubic ease-in-out
    t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    camera.position.lerpVectors(flyToStart, flyToEnd, t);
    if (flyToTime >= duration) {
      flyingTo = false;
      userDragged = true;
    }
  }

  function updateAutoFocus() {
    if (userDragged || flyingTo) return;
    const now = Date.now();
    let cx = 0, cy = 0, cz = 0, count = 0;
    activeFiles.forEach((ts, fp) => {
      if (now - ts > WARM_DURATION) return;
      const n = nodes.get(fp);
      if (!n) return;
      cx += (n.x || 0); cy += (n.y || 0); cz += (n.z || 0);
      count++;
    });
    if (count === 0) return;
    cx /= count; cy /= count; cz /= count;
    controls.target.x += (cx - controls.target.x) * 0.05;
    controls.target.y += (cy - controls.target.y) * 0.05;
    controls.target.z += (cz - controls.target.z) * 0.05;
  }
```

- [ ] **Step 2: Wire into init and render loop**

In `createScene()`, after `createEdgeSystem()`:
```javascript
    setupInteraction();
```

In `animate()`, add before controls.update():
```javascript
    const dt = 1 / 60; // approximate
    updateFlyTo(dt);
    updateAutoFocus();
```

- [ ] **Step 3: Verify syntax**

Run: `cd /Users/tomyang/pal/loupe && node -c src/ui/universe.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/ui/universe.js
git commit -m "feat: add raycasting interaction, hover, click, and fly-to camera"
```

---

## Task 7: Post-Processing — Selective Bloom

**Files:**
- Modify: `src/ui/universe.js`

Add EffectComposer with selective bloom using the layer technique. Star cores and photon particles bloom; background stars and nebula don't.

- [ ] **Step 1: Add bloom setup function**

After interaction section:

```javascript
  // ── Post-Processing: Selective Bloom ──
  const BLOOM_LAYER = 1;
  const bloomLayer = new THREE.Layers();
  bloomLayer.set(BLOOM_LAYER);
  const darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const storedMaterials = {};

  function setupBloom() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    const renderPass = new THREE.RenderPass(scene, camera);
    const bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(w, h), 0.4, 0.6, 0.1
    );
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
  }
```

- [ ] **Step 2: Wire bloom into init**

In `createScene()`, after `setupInteraction()`:
```javascript
    setupBloom();
```

Update the ResizeObserver to also resize the composer:
```javascript
    resizeObserver = new ResizeObserver(() => {
      const w2 = container.clientWidth;
      const h2 = container.clientHeight;
      renderer.setSize(w2, h2);
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
      if (composer) composer.setSize(w2, h2);
    });
```

- [ ] **Step 3: Verify syntax**

Run: `cd /Users/tomyang/pal/loupe && node -c src/ui/universe.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/ui/universe.js
git commit -m "feat: add selective bloom post-processing"
```

---

## Task 8: Labels — Sprite-based Text

**Files:**
- Modify: `src/ui/universe.js`

Add lazy label creation using Three.js Sprite + CanvasTexture. Labels appear based on zoom level and hover state.

- [ ] **Step 1: Add label system**

After bloom section:

```javascript
  // ── Labels ──
  const labelSprites = new Map(); // filepath → { sprite, isExpanded }
  const labelGroup = new THREE.Group();
  let prevHoveredId = null; // track hover changes to invalidate labels

  function createLabelSprite(text, color) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const fontSize = 32;
    ctx.font = `${fontSize}px "SF Mono", "JetBrains Mono", Menlo, monospace`;
    const metrics = ctx.measureText(text);
    canvas.width = Math.ceil(metrics.width) + 8;
    canvas.height = fontSize + 8;
    ctx.font = `${fontSize}px "SF Mono", "JetBrains Mono", Menlo, monospace`;
    ctx.fillStyle = color;
    ctx.textBaseline = "top";
    ctx.fillText(text, 4, 4);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(canvas.width / 32, canvas.height / 32, 1); // scale to world units
    return sprite;
  }

  function updateLabels() {
    const zoom = getZoomLevel();
    const now = Date.now();
    const hovered = hoveredNode || selectedNode;
    const hoveredId = hovered ? hovered.id : null;

    // If hover target changed, invalidate affected labels so they get recreated
    if (hoveredId !== prevHoveredId) {
      // Invalidate old hover target + its neighbors
      if (prevHoveredId) {
        invalidateLabel(prevHoveredId);
        edges.forEach(e => {
          if (e.source === prevHoveredId) invalidateLabel(e.target);
          if (e.target === prevHoveredId) invalidateLabel(e.source);
        });
      }
      // Invalidate new hover target + its neighbors
      if (hoveredId) {
        invalidateLabel(hoveredId);
        edges.forEach(e => {
          if (e.source === hoveredId) invalidateLabel(e.target);
          if (e.target === hoveredId) invalidateLabel(e.source);
        });
      }
      prevHoveredId = hoveredId;
    }

    nodes.forEach((n, fp) => {
      if (now - n.lastAccessTs > STALE_CUTOFF) {
        invalidateLabel(fp);
        return;
      }

      const imp = getImportance(n);
      const sc = getStarClass(imp);
      const isHoverTarget = hovered && (hovered.id === fp || isNeighbor(fp, hovered.id));

      // Visibility rules
      let visible = false;
      if (isHoverTarget) visible = true;
      else if (zoom > 0.8 && imp >= 9) visible = true;
      else if (zoom > 0.5 && imp >= 15) visible = true;

      if (!visible) {
        const entry = labelSprites.get(fp);
        if (entry) entry.sprite.visible = false;
        return;
      }

      // Determine if we need expanded (dir) or short (filename) label
      const needsExpanded = isHoverTarget;
      let entry = labelSprites.get(fp);

      // Create or recreate if expansion state changed
      if (!entry || entry.isExpanded !== needsExpanded) {
        if (entry) { labelGroup.remove(entry.sprite); entry.sprite.material.map.dispose(); entry.sprite.material.dispose(); }
        const displayText = needsExpanded ? `${n.label}  ·  ${n.dir}` : n.label;
        const sprite = createLabelSprite(displayText, `rgba(255,255,255,0.7)`);
        entry = { sprite, isExpanded: needsExpanded };
        labelSprites.set(fp, entry);
        labelGroup.add(entry.sprite);
      }

      entry.sprite.visible = true;
      const coreSize = sc.minSize + Math.min(1, (imp - sc.minImp) / Math.max(1, sc.maxImp - sc.minImp)) * (sc.maxSize - sc.minSize);
      entry.sprite.position.set(n.x || 0, (n.y || 0) - coreSize * 1.5, n.z || 0);
    });
  }

  function invalidateLabel(fp) {
    const entry = labelSprites.get(fp);
    if (entry) {
      labelGroup.remove(entry.sprite);
      entry.sprite.material.map.dispose();
      entry.sprite.material.dispose();
      labelSprites.delete(fp);
    }
  }

  function isNeighbor(fp, hoveredFp) {
    for (const [, e] of edges) {
      if ((e.source === fp && e.target === hoveredFp) || (e.source === hoveredFp && e.target === fp)) return true;
    }
    return false;
  }
```

- [ ] **Step 2: Wire into init and render loop**

In `createScene()`, after `setupBloom()`:
```javascript
    scene.add(labelGroup);
```

In `animate()`, add:
```javascript
    updateLabels();
```

- [ ] **Step 3: Verify syntax**

Run: `cd /Users/tomyang/pal/loupe && node -c src/ui/universe.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/ui/universe.js
git commit -m "feat: add sprite-based label system with semantic zoom visibility"
```

---

## Task 9: Orbital Systems — Blue Giant Satellites

**Files:**
- Modify: `src/ui/universe.js`

Add orbital ring rendering for Blue Giant nodes. Same-directory neighbors with lower importance become orbiters positioned on circular rings.

- [ ] **Step 1: Add orbital system**

After label section:

```javascript
  // ── Orbital Systems ──
  const orbitalSystems = new Map(); // dir → { center, orbiters, rings, group }

  function rebuildOrbitals() {
    // Clean up existing
    orbitalSystems.forEach(sys => scene.remove(sys.group));
    orbitalSystems.clear();

    const now = Date.now();
    // Group nodes by directory, find Blue Giants
    const dirNodes = new Map(); // dir → [nodes]
    nodes.forEach((n, fp) => {
      if (now - n.lastAccessTs > STALE_CUTOFF) return;
      if (!dirNodes.has(n.dir)) dirNodes.set(n.dir, []);
      dirNodes.get(n.dir).push(n);
    });

    dirNodes.forEach((members, dir) => {
      // Find highest-importance Blue Giant
      let blueGiant = null;
      let maxImp = 0;
      for (const n of members) {
        const imp = getImportance(n);
        if (imp >= 26 && imp > maxImp) { blueGiant = n; maxImp = imp; }
      }
      if (!blueGiant) return;

      // Need at least 2 other members
      const orbiters = members.filter(n => n !== blueGiant && getImportance(n) >= 1);
      if (orbiters.length < 2) return;

      const group = new THREE.Group();
      const rings = [];

      // Distribute orbiters across 1-3 rings
      const ringCount = Math.min(3, Math.ceil(orbiters.length / 3));
      for (let r = 0; r < ringCount; r++) {
        const radius = 15 + r * 12;
        const speed = 12 + r * 8; // seconds per revolution

        // Ring line
        const ringGeo = new THREE.BufferGeometry();
        const segments = 64;
        const ringPositions = new Float32Array((segments + 1) * 3);
        for (let i = 0; i <= segments; i++) {
          const angle = (i / segments) * Math.PI * 2;
          ringPositions[i * 3] = Math.cos(angle) * radius;
          ringPositions[i * 3 + 1] = Math.sin(angle) * radius;
          ringPositions[i * 3 + 2] = 0;
        }
        ringGeo.setAttribute("position", new THREE.BufferAttribute(ringPositions, 3));
        const ringMat = new THREE.LineBasicMaterial({ color: 0x7eb8ff, transparent: true, opacity: 0.08 });
        const ringLine = new THREE.Line(ringGeo, ringMat);
        group.add(ringLine);
        rings.push({ radius, speed, ringLine });
      }

      scene.add(group);
      orbitalSystems.set(dir, { center: blueGiant, orbiters, rings, group });
    });
  }

  function updateOrbitals() {
    const t = performance.now() / 1000;
    orbitalSystems.forEach(sys => {
      sys.group.position.set(sys.center.x || 0, sys.center.y || 0, sys.center.z || 0);

      let orbIdx = 0;
      for (let r = 0; r < sys.rings.length; r++) {
        const ring = sys.rings[r];
        const orbitersOnRing = [];
        while (orbIdx < sys.orbiters.length && orbitersOnRing.length < 3) {
          orbitersOnRing.push(sys.orbiters[orbIdx++]);
        }

        for (let i = 0; i < orbitersOnRing.length; i++) {
          const orb = orbitersOnRing[i];
          const angle = (t / ring.speed) * Math.PI * 2 + (i / orbitersOnRing.length) * Math.PI * 2;
          // Override orbiter position (removed from force layout)
          orb.x = (sys.center.x || 0) + Math.cos(angle) * ring.radius;
          orb.y = (sys.center.y || 0) + Math.sin(angle) * ring.radius;
          orb.z = sys.center.z || 0;
        }
      }
    });
  }
```

- [ ] **Step 2: Wire into rebuild and render loop**

At the end of `rebuildNodes()`, after `initSimulation()`:
```javascript
    rebuildOrbitals();
```

In `animate()`:
```javascript
    updateOrbitals();
```

- [ ] **Step 3: Verify syntax**

Run: `cd /Users/tomyang/pal/loupe && node -c src/ui/universe.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/ui/universe.js
git commit -m "feat: add orbital systems for Blue Giant nodes"
```

---

## Task 10: Photon Particles on Edges

**Files:**
- Modify: `src/ui/universe.js`

Add small glowing spheres that travel along edges connected to the hovered/selected node.

- [ ] **Step 1: Add photon particle system**

After orbital section:

```javascript
  // ── Photon Particles ──
  const MAX_PHOTONS = 20;
  let photonMesh = null;
  const photons = []; // {srcX,srcY,srcZ, tgtX,tgtY,tgtZ, startTime, duration}
  const _photonDummy = new THREE.Object3D();

  function createPhotonSystem() {
    const geo = new THREE.SphereGeometry(0.4, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0x7eb8ff, transparent: true, opacity: 0.8 });
    photonMesh = new THREE.InstancedMesh(geo, mat, MAX_PHOTONS);
    photonMesh.count = 0;
    photonMesh.frustumCulled = false;
    photonMesh.layers.enable(BLOOM_LAYER);
    scene.add(photonMesh);
  }

  function spawnPhotonsForHovered() {
    const target = hoveredNode || selectedNode;
    if (!target) { photons.length = 0; photonMesh.count = 0; return; }

    const now = performance.now();
    // Find connected edges and spawn photons if not already active
    edges.forEach((e) => {
      if (e.source !== target.id && e.target !== target.id) return;
      // Check if we already have a photon for this edge
      const key = e.source + "|" + e.target;
      if (photons.some(p => p.key === key && now - p.startTime < p.duration)) return;
      if (photons.length >= MAX_PHOTONS) return;

      const src = nodes.get(e.source);
      const tgt = nodes.get(e.target);
      if (!src || !tgt) return;

      photons.push({
        key,
        srcX: src.x || 0, srcY: src.y || 0, srcZ: src.z || 0,
        tgtX: tgt.x || 0, tgtY: tgt.y || 0, tgtZ: tgt.z || 0,
        startTime: now,
        duration: 2000 + Math.random() * 500,
        color: EDGE_COLORS[e.type] || EDGE_COLORS.sequence,
      });
    });
  }

  function updatePhotons() {
    if (!photonMesh) return;
    const now = performance.now();

    // Remove expired
    for (let i = photons.length - 1; i >= 0; i--) {
      if (now - photons[i].startTime > photons[i].duration) {
        photons.splice(i, 1);
      }
    }

    // Respawn if hovered
    spawnPhotonsForHovered();

    // Update positions
    for (let i = 0; i < photons.length; i++) {
      const p = photons[i];
      let t = (now - p.startTime) / p.duration;
      t = t * t * (3 - 2 * t); // smoothstep ease

      const x = p.srcX + (p.tgtX - p.srcX) * t;
      const y = p.srcY + (p.tgtY - p.srcY) * t;
      const z = p.srcZ + (p.tgtZ - p.srcZ) * t;

      _photonDummy.position.set(x, y, z);
      // Fade in/out
      let scale = 1;
      const raw = (now - p.startTime) / p.duration;
      if (raw < 0.1) scale = raw / 0.1;
      else if (raw > 0.85) scale = (1 - raw) / 0.15;
      _photonDummy.scale.set(scale, scale, scale);
      _photonDummy.updateMatrix();
      photonMesh.setMatrixAt(i, _photonDummy.matrix);
    }

    photonMesh.count = photons.length;
    if (photons.length > 0) photonMesh.instanceMatrix.needsUpdate = true;
  }
```

- [ ] **Step 2: Wire into init and render loop**

In `createScene()`, after label group:
```javascript
    createPhotonSystem();
```

In `animate()`:
```javascript
    updatePhotons();
```

- [ ] **Step 3: Verify syntax**

Run: `cd /Users/tomyang/pal/loupe && node -c src/ui/universe.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/ui/universe.js
git commit -m "feat: add photon particles traveling along hovered edges"
```

---

## Task 11: Performance Monitoring & Fallback

**Files:**
- Modify: `src/ui/universe.js`

Add frame time monitoring. If avg exceeds 16ms over 30 frames, reduce quality. Re-check every 60s for recovery.

- [ ] **Step 1: Add performance monitor**

After photon section:

```javascript
  // ── Performance Monitor ──
  let frameTimes = [];
  let degraded = false;
  let lastPerfCheck = 0;

  function monitorPerformance(frameTime) {
    frameTimes.push(frameTime);
    if (frameTimes.length > 30) frameTimes.shift();
    if (frameTimes.length < 30) return;

    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    const now = performance.now();

    if (!degraded && avg > 16) {
      degraded = true;
      // Reduce star count
      for (const layer of starLayers) {
        layer.points.geometry.setDrawRange(0, Math.floor(layer.points.geometry.attributes.position.count / 2));
      }
      // Disable bloom
      if (composer && composer.passes.length > 1) {
        composer.passes[1].enabled = false;
      }
      // Reduce nebula
      for (let i = 1; i < nebulaPlanes.length; i++) {
        nebulaPlanes[i].mesh.visible = false;
      }
      lastPerfCheck = now;
    } else if (degraded && now - lastPerfCheck > 60000 && avg < 12) {
      degraded = false;
      // Restore
      for (const layer of starLayers) {
        layer.points.geometry.setDrawRange(0, layer.points.geometry.attributes.position.count);
      }
      if (composer && composer.passes.length > 1) {
        composer.passes[1].enabled = true;
      }
      for (const np of nebulaPlanes) {
        np.mesh.visible = true;
      }
    }
  }
```

- [ ] **Step 2: Wire into render loop**

Replace the entire `animate()` function with this final version that tracks frame time and calls all subsystem updates:

```javascript
  let lastFrameTime = performance.now();
  function animate() {
    animFrameId = requestAnimationFrame(animate);
    const now = performance.now();
    const frameMs = now - lastFrameTime;
    lastFrameTime = now;
    const dt = frameMs / 1000;

    monitorPerformance(frameMs);
    updateFlyTo(dt);
    updateAutoFocus();
    controls.update();
    updateStarParallax();
    updateNebula();
    updateNodePositions();
    updateEdges();
    updateOrbitals();
    updateLabels();
    updatePhotons();

    if (composer) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }
```

- [ ] **Step 3: Verify syntax**

Run: `cd /Users/tomyang/pal/loupe && node -c src/ui/universe.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/ui/universe.js
git commit -m "feat: add performance monitoring with quality fallback and recovery"
```

---

## Task 12: Integrate — Update index.html

**Files:**
- Modify: `src/ui/index.html`

Remove old dependencies and 2D/3D toggle. Add OrbitControls and postprocessing imports. Replace gravity containers with a single universe container.

- [ ] **Step 1: Read current index.html for exact lines**

Read `src/ui/index.html` to confirm exact line numbers before editing.

- [ ] **Step 2: Update script tags**

Remove these script tags:
```html
<script src="https://unpkg.com/three-spritetext@1.9.5/dist/three-spritetext.min.js"></script>
<script src="https://unpkg.com/3d-force-graph@1.79.1/dist/3d-force-graph.min.js"></script>
<script src="gravity.js"></script>
<script src="gravity3d.js"></script>
```

Add Three.js addons. Note: `examples/js/` was deprecated after r149. Use r149 which still ships the non-module builds, or verify the CDN URL resolves before committing. If r160 is required, use an importmap + ESM approach instead.

```html
<script src="https://cdn.jsdelivr.net/npm/three@0.149.0/examples/js/controls/OrbitControls.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.149.0/examples/js/postprocessing/EffectComposer.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.149.0/examples/js/postprocessing/RenderPass.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.149.0/examples/js/postprocessing/UnrealBloomPass.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.149.0/examples/js/shaders/CopyShader.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.149.0/examples/js/shaders/LuminosityHighPassShader.js"></script>
<script src="universe.js"></script>
```

Also update the Three.js core script tag to match:
```html
<script src="https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js"></script>
```

- [ ] **Step 3: Update gravity container HTML**

Replace the gravity container block with:
```html
<div class="gravity-container" id="gravity-container" style="display:none">
  <div id="universe-container" style="width:100%;height:100%;position:relative;"></div>
  <div class="gravity-hud" id="gravity-hud"></div>
  <div class="gravity-tooltip" id="gravity-tooltip"></div>
  <div class="universe-filter-bar" id="universe-filter-bar">
    <button class="filter-btn active" data-filter="all" onclick="Universe.setFilter && Universe.setFilter('all')">All</button>
    <button class="filter-btn" data-filter="read" onclick="Universe.setFilter && Universe.setFilter('read')">Read</button>
    <button class="filter-btn" data-filter="edit" onclick="Universe.setFilter && Universe.setFilter('edit')">Edit</button>
    <button class="filter-btn" data-filter="exec" onclick="Universe.setFilter && Universe.setFilter('exec')">Exec</button>
  </div>
  <div class="universe-vignette"></div>
</div>
```

Remove the 2D/3D toggle buttons (`gravity-mode-toggle` div).

- [ ] **Step 4: Commit**

```bash
git add src/ui/index.html
git commit -m "feat: update index.html for universe renderer — remove old deps, add Three.js addons"
```

---

## Task 13: Integrate — Update app.js

**Files:**
- Modify: `src/ui/app.js`

Replace all `Gravity.*` and `Gravity3D.*` calls with `Universe.*`. Remove 2D/3D dimension toggle logic. Simplify the view toggle to just init/show the universe.

- [ ] **Step 1: Read app.js around the gravity integration points**

Read `src/ui/app.js` at the key line ranges:
- Lines 609-610 (entry feeding)
- Lines 1399-1410 (state variables and toggleView)
- Lines 1426-1463 (setGravityDim and applyGravityDim)
- Lines 1465-1483 (HUD and tooltip polling)
- Lines 1291-1292 (zoom keyboard shortcuts)

- [ ] **Step 2: Replace state variables and toggleView**

Replace the gravity state block (~lines 1399-1407):
```javascript
let gravityView = false;
let universeInitialized = false;
const universeContainer = document.getElementById("universe-container");
const gravityContainer = document.getElementById("gravity-container");
const gravityTooltip = document.getElementById("gravity-tooltip");
const gravityHud = document.getElementById("gravity-hud");
```

Replace `toggleView()` (~line 1409). Note: preserve the grid controls hiding logic from the original:
```javascript
window.toggleView = () => {
  gravityView = !gravityView;
  viewToggleBtn.classList.toggle("active", gravityView);
  if (gravityView) {
    paneContainer.style.display = "none";
    gravityContainer.style.display = "";
    if (gridControls) gridControls.style.display = "none";
    if (gridSep) gridSep.style.display = "none";
    if (!universeInitialized) {
      Universe.init(universeContainer);
      Universe.addEntries(entries);
      universeInitialized = true;
    }
  } else {
    gravityContainer.style.display = "none";
    paneContainer.style.display = "";
    updateGridControlsVisibility();
  }
};
```

- [ ] **Step 3: Remove setGravityDim and applyGravityDim**

Delete the entire `setGravityDim()` function and `applyGravityDim()` function (~lines 1426-1463). They are no longer needed.

- [ ] **Step 4: Replace entry feeding**

Replace lines 609-610:
```javascript
// Before:
// if (gravityInitialized) Gravity.addEntry(entry);
// if (gravity3dInitialized) Gravity3D.addEntry(entry);

// After:
if (universeInitialized) Universe.addEntry(entry);
```

- [ ] **Step 5: Replace tooltip polling**

Replace the tooltip setInterval (~lines 1474-1483):
```javascript
setInterval(() => {
  if (!gravityView) return;
  const info = Universe.getTooltip();
  if (info) {
    gravityTooltip.innerHTML = `<span class="gt-file">${info.label}</span> <span class="gt-dir">${info.dir}</span><br>` +
      `<span class="gt-stat">Read ${info.readCount}</span> <span class="gt-stat">Edit ${info.editCount}</span> <span class="gt-stat">Exec ${info.execCount}</span><br>` +
      `<span class="gt-class">${info.classification} · Importance ${info.importance}</span>`;
    gravityTooltip.classList.add("visible");
  } else {
    gravityTooltip.classList.remove("visible");
  }
}, 100);
```

- [ ] **Step 6: Replace HUD update**

Replace `updateGravityHud()` (~lines 1465-1471):
```javascript
window.updateGravityHud = function updateGravityHud() {
  if (!gravityHud || !gravityView || !universeInitialized) return;
  const stats = Universe.getStats();
  if (stats) {
    gravityHud.textContent = `${stats.visible}/${stats.total} files · ${stats.edges} edges · zoom ${stats.zoom}`;
  }
};
setInterval(updateGravityHud, 500);
```

- [ ] **Step 7: Replace zoom keyboard shortcuts**

Replace zoom shortcut lines (~1291-1292):
```javascript
if ((e.key === "=" || e.key === "+") && e.metaKey && e.shiftKey) {
  if (gravityView) Universe.zoom(1.2);
}
if ((e.key === "-" || e.key === "_") && e.metaKey && e.shiftKey) {
  if (gravityView) Universe.zoom(0.8);
}
```

- [ ] **Step 8: Commit**

```bash
git add src/ui/app.js
git commit -m "feat: integrate Universe into app.js — replace Gravity/Gravity3D calls"
```

---

## Task 14: Integrate — Update styles.css

**Files:**
- Modify: `src/ui/styles.css`

Remove 2D gravity-specific styles. Add universe filter bar, vignette, and updated tooltip styles.

- [ ] **Step 1: Read relevant CSS sections**

Search `src/ui/styles.css` for these selectors: `.gravity-mode-toggle`, `.gravity-dim-btn`, `.gravity-legend-3d`, `.gravity-tooltip`, `.gravity-hud`, `#gravity-3d`, `#view-toggle-btn`.

- [ ] **Step 2: Remove obsolete styles**

Remove all rules matching these selectors (search by name, not line number):
- `.gravity-mode-toggle` and `.gravity-dim-btn` (2D/3D toggle — no longer needed)
- `.gravity-legend-3d` and `.gl-row`, `.gl-dot`, `.gl-ray` within it (old legend)
- `#gravity-3d` (old 3D container)

Keep `.gravity-container`, `.gravity-hud`, and `.gravity-tooltip` — we'll update them.

- [ ] **Step 3: Add universe-specific styles**

Add at the end of the gravity section:

```css
/* Universe filter bar */
.universe-filter-bar {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 2px;
  z-index: 10;
  background: rgba(5, 5, 16, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 16px;
  padding: 3px;
  backdrop-filter: blur(8px);
}

.filter-btn {
  font: 400 10px "SF Mono", Menlo, monospace;
  padding: 4px 12px;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  transition: all 0.2s;
}

.filter-btn:hover {
  color: rgba(255, 255, 255, 0.7);
}

.filter-btn.active {
  background: rgba(126, 184, 255, 0.15);
  color: rgba(126, 184, 255, 0.9);
}

/* Vignette overlay */
.universe-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 200px rgba(0, 0, 0, 0.5);
  z-index: 5;
}

/* Updated tooltip for universe */
.gravity-tooltip {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(5, 5, 16, 0.85);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 10px 14px;
  font: 400 10px "SF Mono", Menlo, monospace;
  color: rgba(255, 255, 255, 0.6);
  pointer-events: none;
  display: none;
  z-index: 15;
  max-width: 300px;
  line-height: 1.6;
}

.gravity-tooltip.visible {
  display: block;
}

.gravity-tooltip .gt-file {
  color: rgba(255, 255, 255, 0.9);
}

.gravity-tooltip .gt-dir {
  color: rgba(255, 255, 255, 0.35);
}

.gravity-tooltip .gt-stat {
  color: rgba(255, 255, 255, 0.5);
  margin-right: 8px;
}

.gravity-tooltip .gt-class {
  color: rgba(255, 255, 255, 0.3);
  font-size: 9px;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/styles.css
git commit -m "feat: update CSS for universe filter bar, vignette, and glassmorphic tooltip"
```

---

## Task 15: Delete Old Files & Final Verification

**Files:**
- Delete: `src/ui/gravity.js`
- Delete: `src/ui/gravity3d.js`

- [ ] **Step 1: Delete old renderer files**

```bash
cd /Users/tomyang/pal/loupe
rm src/ui/gravity.js src/ui/gravity3d.js
```

- [ ] **Step 2: Verify no remaining references**

```bash
grep -r "Gravity\." src/ui/app.js
grep -r "Gravity3D" src/ui/app.js
grep -r "gravity\.js" src/ui/index.html
grep -r "gravity3d\.js" src/ui/index.html
```

Expected: no matches for any of these.

- [ ] **Step 3: Verify all files parse correctly**

```bash
cd /Users/tomyang/pal/loupe
node -c src/ui/universe.js
node -c src/ui/app.js
```

Expected: no output (syntax OK)

- [ ] **Step 4: Manual smoke test**

Start the server and open the UI:
```bash
cd /Users/tomyang/pal/loupe && node src/server/index.js
```

Open `http://localhost:<port>` in browser. Verify:
1. Background star field with 3 parallax layers renders
2. Nebula clouds breathe slowly
3. Clicking "Map" button shows the universe view
4. If there's session data, nodes appear as colored stars
5. Hovering a node reveals connected edges
6. Double-clicking flies camera to node
7. Scroll zooms, drag orbits
8. Filter buttons work
9. Stats HUD shows in top-right
10. Vignette darkens edges

- [ ] **Step 5: Commit deletion**

```bash
git add -u
git commit -m "chore: remove gravity.js and gravity3d.js — replaced by universe.js"
```

- [ ] **Step 6: Final commit with all changes verified**

```bash
git log --oneline -15
```

Verify the commit history shows all tasks completed cleanly.

---

## Deferred Features (V2)

These spec features are intentionally deferred from this plan to keep scope manageable. Each can be added as a follow-up task:

- **Secondary filters** (Spec §4): Recency and directory filter collapsible panel with "More Filters" button
- **Legend** (Spec §7): Collapsible bottom-left legend showing star classification and edge type colors
- **Empty state** (Spec §8): "Waiting for activity..." HUD message when no files accessed yet

---

## Implementation Notes

- **PlaneGeometry billboards** are used for nodes instead of the spec's SphereGeometry. This is a deliberate optimization — a 2-triangle billboard with the corona baked into the fragment shader is much cheaper than a 144-triangle sphere per instance, and looks identical from the camera's perspective.
- **ResizeObserver callback**: Task 7 (bloom) modifies the ResizeObserver callback created in Task 1. Find the existing `resizeObserver = new ResizeObserver(...)` block and add `if (composer) composer.setSize(w2, h2);` after the `camera.updateProjectionMatrix()` line.
- **rebuildNodes() grows across tasks**: Task 3 creates it. Task 4 adds `initSimulation()` call at the end. Task 9 adds `rebuildOrbitals()` call at the end. Each is an append, not a replacement.
