"use strict";

// ===== File Gravity Map =====
// Force-directed graph with directory ring layout, fisheye lens, and ray pulses.

const Gravity = (() => {
  // --- State ---
  let canvas, ctx;
  let width = 0, height = 0;
  let simulation = null;
  let nodes = new Map();
  let edges = new Map();
  let lastToolBySession = new Map();
  let activeFiles = new Map();
  let pulses = [];
  let labelCounts = new Map();

  // Camera
  let camX = 0, camY = 0, camZoom = 1;
  let targetCamX = 0, targetCamY = 0;
  let isDragging = false, dragStartX = 0, dragStartY = 0, dragCamX = 0, dragCamY = 0;
  let hoveredNode = null;
  let selectedNode = null;
  let draggingNode = null;

  // Claude presence — tracks where Claude is right now
  let claudePresence = []; // [{file, ts, action}] — last few tool uses
  const PRESENCE_WINDOW = 3000; // show presence for 3 seconds
  const MAX_PRESENCE = 2; // only show last 2 locations
  let claudeTrail = []; // [{fromFile, toFile, ts}] — most recent movement
  const MAX_TRAIL = 1; // only show 1 trail line

  // Fisheye (subtle)
  let fisheyeX = 0, fisheyeY = 0;
  let fisheyeActive = false;
  let fisheyeStrength = 0; // animated 0→1
  const FISHEYE_RADIUS = 180;
  const FISHEYE_DISTORTION = 1.8;
  const FISHEYE_MAX_SCALE = 1.6;

  // Animation
  let animFrame = null;
  let lastRenderTime = 0;

  // Config
  const GLOW_DURATION = 30000;
  const WARM_DURATION = 120000;
  const STALE_CUTOFF = 30 * 60 * 1000; // 30 min — hide nodes older than this
  const NODE_MIN_R = 3;
  const NODE_MAX_R = 20;
  const EDGE_MIN_W = 0.3;
  const EDGE_MAX_W = 3;
  const LABEL_MIN_ACCESS = 3;
  const EDGE_MIN_WEIGHT = 2;

  const TOOL_ACTIONS = {
    Read: "read", Grep: "read", Glob: "read",
    Edit: "edit", Write: "edit",
    Bash: "exec", Agent: "delegate",
  };

  function classifyEdge(prevAction, prevFile, currAction, currFile) {
    if (prevAction === "read" && currAction === "edit") return "prerequisite";
    if (prevAction === "edit" && currAction === "edit" && prevFile !== currFile) return "coupling";
    if (prevAction === "edit" && currAction === "exec") return "validation";
    if (prevAction === "read" && currAction === "read") return "discovery";
    return "sequence";
  }

  // --- Star Classification ---
  const STAR_CLASSES = [
    { name: "Red Dwarf",    minImp: 1,  maxImp: 3,  dark: "#ff6b4a", light: "#c44a30" },
    { name: "Orange Dwarf", minImp: 4,  maxImp: 8,  dark: "#ff9f43", light: "#b06a1e" },
    { name: "Yellow Star",  minImp: 9,  maxImp: 15, dark: "#ffd93d", light: "#8a7a18" },
    { name: "White Star",   minImp: 16, maxImp: 25, dark: "#f0f0ff", light: "#505068" },
    { name: "Blue Giant",   minImp: 26, maxImp: Infinity, dark: "#7eb8ff", light: "#2a5a8a" },
  ];

  function getImportance(n) {
    return (n.editCount || 0) * 3 + (n.execCount || 0) * 2 + (n.readCount || 0);
  }

  function getStarClass(node) {
    const imp = getImportance(node);
    for (const sc of STAR_CLASSES) {
      if (imp >= sc.minImp && imp <= sc.maxImp) return sc;
    }
    return STAR_CLASSES[0];
  }

  // --- Filter ---
  let activeFilter = "all";

  // --- Colors ---
  function getNodeColor(node, theme) {
    const dark = theme === "dark";
    const sc = getStarClass(node);
    return dark ? sc.dark : sc.light;
  }

  function getEdgeColor(edge, theme, solid) {
    const dark = theme === "dark";
    if (solid) {
      return ({ prerequisite: dark ? "#8b5cf6" : "#7c3aed", coupling: dark ? "#f97316" : "#c2410c", validation: dark ? "#4ade80" : "#16a34a", discovery: dark ? "#3b82f6" : "#2563eb", sequence: dark ? "#475569" : "#94a3b8" })[edge.type] || (dark ? "#475569" : "#94a3b8");
    }
    return ({ prerequisite: dark ? "rgba(139,92,246,0.4)" : "rgba(124,58,237,0.3)", coupling: dark ? "rgba(249,115,22,0.4)" : "rgba(194,65,12,0.3)", validation: dark ? "rgba(74,222,128,0.4)" : "rgba(22,163,74,0.3)", discovery: dark ? "rgba(59,130,246,0.3)" : "rgba(37,99,235,0.2)", sequence: dark ? "rgba(100,116,139,0.08)" : "rgba(100,116,139,0.05)" })[edge.type] || (dark ? "rgba(100,116,139,0.08)" : "rgba(100,116,139,0.05)");
  }

  // --- Helpers ---
  function shortName(fp) { if (!fp) return "?"; const p = fp.split("/"); return p[p.length - 1] || p[p.length - 2] || fp; }

  function dirGroup(fp) {
    if (!fp) return "";
    const p = fp.split("/");
    if (p.length >= 3) return p.slice(-3, -1).join("/");
    if (p.length >= 2) return p[p.length - 2];
    return "";
  }

  function disambiguatedLabel(node) {
    if ((labelCounts.get(node.label) || 0) > 1 && node.dir) {
      const dp = node.dir.split("/");
      const parent = dp[dp.length - 1] || dp[dp.length - 2] || "";
      return parent ? `${parent}/${node.label}` : node.label;
    }
    return node.label;
  }

  function rebuildLabelCounts() {
    labelCounts.clear();
    for (const n of nodes.values()) labelCounts.set(n.label, (labelCounts.get(n.label) || 0) + 1);
  }

  function hexToRgb(hex) {
    if (!hex || hex[0] !== "#") return null;
    const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return r ? { r: parseInt(r[1], 16), g: parseInt(r[2], 16), b: parseInt(r[3], 16) } : null;
  }

  // --- Graph building ---
  function getOrCreateNode(fp) {
    if (nodes.has(fp)) return nodes.get(fp);
    // blobSeed: 8 random offsets for organic blob shape (consistent per node)
    const blobSeed = Array.from({length: 8}, () => 0.92 + Math.random() * 0.16);
    const n = { id: fp, label: shortName(fp), dir: dirGroup(fp), accessCount: 0, readCount: 0, editCount: 0, execCount: 0, lastAction: "read", lastAccessTs: 0, x: width / 2 + (Math.random() - 0.5) * 300, y: height / 2 + (Math.random() - 0.5) * 300, vx: 0, vy: 0, fx: null, fy: null, blobSeed };
    nodes.set(fp, n);
    return n;
  }

  function getOrCreateEdge(src, dst, type) {
    const key = `${src}|${dst}|${type}`;
    if (edges.has(key)) return edges.get(key);
    const e = { key, source: src, target: dst, type, weight: 0, lastTs: 0 };
    edges.set(key, e);
    return e;
  }

  function extractFilePath(entry) {
    const json = entry.json; if (!json) return null;
    const hook = (json._logstream_type && json.data) ? json.data : null;
    const inner = hook || json;
    const input = inner.tool_input || inner.input || {};
    if (input.file_path) return input.file_path;
    if (input.path && !input.command) return input.path;
    if (input.command) { const m = input.command.match(/(?:^|\s)(\/\S+\.\w+)/); if (m) return m[1]; }
    return null;
  }

  function extractToolName(entry) {
    const json = entry.json; if (!json) return null;
    const hook = (json._logstream_type && json.data) ? json.data : null;
    return (hook || json).tool_name || (hook || json).name || null;
  }

  function processEntry(entry) {
    const json = entry.json; if (!json) return false;
    if (json._logstream_type !== "PreToolUse") return false;
    const toolName = extractToolName(entry);
    const fp = extractFilePath(entry);
    if (!fp || !toolName || !fp.startsWith("/") || fp.includes("/node_modules/") || fp.includes("/.git/")) return false;

    const action = TOOL_ACTIONS[toolName] || "read";
    const sessionId = entry.sessionId || "default";
    const ts = entry.ts || Date.now();
    const node = getOrCreateNode(fp);
    node.accessCount++;
    node.lastAction = action;
    node.lastAccessTs = ts;
    if (action === "read") node.readCount++;
    else if (action === "edit") node.editCount++;
    else if (action === "exec") node.execCount++;
    activeFiles.set(fp, ts);

    const prev = lastToolBySession.get(sessionId);
    if (prev && prev.file !== fp && (ts - prev.ts) < 60000) {
      const et = classifyEdge(prev.action, prev.file, action, fp);
      const edge = getOrCreateEdge(prev.file, fp, et);
      edge.weight++;
      edge.lastTs = ts;
      getOrCreateNode(prev.file);
      if (Date.now() - ts < 5000) spawnPulse(edge);
    }
    lastToolBySession.set(sessionId, { tool: toolName, action, file: fp, ts });

    // Track Claude's presence
    const prevPresence = claudePresence.length > 0 ? claudePresence[claudePresence.length - 1] : null;
    claudePresence.push({ file: fp, ts: Date.now(), action });
    // Trail line from previous location
    if (prevPresence && prevPresence.file !== fp) {
      claudeTrail.push({ fromFile: prevPresence.file, toFile: fp, ts: Date.now() });
    }

    return true;
  }

  // --- Ray pulses ---
  const PULSE_DURATION = 800;
  const RAY_LENGTH = 0.18; // fraction of edge length for the ray tail

  function spawnPulse(edge) {
    pulses.push({ source: edge.source, target: edge.target, type: edge.type, startTime: Date.now(), duration: PULSE_DURATION });
  }

  let ambientPulseTimer = null;
  function startAmbientPulses() {
    if (ambientPulseTimer) return;
    ambientPulseTimer = setInterval(() => {
      for (const edge of edges.values()) {
        if (edge.weight < 5) continue;
        // Only pulse between visible nodes
        const srcN = nodes.get(edge.source);
        const dstN = nodes.get(edge.target);
        if (!srcN || !dstN || !nodeVisible(srcN) || !nodeVisible(dstN)) continue;
        if (Math.random() < 0.025 * Math.min(edge.weight / 10, 1)) spawnPulse(edge);
      }
      pulses = pulses.filter(p => Date.now() - p.startTime < p.duration);
    }, 200);
  }

  function drawRayPulse(src, dst, t, color, theme) {
    const dark = (theme === "dark");
    const rgb = hexToRgb(color);
    if (!rgb) return;

    // Ray head position
    const headT = t;
    const tailT = Math.max(0, t - RAY_LENGTH);

    const hx = src.x + (dst.x - src.x) * headT;
    const hy = src.y + (dst.y - src.y) * headT;
    const tx = src.x + (dst.x - src.x) * tailT;
    const ty = src.y + (dst.y - src.y) * tailT;

    // Fade in at start, fade out at end
    const intensity = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;

    // Draw ray as gradient line
    const grad = ctx.createLinearGradient(tx, ty, hx, hy);
    grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
    grad.addColorStop(0.3, `rgba(${rgb.r},${rgb.g},${rgb.b},${intensity * 0.4})`);
    grad.addColorStop(0.8, `rgba(${rgb.r},${rgb.g},${rgb.b},${intensity * 0.8})`);
    grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},${intensity})`);

    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.stroke();

    // Bright head glow
    ctx.beginPath();
    ctx.arc(hx, hy, 4, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${intensity * 0.3})`;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx, hy, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${intensity * 0.9})`;
    ctx.fill();
  }

  // --- Fisheye (subtle, smooth) ---
  function fisheyeTransform(node) {
    if (fisheyeStrength < 0.01) return { x: node.x, y: node.y, scale: 1 };
    const dx = node.x - fisheyeX;
    const dy = node.y - fisheyeY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return { x: node.x, y: node.y, scale: 1 + fisheyeStrength * (FISHEYE_MAX_SCALE - 1) };
    if (dist > FISHEYE_RADIUS) return { x: node.x, y: node.y, scale: 1 };

    const norm = dist / FISHEYE_RADIUS;
    const k = FISHEYE_DISTORTION * fisheyeStrength;
    const distorted = (1 - Math.exp(-k * norm)) / (1 - Math.exp(-k));
    const newDist = distorted * FISHEYE_RADIUS;
    const scale = 1 + (1 - norm) * (FISHEYE_MAX_SCALE - 1) * fisheyeStrength;

    return {
      x: fisheyeX + (dx / dist) * newDist,
      y: fisheyeY + (dy / dist) * newDist,
      scale,
    };
  }

  // --- Force simulation ---
  function rebuildSimulation() {
    rebuildLabelCounts();

    const nodeArray = [...nodes.values()];
    const edgeArray = [...edges.values()].map(e => ({
      source: nodes.get(e.source), target: nodes.get(e.target), weight: e.weight, type: e.type,
    })).filter(e => e.source && e.target);

    const dirGroups = new Map();
    for (const n of nodeArray) {
      const d = n.dir || "__root__";
      if (!dirGroups.has(d)) dirGroups.set(d, []);
      dirGroups.get(d).push(n);
    }

    if (simulation) simulation.stop();

    simulation = d3.forceSimulation(nodeArray)
      .force("charge", d3.forceManyBody().strength(-120).distanceMax(350))
      .force("link", d3.forceLink(edgeArray).id(d => d.id).distance(80).strength(e => 0.08 + e.weight * 0.01))
      .force("center", d3.forceCenter(width / 2, height / 2).strength(0.015))
      .force("collision", d3.forceCollide().radius(d => nodeRadius(d) + 5))
      .force("cluster", clusterForce(dirGroups, 0.08))
      .alphaDecay(0.02)
      .on("tick", () => {});

    for (let i = 0; i < 60; i++) simulation.tick();
    startAmbientPulses();
  }

  function clusterForce(dirGroups, strength) {
    return function(alpha) {
      for (const [, group] of dirGroups) {
        if (group.length < 2) continue;
        let cx = 0, cy = 0;
        for (const n of group) { cx += n.x; cy += n.y; }
        cx /= group.length; cy /= group.length;
        for (const n of group) {
          n.vx += (cx - n.x) * strength * alpha;
          n.vy += (cy - n.y) * strength * alpha;
        }
      }
    };
  }

  function nodeImportance(node) {
    return node.editCount * 3 + node.execCount * 2 + node.readCount;
  }

  function nodeRadius(node) {
    return Math.min(NODE_MAX_R, NODE_MIN_R + Math.sqrt(nodeImportance(node)) * 2.2);
  }

  // --- Camera (only auto-pans to active files; respects manual drag) ---
  let userDragged = false;

  function updateCamera() {
    const now = Date.now();
    let tw = 0, cx = 0, cy = 0;
    for (const [path, ts] of activeFiles) {
      const age = now - ts; if (age > WARM_DURATION) continue;
      const node = nodes.get(path); if (!node) continue;
      const w = age < GLOW_DURATION ? 3 : 1;
      cx += node.x * w; cy += node.y * w; tw += w;
    }
    // Only auto-pan when active files exist AND user hasn't manually panned
    if (tw > 0 && !userDragged) {
      targetCamX = cx / tw - width / 2;
      targetCamY = cy / tw - height / 2;
    }
    if (!isDragging) {
      camX += (targetCamX - camX) * 0.05;
      camY += (targetCamY - camY) * 0.05;
    }
  }

  // --- Semantic zoom ---
  function nodeVisible(node) {
    if (node === hoveredNode || node === selectedNode) return true;
    // Hide nodes older than 30 min
    const age = Date.now() - node.lastAccessTs;
    if (age > STALE_CUTOFF) return false;
    if (camZoom < 0.5) return node.accessCount >= 5;
    if (camZoom < 0.8) return node.accessCount >= 2;
    return true;
  }

  function edgeVisible(edge) {
    if (camZoom < 0.5) return edge.weight >= 5;
    if (camZoom < 0.8) return edge.weight >= EDGE_MIN_WEIGHT;
    return edge.weight >= EDGE_MIN_WEIGHT || edge.type !== "sequence";
  }

  function shouldShowLabel(node, r, isGlowing, isWarm, isHovered, isSelected, fs) {
    if (isHovered || isSelected) return true;
    if (isGlowing || isWarm) return node.accessCount >= 2;
    const er = r * fs;
    if (camZoom < 0.5) return node.accessCount >= 8 && er > 5;
    if (camZoom < 0.8) return node.accessCount >= LABEL_MIN_ACCESS;
    return node.accessCount >= LABEL_MIN_ACCESS || er > 7;
  }

  // --- Universe Background ---
  let bgStars = null;
  let nebulaCache = null;

  function initBackground() {
    // Generate star positions once
    bgStars = [];
    const layers = [
      { count: 600, sizeRange: [0.4, 1.0], opRange: [0.15, 0.35] },
      { count: 150, sizeRange: [0.8, 1.5], opRange: [0.3, 0.6] },
      { count: 40,  sizeRange: [1.2, 2.2], opRange: [0.5, 0.9] },
    ];
    const colors = ["#ffffff","#ffffff","#ffffff","#ffffff","#ccd4ff","#ccd4ff","#ffe8c0","#ffcca0"];
    for (const cfg of layers) {
      for (let i = 0; i < cfg.count; i++) {
        bgStars.push({
          x: Math.random(), y: Math.random(),
          size: cfg.sizeRange[0] + Math.random() * (cfg.sizeRange[1] - cfg.sizeRange[0]),
          opacity: cfg.opRange[0] + Math.random() * (cfg.opRange[1] - cfg.opRange[0]),
          color: colors[Math.floor(Math.random() * colors.length)],
          lightColor: ["#8890a0","#808898","#a09888","#988880","#707888"][Math.floor(Math.random() * 5)],
          twinkle: Math.random() < 0.08 ? Math.random() * Math.PI * 2 : -1,
          twinkleSpeed: 2 + Math.random() * 3,
          drift: cfg === layers[0] ? 0.0003 : cfg === layers[1] ? 0.0008 : 0.002,
        });
      }
    }
  }

  function drawBackground(dark, now) {
    if (!bgStars) initBackground();
    const t = now / 1000;

    if (dark) {
      // Nebula clouds
      const nebulae = [
        { x: 0.2, y: 0.3, rx: width * 0.25, ry: width * 0.15, color: [60, 40, 120, 0.06] },
        { x: 0.75, y: 0.65, rx: width * 0.2, ry: width * 0.18, color: [30, 60, 100, 0.05] },
        { x: 0.5, y: 0.8, rx: width * 0.18, ry: width * 0.1, color: [80, 30, 50, 0.04] },
      ];
      for (const n of nebulae) {
        const breathe = 1 + 0.05 * Math.sin(t / 20 * Math.PI * 2);
        const cx = n.x * width + Math.sin(t / 30) * 3;
        const cy = n.y * height + Math.cos(t / 25) * 2;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, n.rx * breathe);
        grad.addColorStop(0, `rgba(${n.color[0]},${n.color[1]},${n.color[2]},${n.color[3]})`);
        grad.addColorStop(0.5, `rgba(${n.color[0]},${n.color[1]},${n.color[2]},${n.color[3] * 0.4})`);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
      }

      // Stars
      for (const s of bgStars) {
        let op = s.opacity * 0.7;
        if (s.twinkle >= 0) op *= (0.5 + 0.5 * Math.sin(t / s.twinkleSpeed * Math.PI * 2 + s.twinkle));
        ctx.globalAlpha = op;
        ctx.fillStyle = s.color;
        const sx = ((s.x * width + camX * s.drift * width) % width + width) % width;
        const sy = ((s.y * height + camY * s.drift * height) % height + height) % height;
        ctx.beginPath();
        ctx.arc(sx, sy, s.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      // Light mode: visible dots mirroring dark mode
      for (const s of bgStars) {
        let op = s.opacity * 0.5;
        if (s.twinkle >= 0) op *= (0.6 + 0.4 * Math.sin(t / s.twinkleSpeed * Math.PI * 2 + s.twinkle));
        ctx.globalAlpha = op;
        ctx.fillStyle = s.lightColor;
        const sx = ((s.x * width + camX * s.drift * width) % width + width) % width;
        const sy = ((s.y * height + camY * s.drift * height) % height + height) % height;
        ctx.beginPath();
        ctx.arc(sx, sy, s.size * 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // Light mode nebula: soft shadow-like washes (inverted nebula)
      const lightNebulae = [
        { x: 0.2, y: 0.3, rx: width * 0.25, color: [120, 100, 160, 0.03] },
        { x: 0.75, y: 0.65, rx: width * 0.2, color: [100, 130, 160, 0.025] },
        { x: 0.5, y: 0.8, rx: width * 0.18, color: [160, 110, 100, 0.02] },
      ];
      for (const n of lightNebulae) {
        const breathe = 1 + 0.04 * Math.sin(t / 22 * Math.PI * 2);
        const cx = n.x * width;
        const cy = n.y * height;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, n.rx * breathe);
        grad.addColorStop(0, `rgba(${n.color[0]},${n.color[1]},${n.color[2]},${n.color[3]})`);
        grad.addColorStop(0.6, `rgba(${n.color[0]},${n.color[1]},${n.color[2]},${n.color[3] * 0.3})`);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.globalAlpha = 1;
    }
  }

  // --- Edge Hover Detection & Label ---
  let hoveredEdge = null;

  function findEdgeAtMouse(mx, my) {
    const worldX = mx / camZoom + camX;
    const worldY = my / camZoom + camY;
    const threshold = 8 / camZoom;
    let closest = null;
    let closestDist = threshold;

    for (const edge of edges.values()) {
      if (!edgeVisible(edge)) continue;
      const srcN = nodes.get(edge.source);
      const dstN = nodes.get(edge.target);
      if (!srcN || !dstN || !nodeVisible(srcN) || !nodeVisible(dstN)) continue;

      const fs = fisheyeTransform(srcN);
      const fd = fisheyeTransform(dstN);
      const d = pointToSegmentDist(worldX, worldY, fs.x, fs.y, fd.x, fd.y);
      if (d < closestDist) { closestDist = d; closest = edge; }
    }
    return closest;
  }

  function pointToSegmentDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  const EDGE_TYPE_LABELS = {
    prerequisite: "Read \u2192 Edit",
    coupling: "Edit \u2192 Edit",
    validation: "Edit \u2192 Exec",
    discovery: "Search \u2192 Read",
    sequence: "Sequential",
  };

  function drawEdgeLabel(edge, dark) {
    const srcN = nodes.get(edge.source);
    const dstN = nodes.get(edge.target);
    if (!srcN || !dstN) return;
    const fs = fisheyeTransform(srcN);
    const fd = fisheyeTransform(dstN);
    const mx = (fs.x + fd.x) / 2;
    const my = (fs.y + fd.y) / 2;
    const label = EDGE_TYPE_LABELS[edge.type] || edge.type;
    const srcLabel = shortName(edge.source);
    const dstLabel = shortName(edge.target);
    const fullLabel = `${srcLabel}  ${label}  ${dstLabel}`;

    ctx.font = '500 9px "SF Mono","JetBrains Mono",Menlo,monospace';
    const tw = ctx.measureText(fullLabel).width;
    const pad = 6;
    const bw = tw + pad * 2;
    const bh = 20;

    // Background pill
    ctx.fillStyle = dark ? "rgba(5,5,16,0.85)" : "rgba(255,255,255,0.9)";
    ctx.beginPath();
    const rx = mx - bw / 2, ry = my - bh / 2, cr = 4;
    ctx.moveTo(rx + cr, ry);
    ctx.lineTo(rx + bw - cr, ry);
    ctx.quadraticCurveTo(rx + bw, ry, rx + bw, ry + cr);
    ctx.lineTo(rx + bw, ry + bh - cr);
    ctx.quadraticCurveTo(rx + bw, ry + bh, rx + bw - cr, ry + bh);
    ctx.lineTo(rx + cr, ry + bh);
    ctx.quadraticCurveTo(rx, ry + bh, rx, ry + bh - cr);
    ctx.lineTo(rx, ry + cr);
    ctx.quadraticCurveTo(rx, ry, rx + cr, ry);
    ctx.fill();

    // Border
    ctx.strokeStyle = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Text
    ctx.fillStyle = dark ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.7)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(fullLabel, mx, my);
  }

  // --- Neighbor check (cached per frame) ---
  let hoverNeighbors = new Set();
  function buildHoverNeighbors() {
    hoverNeighbors.clear();
    if (!hoveredNode) return;
    hoverNeighbors.add(hoveredNode.id);
    for (const e of edges.values()) {
      if (e.source === hoveredNode.id) hoverNeighbors.add(e.target);
      if (e.target === hoveredNode.id) hoverNeighbors.add(e.source);
    }
  }

  // --- Rendering ---
  function render() {
    if (!canvas || !ctx) return;
    animFrame = requestAnimationFrame(render);
    const now = Date.now();
    if (now - lastRenderTime < 16) return;
    lastRenderTime = now;

    const theme = document.documentElement.dataset.theme || "dark";
    const dark = theme === "dark";
    const rect = canvas.parentElement.getBoundingClientRect();
    if (Math.round(rect.width) !== Math.round(width) || Math.round(rect.height) !== Math.round(height)) resizeCanvas();

    // Smooth fisheye transition
    const targetStr = fisheyeActive ? 1 : 0;
    fisheyeStrength += (targetStr - fisheyeStrength) * 0.12;

    buildHoverNeighbors();
    updateCamera();

    ctx.fillStyle = dark ? "#050510" : "#f0f1f5";
    ctx.fillRect(0, 0, width, height);
    drawBackground(dark, now);

    ctx.save();
    ctx.translate(-camX * camZoom, -camY * camZoom);
    ctx.scale(camZoom, camZoom);

    // --- Edges ---
    for (const edge of edges.values()) {
      if (!edgeVisible(edge)) continue;
      const srcN = nodes.get(edge.source);
      const dstN = nodes.get(edge.target);
      if (!srcN || !dstN || !nodeVisible(srcN) || !nodeVisible(dstN)) continue;

      const fs = fisheyeTransform(srcN);
      const fd = fisheyeTransform(dstN);
      const lw = Math.min(EDGE_MAX_W, EDGE_MIN_W + edge.weight * 0.35);
      const age = now - edge.lastTs;
      let opacity = age < GLOW_DURATION ? 0.8 : age < WARM_DURATION ? 0.5 : 0.3;

      const connected = fisheyeStrength > 0.01 && hoveredNode &&
        (edge.source === hoveredNode.id || edge.target === hoveredNode.id);
      if (fisheyeStrength > 0.01 && hoveredNode && !connected) opacity *= (1 - fisheyeStrength * 0.7);
      if (connected) opacity = Math.min(1, opacity * 1.5);

      ctx.globalAlpha = opacity;
      ctx.beginPath();
      ctx.moveTo(fs.x, fs.y);
      ctx.lineTo(fd.x, fd.y);
      ctx.strokeStyle = getEdgeColor(edge, theme, false);
      ctx.lineWidth = connected ? lw * 1.5 : lw;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // --- Ray pulses ---
    for (const pulse of pulses) {
      const srcN = nodes.get(pulse.source);
      const dstN = nodes.get(pulse.target);
      if (!srcN || !dstN || !nodeVisible(srcN) || !nodeVisible(dstN)) continue;
      const fs = fisheyeTransform(srcN);
      const fd = fisheyeTransform(dstN);
      const t = Math.min(1, (now - pulse.startTime) / pulse.duration);
      const eased = t * t * (3 - 2 * t);
      drawRayPulse(fs, fd, eased, getEdgeColor(pulse, theme, true), theme);
    }

    // --- Claude Trail (movement path) ---
    // Clean up old presence/trail entries, keep only most recent
    claudePresence = claudePresence.filter(p => now - p.ts < PRESENCE_WINDOW).slice(-MAX_PRESENCE);
    claudeTrail = claudeTrail.filter(t => now - t.ts < PRESENCE_WINDOW).slice(-MAX_TRAIL);
    // Draw trail line (just the most recent movement)
    for (const trail of claudeTrail) {
      const fromN = nodes.get(trail.fromFile);
      const toN = nodes.get(trail.toFile);
      if (!fromN || !toN) continue;
      const fs = fisheyeTransform(fromN);
      const fd = fisheyeTransform(toN);
      const trailAge = (now - trail.ts) / PRESENCE_WINDOW;
      const trailAlpha = (1 - trailAge) * 0.5;
      // Animated dash
      ctx.setLineDash([4, 6]);
      ctx.lineDashOffset = -(now / 50); // animate the dash
      ctx.beginPath();
      ctx.moveTo(fs.x, fs.y);
      ctx.lineTo(fd.x, fd.y);
      ctx.strokeStyle = dark ? `rgba(255,255,255,${trailAlpha})` : `rgba(0,0,0,${trailAlpha * 0.6})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- Nodes ---
    for (const node of nodes.values()) {
      if (!nodeVisible(node)) continue;
      const { x: fx, y: fy, scale: fsc } = fisheyeTransform(node);
      const baseR = nodeRadius(node);
      const r = baseR * fsc;
      const age = now - node.lastAccessTs;
      const isGlowing = age < GLOW_DURATION;
      const isWarm = age < WARM_DURATION;
      const isHovered = hoveredNode === node;
      const isSelected = selectedNode === node;
      const baseColor = getNodeColor(node, theme);
      const isNeighbor = hoverNeighbors.has(node.id);
      const dimmed = fisheyeStrength > 0.01 && hoveredNode && !isNeighbor;

      const rgb = hexToRgb(baseColor);
      const imp = getImportance(node);
      let alpha = isGlowing ? 0.9 : isWarm ? 0.6 : 0.3;
      if (activeFilter !== "all") {
        const matchesFilter = (activeFilter === "read" && node.readCount > 0) ||
          (activeFilter === "edit" && node.editCount > 0) ||
          (activeFilter === "exec" && node.execCount > 0);
        if (!matchesFilter) alpha = 0.08;
      }
      if (dimmed) alpha *= (1 - fisheyeStrength * 0.65);
      if (isHovered || isSelected) alpha = 1;
      ctx.globalAlpha = alpha;

      // === NODE SHAPE: Organic blob (celestial body) ===
      const seed = node.blobSeed || [1,1,1,1,1,1,1,1];
      const nPoints = 8;

      // Soft aura glow
      if (rgb && !dimmed) {
        const auraR = r * 2.5;
        const auraAlpha = (isGlowing ? 0.18 : isWarm ? 0.08 : 0.04) * alpha;
        const grad = ctx.createRadialGradient(fx, fy, r * 0.2, fx, fy, auraR);
        grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${auraAlpha})`);
        grad.addColorStop(0.5, `rgba(${rgb.r},${rgb.g},${rgb.b},${auraAlpha * 0.25})`);
        grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(fx, fy, auraR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Pulsing ring for active nodes
      if (isGlowing && rgb && !dimmed) {
        const pulseT = ((now % 2500) / 2500);
        const ringR = r * (1.2 + pulseT * 1.5);
        const ringAlpha = (1 - pulseT) * 0.25 * alpha;
        ctx.beginPath();
        ctx.arc(fx, fy, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${ringAlpha})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Build organic blob path using smooth curve through irregular points
      function blobPath(cx, cy, radius) {
        const pts = [];
        for (let i = 0; i < nPoints; i++) {
          const angle = (i / nPoints) * Math.PI * 2;
          const wobble = seed[i] * radius;
          pts.push({ x: cx + Math.cos(angle) * wobble, y: cy + Math.sin(angle) * wobble });
        }
        ctx.beginPath();
        // Smooth closed curve through points using quadratic bezier
        const last = pts[pts.length - 1];
        const first = pts[0];
        ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
        for (let i = 0; i < pts.length; i++) {
          const curr = pts[i];
          const next = pts[(i + 1) % pts.length];
          const midX = (curr.x + next.x) / 2;
          const midY = (curr.y + next.y) / 2;
          ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
        }
        ctx.closePath();
      }

      // Fill blob — flat color, clean
      blobPath(fx, fy, r);
      ctx.fillStyle = baseColor;
      ctx.fill();

      // Border on hover/select
      if (isHovered || isSelected) {
        blobPath(fx, fy, r);
        ctx.strokeStyle = dark ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.6)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Claude presence beacon
      const isClaudeHere = claudePresence.some(p => p.file === node.id && (now - p.ts) < PRESENCE_WINDOW);
      if (isClaudeHere && !dimmed) {
        // Animated beacon ring
        const beaconT = ((now % 1200) / 1200);
        const beaconR = r + 4 + beaconT * 12;
        const beaconAlpha = (1 - beaconT) * 0.6;
        ctx.beginPath();
        ctx.arc(fx, fy, beaconR, 0, Math.PI * 2);
        ctx.strokeStyle = dark ? `rgba(255,255,255,${beaconAlpha})` : `rgba(0,0,0,${beaconAlpha * 0.7})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        // Second ring, offset timing
        const beaconT2 = (((now + 600) % 1200) / 1200);
        const beaconR2 = r + 4 + beaconT2 * 12;
        const beaconAlpha2 = (1 - beaconT2) * 0.4;
        ctx.beginPath();
        ctx.arc(fx, fy, beaconR2, 0, Math.PI * 2);
        ctx.strokeStyle = dark ? `rgba(255,255,255,${beaconAlpha2})` : `rgba(0,0,0,${beaconAlpha2 * 0.5})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // Small "cursor" dot
        ctx.beginPath();
        ctx.arc(fx + r + 3, fy - r - 3, 3, 0, Math.PI * 2);
        ctx.fillStyle = dark ? "#ffffff" : "#000000";
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now / 300);
        ctx.fill();
        ctx.globalAlpha = alpha;
      }

      ctx.globalAlpha = 1;

      // Label
      if (shouldShowLabel(node, baseR, isGlowing, isWarm, isHovered, isSelected, fsc)) {
        const dl = disambiguatedLabel(node);
        const fsz = isHovered || isSelected ? 11 : Math.max(8, Math.min(10, 7 + fsc * 1.5));
        ctx.font = `${isHovered || isSelected ? "600" : "400"} ${fsz}px "SF Mono","JetBrains Mono",Menlo,monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        let la = isGlowing ? 0.85 : isWarm ? 0.55 : 0.3;
        if (dimmed) la *= (1 - fisheyeStrength * 0.65);
        if (isHovered || isSelected) la = 1;
        ctx.fillStyle = dark ? `rgba(241,245,249,${la})` : `rgba(15,23,42,${la})`;
        ctx.fillText(dl, fx, fy + r + 3);

        if (isHovered || isSelected) {
          ctx.font = '400 8px "SF Mono",Menlo,monospace';
          ctx.fillStyle = dark ? "rgba(148,163,184,0.7)" : "rgba(100,116,139,0.7)";
          ctx.fillText(node.dir, fx, fy + r + 15);
        }
      }
    }

    // Edge hover label (drawn in world space)
    if (hoveredEdge && !hoveredNode) {
      drawEdgeLabel(hoveredEdge, dark);
    }

    ctx.restore();
    drawLegend(dark);
    drawStats(dark, now);
  }

  function drawLegend(dark) {
    const x = 12, y = height - 120;
    const fg = dark ? "rgba(241,245,249,0.5)" : "rgba(15,23,42,0.5)";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";

    [{ c: dark ? "#3b82f6" : "#2563eb", l: "Read" }, { c: dark ? "#4ade80" : "#16a34a", l: "Edited" }, { c: dark ? "#f97316" : "#c2410c", l: "Executed" }].forEach((item, i) => {
      const iy = y + i * 14;
      ctx.beginPath(); ctx.arc(x + 4, iy, 4, 0, Math.PI * 2);
      ctx.fillStyle = item.c; ctx.fill();
      ctx.fillStyle = fg; ctx.font = '600 8px -apple-system,sans-serif';
      ctx.fillText(item.l, x + 14, iy);
    });

    const edgeItems = [
      { c: dark ? "#8b5cf6" : "#7c3aed", l: "Prerequisite (Read\u2192Edit)" },
      { c: dark ? "#f97316" : "#c2410c", l: "Coupling (Edit\u2192Edit)" },
      { c: dark ? "#4ade80" : "#16a34a", l: "Validation (Edit\u2192Run)" },
      { c: dark ? "#3b82f6" : "#2563eb", l: "Discovery (Search\u2192Read)" },
      { c: dark ? "#475569" : "#94a3b8", l: "Sequential" },
    ];

    const ey = y + 3 * 14 + 6;
    edgeItems.forEach((item, i) => {
      const iy = ey + i * 12;
      const lx = x, rx = x + 14;
      const rgb = hexToRgb(item.c);
      if (rgb) {
        const grad = ctx.createLinearGradient(lx, iy, rx, iy);
        grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        grad.addColorStop(0.6, `rgba(${rgb.r},${rgb.g},${rgb.b},0.6)`);
        grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},1)`);
        ctx.beginPath(); ctx.moveTo(lx, iy); ctx.lineTo(rx, iy);
        ctx.strokeStyle = grad; ctx.lineWidth = 2; ctx.lineCap = "round";
        ctx.stroke();
        ctx.beginPath(); ctx.arc(rx, iy, 1.2, 0, Math.PI * 2);
        ctx.fillStyle = "#fff"; ctx.fill();
      }
      ctx.fillStyle = fg; ctx.font = '400 7px -apple-system,sans-serif';
      ctx.fillText(item.l, x + 20, iy);
    });
  }

  function drawStats(dark, now) {
    const fg = dark ? "rgba(241,245,249,0.4)" : "rgba(15,23,42,0.4)";
    ctx.font = '400 9px "SF Mono",Menlo,monospace'; ctx.textAlign = "right"; ctx.textBaseline = "top";
    let ac = 0, wc = 0;
    for (const [, ts] of activeFiles) { const a = now - ts; if (a < GLOW_DURATION) ac++; else if (a < WARM_DURATION) wc++; }
    const vn = [...nodes.values()].filter(nodeVisible).length;
    ctx.fillStyle = fg;
    ctx.fillText(`${vn}/${nodes.size} files \u00b7 ${edges.size} edges`, width - 12, 12);
    ctx.fillText(`${ac} active \u00b7 ${wc} warm`, width - 12, 24);
    if (camZoom !== 1) ctx.fillText(`zoom: ${Math.round(camZoom * 100)}%`, width - 12, 36);
  }

  // --- Hit testing (uses raw node positions, not fisheye-distorted) ---
  function nodeAt(mx, my) {
    const wx = mx / camZoom + camX, wy = my / camZoom + camY;
    let closest = null, closestDist = Infinity;
    for (const node of nodes.values()) {
      if (!nodeVisible(node)) continue;
      const dx = node.x - wx, dy = node.y - wy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const r = nodeRadius(node);
      if (dist < r + 6 && dist < closestDist) { closest = node; closestDist = dist; }
    }
    return closest;
  }

  // --- Interaction ---
  function initInteraction() {

    canvas.addEventListener("mouseleave", () => { fisheyeActive = false; hoveredNode = null; hoveredEdge = null; });

    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const hit = nodeAt(mx, my);
      if (hit) {
        // Start dragging the node
        draggingNode = hit;
        selectedNode = hit;
        hit.fx = hit.x;
        hit.fy = hit.y;
        if (simulation) simulation.alphaTarget(0.3).restart();
        canvas.style.cursor = "grabbing";
        return;
      }
      selectedNode = null;
      isDragging = true;
      userDragged = true;
      dragStartX = e.clientX; dragStartY = e.clientY;
      dragCamX = camX; dragCamY = camY;
      canvas.style.cursor = "grabbing";
    });

    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;

      // Node dragging
      if (draggingNode) {
        draggingNode.fx = mx / camZoom + camX;
        draggingNode.fy = my / camZoom + camY;
        return;
      }

      if (isDragging) {
        camX = dragCamX - (e.clientX - dragStartX) / camZoom;
        camY = dragCamY - (e.clientY - dragStartY) / camZoom;
        targetCamX = camX; targetCamY = camY; return;
      }
      fisheyeX = mx / camZoom + camX;
      fisheyeY = my / camZoom + camY;
      const hit = nodeAt(mx, my);
      hoveredNode = hit;
      fisheyeActive = !!hit;
      hoveredEdge = hit ? null : findEdgeAtMouse(mx, my);
      canvas.style.cursor = hit ? "pointer" : hoveredEdge ? "crosshair" : "grab";
    });

    function releaseNode() {
      if (draggingNode) {
        draggingNode.fx = null;
        draggingNode.fy = null;
        draggingNode = null;
        if (simulation) simulation.alphaTarget(0);
      }
    }

    canvas.addEventListener("mouseup", () => {
      releaseNode();
      if (isDragging) {
        isDragging = false;
        targetCamX = camX;
        targetCamY = camY;
        canvas.style.cursor = hoveredNode ? "pointer" : "grab";
      }
    });

    document.addEventListener("mouseup", () => {
      releaseNode();
      if (isDragging) {
        isDragging = false;
        targetCamX = camX;
        targetCamY = camY;
        canvas.style.cursor = "grab";
      }
    });
    canvas.addEventListener("wheel", (e) => {
      // Only handle wheel when 2D canvas is visible
      if (canvas.style.display === "none") return;
      e.preventDefault();
      camZoom = Math.min(4, Math.max(0.1, camZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    }, { passive: false });
    canvas.addEventListener("dblclick", () => { selectedNode = null; userDragged = false; targetCamX = 0; targetCamY = 0; camZoom = 1; });
  }

  function getTooltip() {
    if (!hoveredNode && !selectedNode) return null;
    const n = hoveredNode || selectedNode;
    const imp = getImportance(n);
    const sc = getStarClass(n);
    return { file: n.id, label: n.label, dir: n.dir, readCount: n.readCount, editCount: n.editCount, execCount: n.execCount, total: n.accessCount, classification: sc.name, importance: imp };
  }

  // --- Public API ---
  let dirty = false, rebuildTimer = null;

  function init(el) {
    canvas = el; ctx = canvas.getContext("2d");
    initInteraction();
    requestAnimationFrame(() => { resizeCanvas(); render(); loadFullHistory(); });
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    width = rect.width; height = rect.height;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = width + "px"; canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  async function loadFullHistory() {
    try {
      const resp = await fetch("/api/file-accesses");
      const lines = await resp.json();
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          processEntry({ json, sessionId: json.data?.session_id || null, ts: json._ts ? new Date(json._ts).getTime() : Date.now() });
        } catch {}
      }
      if (nodes.size > 0) rebuildSimulation();
    } catch (err) { console.error("Gravity: failed to load history", err); }
  }

  function addEntry(entry) {
    if (processEntry(entry) && !dirty) {
      dirty = true;
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => { dirty = false; rebuildSimulation(); }, 100);
    }
  }

  function addEntries(list) {
    let changed = false;
    for (const e of list) { if (processEntry(e)) changed = true; }
    if (changed) rebuildSimulation();
  }

  function destroy() {
    if (animFrame) cancelAnimationFrame(animFrame);
    if (simulation) simulation.stop();
    if (ambientPulseTimer) { clearInterval(ambientPulseTimer); ambientPulseTimer = null; }
    animFrame = null; simulation = null; pulses = [];
  }

  function reset() {
    nodes.clear(); edges.clear(); lastToolBySession.clear(); activeFiles.clear();
    labelCounts.clear(); hoveredNode = null; selectedNode = null;
    if (simulation) simulation.stop(); simulation = null;
  }

  function zoom(f) { camZoom = Math.min(4, Math.max(0.1, camZoom * f)); }
  function deselect() { selectedNode = null; }

  // Expose data for 3D view sync
  function getNodes() { return nodes; }
  function getEdges() { return edges; }

  function setFilter(type) {
    activeFilter = type;
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b.dataset.filter === type));
  }

  function getStats() {
    const now = Date.now();
    let visible = 0;
    nodes.forEach(n => { if (nodeVisible(n)) visible++; });
    return { visible, total: nodes.size, edges: edges.size, zoom: Math.round(camZoom * 100) + "%" };
  }

  return { init, addEntry, addEntries, destroy, reset, getTooltip, getStats, zoom, deselect, getNodes, getEdges, setFilter };
})();
