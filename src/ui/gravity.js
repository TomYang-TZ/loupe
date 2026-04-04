"use strict";

// ===== File Gravity Map =====
// Force-directed behavioral dependency graph.
// Dark mode: Observatory (bright point nodes, soft halos, sparse stars)
// Light mode: Blueprint (hollow circles, dash patterns, architectural)

const Gravity = (() => {
  // --- State ---
  let canvas, ctx;
  let width = 0, height = 0;
  let simulation = null;
  let nodes = new Map();
  let edges = new Map();
  let lastToolBySession = new Map();
  let activeFiles = new Map();
  let labelCounts = new Map();

  // Camera
  let camX = 0, camY = 0, camZoom = 0.85;
  let targetCamX = 0, targetCamY = 0;
  let isDragging = false, dragStartX = 0, dragStartY = 0, dragCamX = 0, dragCamY = 0;
  let miniDragging = false;
  // Minimap geometry (updated each frame by drawMinimap)
  let miniRect = null; // { mx, my, mw, mh, minX, minY, scale }
  let hoveredNode = null;
  let selectedNode = null;
  let draggingNode = null;

  // Claude presence
  let claudeCurrentFiles = new Set();

  // Animation
  let animFrame = null;
  let lastRenderTime = 0;

  // Config
  const GLOW_DURATION = 3 * 60000;
  const WARM_DURATION = 7 * 60000;
  const STALE_CUTOFF = 60 * 60 * 1000;
  const NODE_MIN_R = 3;
  const NODE_MAX_R = 20;

  // Lane mode: "action" (read/edit/exec), "phase" (exploring/implementing/testing/debugging)
  // Both are always rendered stacked; laneMode controls which one the camera focuses on
  let laneMode = "action";

  // Slider scales
  let nodeSizeScale = 1.0;
  let ySpreadScale = 1.6; // Y-axis spread multiplier (0.3 → 3.0), default ~50% slider
  let mapScale = 1.0; // proportional scale based on container width (baseline 500px)
  function sf(px) { return Math.round(px * mapScale * 10) / 10; } // scale font/size

  // Spread center of mass (kept for compatibility but no longer scales positions)
  let spreadCX = 0, spreadCY = 0;

  // Direct mapping: sim space = world space (no spread compression)
  function spX(node) { return node.x; }
  function spY(node) { return node.y; }
  const EDGE_MIN_W = 0.8;
  const EDGE_MAX_W = 4;
  const LABEL_MIN_ACCESS = 3;
  const EDGE_MIN_WEIGHT = 1;

  const TOOL_ACTIONS = {
    Read: "read", Grep: "read", Glob: "read",
    Edit: "edit", Write: "edit",
    Bash: "exec",
  };

  // Map bash subcommands to action categories for edge classification
  const BASH_CMD_CATEGORY = {
    cat: "read", head: "read", tail: "read", less: "read", more: "read", ls: "read", stat: "read", file: "read", wc: "read",
    sed: "edit", awk: "edit", tee: "edit", chmod: "edit", chown: "edit", chgrp: "edit", touch: "edit",
    mv: "edit", cp: "edit", rm: "exec", mkdir: "exec", rmdir: "exec",
    node: "exec", python: "exec", python3: "exec", npm: "exec", npx: "exec", make: "exec", cargo: "exec", go: "exec",
    git: "exec", docker: "exec", curl: "exec", wget: "exec",
  };

  function extractBashSubcommand(cmd) {
    if (!cmd) return null;
    // Strip leading env vars, sudo, etc.
    const m = cmd.match(/^(?:sudo\s+|env\s+\S+=\S+\s+)*(\w[\w.+-]*)/);
    return m ? m[1] : null;
  }

  function classifyEdge(prevAction, prevFile, currAction, currFile) {
    const sameFile = prevFile === currFile;
    // Same-file patterns
    if (sameFile && prevAction === "edit" && currAction === "read") return "review";
    if (sameFile && prevAction === "edit" && currAction === "edit") return "iteration";
    // Cross-file patterns
    if (prevAction === "read" && currAction === "edit") return "prerequisite";
    if (prevAction === "edit" && currAction === "edit") return "coupling";
    if (prevAction === "edit" && currAction === "exec") return "validation";
    if (prevAction === "exec" && currAction === "edit") return "test-driven";
    if (prevAction === "read" && currAction === "read") return "reference";
    return "sequence";
  }

  // --- Importance ---
  function getImportance(n) {
    return (n.editCount || 0) * 3 + (n.execCount || 0) * 2 + (n.readCount || 0);
  }

  // --- Filter (multi-select: Set of active values, or contains "all") ---
  let activeFilters = new Set(["all"]);
  let recencyFilters = new Set(["active", "warm"]);
  let sessionFilters = new Set(["all"]); // multi-select like other filters
  let knownSessions = new Map(); // sessionId → { label, color }
  let onSessionFilterChange = null; // callback when gravity UI changes session

  // --- Colors ---
  // Observatory (dark): blue-white palette based on importance brightness
  // Blueprint (light): ink tones with stroke weight for importance
  function getNodeColor(node, dark) {
    const imp = getImportance(node);
    const t = Math.min(1, imp / 30);

    // Get lane-aware color if the node has a lane assignment
    const laneKey = node._laneKey;
    if (laneKey && LANE_SEMANTIC_COLORS[laneKey]) {
      const lc = dark ? LANE_SEMANTIC_COLORS[laneKey].dark : LANE_SEMANTIC_COLORS[laneKey].light;
      if (dark) {
        // Blend from muted lane color → bright lane color based on importance
        const r = Math.round(lc.r * 0.5 + t * lc.r * 0.5 + t * 60);
        const g = Math.round(lc.g * 0.5 + t * lc.g * 0.5 + t * 40);
        const b = Math.round(lc.b * 0.5 + t * lc.b * 0.5 + t * 30);
        return `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
      } else {
        // Light mode: tinted ink based on lane
        const blend = 0.3 + t * 0.4;
        const r = Math.round(50 * (1 - blend) + lc.r * blend);
        const g = Math.round(70 * (1 - blend) + lc.g * blend);
        const b = Math.round(90 * (1 - blend) + lc.b * blend);
        return `rgb(${r},${g},${b})`;
      }
    }

    // Fallback: original blue-white spectrum
    if (dark) {
      const r = Math.round(140 + t * 115);
      const g = Math.round(170 + t * 75);
      const b = Math.round(220 + t * 35);
      return `rgb(${r},${g},${b})`;
    } else {
      return "rgb(50,70,90)";
    }
  }

  function getEdgeColor(edge, dark, solid) {
    // Use semantic edge colors based on edge type → action semantics
    const edgeSemanticMap = {
      prerequisite:  "read",       // read → edit
      coupling:      "edit",       // edit → edit
      validation:    "exec",       // edit → exec
      reference:     "read",       // read → read
      "test-driven": "exec",       // exec → edit
    };
    const semanticKey = edgeSemanticMap[edge.type];
    const lc = semanticKey && LANE_SEMANTIC_COLORS[semanticKey];

    if (lc && solid) {
      const c = dark ? lc.dark : lc.light;
      return `rgb(${c.r},${c.g},${c.b})`;
    }
    if (lc) {
      const c = dark ? lc.dark : lc.light;
      const a = solid ? 1 : (dark ? 0.6 : 0.35);
      return `rgba(${c.r},${c.g},${c.b},${a})`;
    }
    // Fallback for sequence/unknown
    if (solid) return dark ? "#708090" : "#808890";
    return dark ? "rgba(100,116,132,0.4)" : "rgba(140,148,156,0.25)";
  }

  // No dash patterns — all edges are solid lines in both themes

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

  function parseRgb(str) {
    const m = str.match(/rgb\((\d+),(\d+),(\d+)\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  }

  // --- Graph building ---
  function getOrCreateNode(fp, nearFp) {
    if (nodes.has(fp)) return nodes.get(fp);
    // Place new node near its connected neighbor (if known) for smooth introduction
    let startX = width / 2 + (Math.random() - 0.5) * 100;
    let startY = height / 2 + (Math.random() - 0.5) * 100;
    if (nearFp && nodes.has(nearFp)) {
      const near = nodes.get(nearFp);
      startX = near.x + (Math.random() - 0.5) * 60;
      startY = near.y + (Math.random() - 0.5) * 60;
    }
    const n = { id: fp, label: shortName(fp), dir: dirGroup(fp), accessCount: 0, readCount: 0, editCount: 0, execCount: 0, lastAction: "read", lastAccessTs: 0, firstAccessTs: Date.now(), accessOrder: nodes.size, sessions: new Set(), createdAt: Date.now(), x: startX, y: startY, vx: 0, vy: 0, fx: null, fy: null };
    nodes.set(fp, n);
    return n;
  }

  function getOrCreateEdge(src, dst, type) {
    const key = `${src}|${dst}|${type}`;
    if (edges.has(key)) return edges.get(key);
    const e = { key, source: src, target: dst, type, weight: 0, lastTs: 0, sessions: new Set() };
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
    if (input.command) {
      const cmd = input.command;
      // Absolute path with extension (file)
      const fileMatch = cmd.match(/(?:^|\s)(\/\S+\.\w+)/);
      if (fileMatch) return fileMatch[1];
      // Absolute directory path (for ls, mkdir, chmod, mv, cp, rm, etc.)
      const dirMatch = cmd.match(/(?:^|\s)(\/(?:[^\s/]+\/)+[^\s/]+)/);
      if (dirMatch) return dirMatch[1];
    }
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

    let action = TOOL_ACTIONS[toolName] || "read";
    let displayAction = action;
    if (toolName === "Bash") {
      const hook = (json._logstream_type && json.data) ? json.data : null;
      const input = (hook || json).tool_input || (hook || json).input || {};
      const subcmd = extractBashSubcommand(input.command);
      if (subcmd) {
        displayAction = subcmd;
        action = BASH_CMD_CATEGORY[subcmd] || "exec";
      }
    }
    const sessionId = entry.sessionId || "default";
    const ts = entry.ts || Date.now();
    const prev = lastToolBySession.get(sessionId);
    const node = getOrCreateNode(fp, prev?.file);
    node.accessCount++;
    node.lastAction = displayAction;
    node.lastAccessTs = ts;
    node.sessions.add(sessionId);
    if (action === "read") node.readCount++;
    else if (action === "edit") node.editCount++;
    else if (action === "exec") node.execCount++;
    activeFiles.set(fp, ts);

    if (prev && (ts - prev.ts) < 60000) {
      if (prev.file === fp) {
        // Same-file patterns: iteration (edit→edit) or review (edit→read)
        const et = classifyEdge(prev.action, prev.file, action, fp);
        if (et === "iteration" || et === "review") {
          // Track as node metadata, not as an edge (self-loops are noisy)
          if (et === "iteration") node.iterationCount = (node.iterationCount || 0) + 1;
          if (et === "review") node.reviewCount = (node.reviewCount || 0) + 1;
        }
      } else {
        const et = classifyEdge(prev.action, prev.file, action, fp);
        const edge = getOrCreateEdge(prev.file, fp, et);
        edge.weight++;
        edge.lastTs = ts;
        edge.sessions.add(sessionId);
        edge.srcAction = prev.displayAction || prev.action;
        edge.dstAction = displayAction;
        getOrCreateNode(prev.file, fp);
      }
    }
    lastToolBySession.set(sessionId, { tool: toolName, action, displayAction, file: fp, ts });

    // Track Claude's presence
    claudeCurrentFiles.clear();
    claudeCurrentFiles.add(fp);

    return true;
  }

  // --- Lane computation ---
  // Fixed lane definitions for action and phase modes
  const ACTION_LANES = ["read", "edit", "exec"];
  const PHASE_LANES = ["exploring", "planning", "implementing", "testing", "debugging"];

  // Fixed axis geometry (frozen row/column like a chart)
  // AXIS_LEFT_W auto-computed from longest lane label; AXIS_BOTTOM_H fixed
  let AXIS_LEFT_W = 80;      // default, recalculated in drawLaneLabels
  const AXIS_BOTTOM_H = 28;  // X-axis time strip height (px, before mapScale)
  let filterAreaHeight = 60; // screen px below which lane labels can draw (set in rebuildSimulation)

  // Both lane sets always computed and stacked; laneMode controls camera focus
  let currentLanes = []; // combined: action lanes ++ phase lanes
  let actionLanes = [], phaseLanes = [];
  let actionSectionTop = 0, actionSectionBot = 0;
  let phaseSectionTop = 0, phaseSectionBot = 0;
  const SECTION_GAP = 60; // px gap between action and phase sections

  function assignActionLane(n) {
    const action = n.lastAction || "read";
    const idx = ACTION_LANES.indexOf(action);
    return idx >= 0 ? idx : 0;
  }

  function assignPhaseLane(n) {
    const fileState = (typeof Momentum !== "undefined" && Momentum.getFileState) ? Momentum.getFileState(n.id) : null;
    let phase = fileState ? fileState.phase : null;
    if (!phase) {
      if (n.editCount > n.readCount && n.editCount > n.execCount) phase = "implementing";
      else if (n.execCount > 0) phase = "testing";
      else phase = "exploring";
    }
    const idx = PHASE_LANES.indexOf(phase);
    return idx >= 0 ? idx : 0;
  }

  function buildSectionLanes(lanes, nodeArray, assignFn, sectionH, startY) {
    const result = [];
    const laneCounts = new Array(lanes.length).fill(0);
    for (const n of nodeArray) laneCounts[assignFn(n)]++;

    const emptyLaneH = 20;
    const populated = laneCounts.filter(c => c > 0).length;
    const distributable = Math.max(60, sectionH - (lanes.length - populated) * emptyLaneH);
    const totalPop = Math.max(1, laneCounts.reduce((a, b) => a + b, 0));

    const heights = laneCounts.map(c => c === 0 ? emptyLaneH : Math.max(35, (c / totalPop) * distributable));
    const totalH = heights.reduce((a, b) => a + b, 0);
    const scale = sectionH / totalH;
    for (let i = 0; i < heights.length; i++) heights[i] *= scale;

    let yOff = startY;
    for (let i = 0; i < lanes.length; i++) {
      result.push({ key: lanes[i], label: lanes[i].charAt(0).toUpperCase() + lanes[i].slice(1), y: yOff, h: heights[i] });
      yOff += heights[i];
    }
    return result;
  }

  function computeLanes(nodeArray, dirGroups, usableH, pad) {
    // Always assign BOTH lane types per node
    for (const n of nodeArray) {
      n._actionLaneIdx = assignActionLane(n);
      n._actionLaneKey = ACTION_LANES[n._actionLaneIdx];
      n._phaseLaneIdx = assignPhaseLane(n);
      n._phaseLaneKey = PHASE_LANES[n._phaseLaneIdx];
    }

    // Stack both sections: action on top, phase below, with gap
    const sectionH = ((usableH - SECTION_GAP) / 2) * ySpreadScale;
    actionLanes = buildSectionLanes(ACTION_LANES, nodeArray, assignActionLane, sectionH, pad);
    actionSectionTop = pad;
    actionSectionBot = pad + sectionH;

    const phaseStart = pad + sectionH + SECTION_GAP;
    phaseLanes = buildSectionLanes(PHASE_LANES, nodeArray, assignPhaseLane, sectionH, phaseStart);
    phaseSectionTop = phaseStart;
    phaseSectionBot = phaseStart + sectionH;

    currentLanes = [...actionLanes, ...phaseLanes];

    // Node Y targets — use the FOCUSED section for simulation
    for (const n of nodeArray) {
      const aLane = actionLanes[n._actionLaneIdx];
      const pLane = phaseLanes[n._phaseLaneIdx];
      n._actionTargetY = aLane ? aLane.y + aLane.h / 2 : pad;
      n._phaseTargetY = pLane ? pLane.y + pLane.h / 2 : phaseStart;

      if (laneMode === "phase") {
        n._laneIdx = n._phaseLaneIdx;
        n._laneKey = n._phaseLaneKey;
        n._targetY = n._phaseTargetY;
        n._laneYMin = pLane ? pLane.y : phaseStart;
        n._laneYMax = pLane ? pLane.y + pLane.h : phaseStart + 40;
      } else {
        n._laneIdx = n._actionLaneIdx;
        n._laneKey = n._actionLaneKey;
        n._targetY = n._actionTargetY;
        n._laneYMin = aLane ? aLane.y : pad;
        n._laneYMax = aLane ? aLane.y + aLane.h : pad + 40;
      }
    }
  }

  // --- Force simulation ---
  let isFirstBuild = true;

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

    // Session groups for multi-session clustering
    const sessionGroups = new Map();
    const multiSession = sessionFilters.has("all") || sessionFilters.size > 1;
    if (multiSession) {
      for (const n of nodeArray) {
        // Primary session = most recent one that accessed this node
        let primarySession = null;
        // Use last session that touched this file (sessions is a Set, pick last added)
        for (const s of n.sessions) primarySession = s;
        if (primarySession) {
          if (!sessionGroups.has(primarySession)) sessionGroups.set(primarySession, []);
          sessionGroups.get(primarySession).push(n);
        }
      }
    }

    if (simulation) simulation.stop();

    // --- Time-series layout ---
    // X-axis: lastAccessTs (most recently touched files drift right)
    // Y-axis: lane mode (action / phase)
    // Padding derived from fixed axis gutter sizes
    const axisLeftW = Math.round(AXIS_LEFT_W * mapScale);
    const axisBottomH = Math.round(AXIS_BOTTOM_H * mapScale);
    const padTop = Math.round(70 * mapScale); // consolidated filter bar
    filterAreaHeight = padTop;
    const padBot = axisBottomH + 20;           // time axis strip + gap
    const padLeft = axisLeftW + 10;            // Y-axis gutter + gap
    const padRight = Math.round(40 * mapScale);
    const usableW = Math.max(200, (width || 600) - padLeft - padRight);
    const usableH = Math.max(150, (height || 400) - padTop - padBot);

    // Filter to layout-visible nodes (excludes wrong session, expired nodes)
    // NOTE: does NOT apply recency filter — all non-expired nodes get X positions
    // so they're ready when the user toggles recency filters
    function nodeVisibleForLayout(node) {
      if (!sessionFilters.has("all") && ![...node.sessions].some(s => sessionFilters.has(s))) return false;
      const age = Date.now() - node.lastAccessTs;
      if (age > STALE_CUTOFF) return false;
      return true;
    }

    // Rank-based even spacing — only visible nodes get X slots
    const visibleForLayout = nodeArray.filter(nodeVisibleForLayout);
    const sorted = visibleForLayout.sort((a, b) => a.lastAccessTs - b.lastAccessTs);
    const count = sorted.length;
    // Min spacing per node so zoom can reveal space between them
    const minPerNode = 80 * mapScale;
    const effectiveW = Math.max(usableW, count * minPerNode);
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      sorted[i]._targetX = padLeft + t * effectiveW;
    }
    // Invisible nodes: push offscreen
    for (const n of nodeArray) {
      if (!nodeVisibleForLayout(n)) n._targetX = -9999;
    }

    // Store time range + axis geometry for drawTimeAxis (visible nodes only)
    let minTs = count > 0 ? sorted[0].lastAccessTs : 0;
    let maxTs = count > 0 ? sorted[count - 1].lastAccessTs : 1;
    if (minTs === maxTs) maxTs = minTs + 1;
    timeAxisState = { minTs, maxTs, padLeft, usableW: effectiveW, sorted };

    // Compute Y targets based on lane mode (visible nodes only)
    computeLanes(visibleForLayout, dirGroups, usableH, padTop);

    // Stagger Y within lanes so edges aren't collinear.
    // Deterministic jitter based on node key hash — consistent across rebuilds.
    for (const n of visibleForLayout) {
      const laneH = (n._laneYMax || 0) - (n._laneYMin || 0);
      if (laneH > 30) {
        // Hash the node key to get a stable pseudo-random value
        let h = 0;
        const nk = n.id || "";
        for (let i = 0; i < nk.length; i++) h = ((h << 5) - h + nk.charCodeAt(i)) | 0;
        const jitter = ((h & 0xffff) / 0xffff - 0.5) * laneH * 0.25;
        n._targetY += jitter;
        // Clamp within lane bounds
        const r = nodeRadius(n);
        const lo = (n._laneYMin || 0) + r + 4;
        const hi = (n._laneYMax || 0) - r - 4;
        if (lo < hi) n._targetY = Math.max(lo, Math.min(hi, n._targetY));
      }
    }

    // Pin visible nodes' X; unpin invisible ones
    for (const n of nodeArray) {
      n.fx = nodeVisibleForLayout(n) ? n._targetX : undefined;
    }

    simulation = d3.forceSimulation(nodeArray)
      // Y force to push nodes toward lane center
      .force("y", d3.forceY(d => d._targetY).strength(1.2))
      // Collision: Y-only spacing within lanes (X is pinned)
      .force("collision", d3.forceCollide().radius(d => nodeRadius(d) + 6).strength(0.7))
      .force("sessionCluster", multiSession && sessionGroups.size > 1 ? clusterForce(sessionGroups, 0.02) : null)
      .velocityDecay(0.55)
      .alphaDecay(0.05)
      .on("tick", () => {
        // Hard clamp: nodes must stay within their lane Y boundaries
        const margin = 6;
        for (const n of nodeArray) {
          if (n._laneYMin != null && n._laneYMax != null) {
            const r = nodeRadius(n);
            const lo = n._laneYMin + r + margin;
            const hi = n._laneYMax - r - margin;
            if (lo < hi) {
              if (n.y < lo) { n.y = lo; n.vy = 0; }
              if (n.y > hi) { n.y = hi; n.vy = 0; }
            } else {
              // Lane too small — pin to center
              n.y = (n._laneYMin + n._laneYMax) / 2;
              n.vy = 0;
            }
          }
        }
      });

    if (isFirstBuild) {
      for (const n of nodeArray) {
        n.x = n._targetX;
        n.y = n._targetY + (Math.random() - 0.5) * 10;
      }
      for (let i = 0; i < 60; i++) simulation.tick();
      isFirstBuild = false;
    } else {
      for (const n of nodeArray) {
        n.x = n._targetX;
        n.y = n._targetY;  // already includes jitter
        n.vx = 0;
        n.vy = 0;
      }
      simulation.alpha(0.15).restart();
    }

    // Update camera target for new section positions
    if (!userDragged) {
      updateCamera();
    }
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

  // Angular separation: push neighbors apart when edges from a hub are too close in angle
  const DESIRED_MIN_ANGLE = Math.PI / 6; // 30 degrees ideal

  function angularSeparationForce(adjacency, strength) {
    return function(alpha) {
      for (const [hub, neighbors] of adjacency) {
        if (neighbors.length < 2) continue;

        // Scale min angle to what's achievable: can't exceed uniform spacing
        const uniformAngle = (Math.PI * 2) / neighbors.length;
        const minAngle = Math.min(DESIRED_MIN_ANGLE, uniformAngle * 0.85);

        // Compute angles from hub to each neighbor
        const angled = neighbors.map(n => ({
          node: n,
          angle: Math.atan2(n.y - hub.y, n.x - hub.x),
        }));
        angled.sort((a, b) => a.angle - b.angle);

        for (let i = 0; i < angled.length; i++) {
          const curr = angled[i];
          const next = angled[(i + 1) % angled.length];

          let diff = next.angle - curr.angle;
          if (i === angled.length - 1) diff += Math.PI * 2;
          if (diff < 0) diff += Math.PI * 2;

          if (diff < minAngle) {
            const push = (minAngle - diff) * strength * alpha;

            // Push tangentially: curr clockwise, next counterclockwise
            curr.node.vx +=  Math.sin(curr.angle) * push;
            curr.node.vy += -Math.cos(curr.angle) * push;
            next.node.vx += -Math.sin(next.angle) * push;
            next.node.vy +=  Math.cos(next.angle) * push;
          }
        }
      }
    };
  }

  function nodeImportance(node) {
    return node.editCount * 3 + node.execCount * 2 + node.readCount;
  }

  function nodeRadius(node) {
    return Math.min(NODE_MAX_R, NODE_MIN_R + Math.sqrt(nodeImportance(node)) * 2.2) * nodeSizeScale * mapScale;
  }

  // --- Camera ---
  let userDragged = false;

  function updateCamera() {
    const now = Date.now();
    let tw = 0, cx = 0;
    for (const [path, ts] of activeFiles) {
      const age = now - ts; if (age > WARM_DURATION) continue;
      const node = nodes.get(path); if (!node) continue;
      const w = age < GLOW_DURATION ? 3 : 1;
      cx += node.x * w; tw += w;
    }
    if (tw === 0 && !userDragged) {
      for (const n of nodes.values()) {
        if (!nodeVisible(n)) continue;
        cx += n.x; tw++;
      }
    }
    if (tw > 0 && !userDragged) {
      targetCamX = cx / tw - width / (2 * camZoom);
      // Y: center on the focused section
      const focusTop = laneMode === "phase" ? phaseSectionTop : actionSectionTop;
      const focusBot = laneMode === "phase" ? phaseSectionBot : actionSectionBot;
      const laneCenterY = (focusTop + focusBot) / 2;
      targetCamY = laneCenterY - height / (2 * camZoom);
    }
    if (!isDragging) {
      camX += (targetCamX - camX) * 0.2;
      camY += (targetCamY - camY) * 0.2;
    }
  }

  // --- Semantic zoom ---
  function nodeVisible(node) {
    if (node === hoveredNode || node === selectedNode) return true;
    // Session filter: hide nodes not in selected session
    if (!sessionFilters.has("all") && ![...node.sessions].some(s => sessionFilters.has(s))) return false;
    const age = Date.now() - node.lastAccessTs;
    if (age > STALE_CUTOFF) return false;
    // Recency filter
    if (!recencyFilters.has("all")) {
      const isActive = age < GLOW_DURATION;
      const isWarm = age >= GLOW_DURATION && age < WARM_DURATION;
      const isStale = age >= WARM_DURATION;
      if (!((recencyFilters.has("active") && isActive) || (recencyFilters.has("warm") && isWarm) || (recencyFilters.has("stale") && isStale))) return false;
    }
    if (camZoom < 0.5) return node.accessCount >= 5;
    if (camZoom < 0.8) return node.accessCount >= 2;
    return true;
  }

  function edgeVisible(edge) {
    if (camZoom < 0.5) return edge.weight >= 5;
    if (camZoom < 0.8) return edge.weight >= EDGE_MIN_WEIGHT;
    return edge.weight >= EDGE_MIN_WEIGHT || edge.type !== "sequence";
  }

  function shouldShowLabel(node, r, isGlowing, isWarm, isHovered, isSelected) {
    if (isHovered || isSelected) return true;
    if (isGlowing || isWarm) return node.accessCount >= 2;
    if (camZoom < 0.5) return node.accessCount >= 8 && r > 5;
    if (camZoom < 0.8) return node.accessCount >= LABEL_MIN_ACCESS;
    return node.accessCount >= LABEL_MIN_ACCESS || r > 7;
  }

  // --- Background ---
  let bgStars = null;

  function initBackground() {
    bgStars = [];
    // Sparse, tiny stars for dark mode only
    for (let i = 0; i < 50; i++) {
      bgStars.push({
        x: Math.random(), y: Math.random(),
        size: 0.3 + Math.random() * 0.5,
        opacity: 0.08 + Math.random() * 0.12,
      });
    }
  }

  function drawBackground(dark) {
    if (!bgStars) initBackground();
    if (dark) {
      // Very sparse tiny dots
      for (const s of bgStars) {
        ctx.beginPath();
        const sx = ((s.x * width + camX * 0.0003 * width) % width + width) % width;
        const sy = ((s.y * height + camY * 0.0003 * height) % height + height) % height;
        ctx.arc(sx, sy, s.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(180,190,220,${s.opacity})`;
        ctx.fill();
      }
    }
    // Light mode: clean flat background, no decoration
  }

  // Semantic lane colors — each lane gets a meaningful tint
  const LANE_SEMANTIC_COLORS = {
    // Action mode
    read:          { dark: { r: 100, g: 160, b: 255 }, light: { r: 59, g: 130, b: 246 }, icon: "◉" },   // blue
    edit:          { dark: { r: 74, g: 222, b: 128 },  light: { r: 34, g: 160, b: 80 },  icon: "✎" },   // green
    exec:          { dark: { r: 251, g: 191, b: 36 },  light: { r: 180, g: 130, b: 20 }, icon: "▶" },   // amber
    // Phase mode
    exploring:     { dark: { r: 139, g: 92, b: 246 },  light: { r: 109, g: 62, b: 216 }, icon: "◎" },   // violet
    planning:      { dark: { r: 245, g: 158, b: 11 },  light: { r: 180, g: 120, b: 10 }, icon: "◇" },   // amber
    implementing:  { dark: { r: 34, g: 197, b: 94 },   light: { r: 22, g: 160, b: 70 },  icon: "⬡" },   // green
    testing:       { dark: { r: 6, g: 182, b: 212 },   light: { r: 10, g: 140, b: 170 }, icon: "△" },   // cyan
    debugging:     { dark: { r: 239, g: 68, b: 68 },   light: { r: 200, g: 50, b: 50 },  icon: "✕" },   // red
  };

  function getLaneColor(laneKey) {
    return LANE_SEMANTIC_COLORS[laneKey] || LANE_SEMANTIC_COLORS.read;
  }

  // Convert a simulation-space Y value to screen Y (camera transform only)
  function simYToScreen(simY) {
    return (simY - camY) * camZoom;
  }

  // --- Lane backgrounds (screen space, semantic-colored bands behind nodes) ---
  function drawLaneBackgrounds(dark) {
    if (currentLanes.length < 2) return;
    const axisLeftW = Math.round(AXIS_LEFT_W * mapScale);

    for (let i = 0; i < currentLanes.length; i++) {
      const lane = currentLanes[i];
      const screenTop = simYToScreen(lane.y);
      const screenBot = simYToScreen(lane.y + lane.h);
      const screenH = screenBot - screenTop;

      // Semantic-colored background band
      const lc = getLaneColor(lane.key);
      const c = dark ? lc.dark : lc.light;
      const bgAlpha = dark ? 0.07 : 0.04;
      ctx.save();
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${bgAlpha})`;
      ctx.fillRect(axisLeftW, screenTop, width - axisLeftW, screenH);
      ctx.restore();

      // Divider line between lanes (tinted with lane color)
      if (i < currentLanes.length - 1) {
        ctx.save();
        const divAlpha = dark ? 0.12 : 0.1;
        ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${divAlpha})`;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(axisLeftW, screenBot);
        ctx.lineTo(width, screenBot);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Section divider between action and phase
    if (actionLanes.length > 0 && phaseLanes.length > 0) {
      const gapMidY = (actionSectionBot + phaseSectionTop) / 2;
      const sy = simYToScreen(gapMidY);
      if (sy > 0 && sy < height) {
        ctx.save();
        ctx.strokeStyle = dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(axisLeftW, sy);
        ctx.lineTo(width, sy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }

  // --- Lane labels (fixed Y-axis gutter, screen space, semantic colors) ---
  function drawLaneLabels(dark) {
    if (currentLanes.length < 2) return;

    // Font size adapts to available lane height so labels don't overlap
    // Find the smallest visible lane screen height
    let minLaneScreenH = Infinity;
    for (const lane of currentLanes) {
      const sh = Math.abs(simYToScreen(lane.y + lane.h) - simYToScreen(lane.y));
      if (sh > 0 && sh < minLaneScreenH) minLaneScreenH = sh;
    }
    // Font fits within the smallest lane, clamped to reasonable range
    const laneFontSize = Math.max(7, Math.min(sf(12), minLaneScreenH * 0.6));

    // Measure longest label to auto-size the gutter (label only, icon is inline)
    ctx.save();
    ctx.font = `600 ${laneFontSize}px "SF Mono", monospace`;
    let maxLabelW = 0;
    for (const lane of currentLanes) {
      const w = ctx.measureText(lane.label).width;
      if (w > maxLabelW) maxLabelW = w;
    }
    ctx.restore();
    const axisLeftW = Math.round(maxLabelW + 14); // tight padding
    // Update module-level constant so padding/other functions use it
    AXIS_LEFT_W = Math.round(axisLeftW / mapScale);

    // Gutter border extends to bottom of canvas
    const axisBottomH = Math.round(AXIS_BOTTOM_H * mapScale);
    const borderBottom = height - axisBottomH;

    // Gutter starts below the filter controls area
    const gutterTop = filterAreaHeight;

    // Opaque gutter background — from filter area to bottom
    ctx.save();
    ctx.fillStyle = dark ? "rgba(12,15,24,0.92)" : "rgba(244,243,240,0.94)";
    ctx.fillRect(0, gutterTop, axisLeftW, height - gutterTop);
    ctx.restore();

    // Right-edge border — from filter area to X-axis
    ctx.save();
    ctx.strokeStyle = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(axisLeftW, gutterTop);
    ctx.lineTo(axisLeftW, borderBottom);
    ctx.stroke();
    ctx.restore();

    let lastLabelY = -Infinity;
    for (let i = 0; i < currentLanes.length; i++) {
      const lane = currentLanes[i];
      const lc = getLaneColor(lane.key);
      const c = dark ? lc.dark : lc.light;
      const screenTop = simYToScreen(lane.y);
      const screenBot = simYToScreen(lane.y + lane.h);
      const screenMidY = (screenTop + screenBot) / 2;

      // Don't draw in filter area or off-screen
      if (screenBot < gutterTop || screenTop > height) continue;

      // Colored accent bar on left edge of gutter
      ctx.save();
      const barAlpha = dark ? 0.5 : 0.4;
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${barAlpha})`;
      const barTop = Math.max(gutterTop, screenTop);
      const barBot = Math.min(height, screenBot);
      ctx.fillRect(0, barTop, 3, barBot - barTop);
      ctx.restore();

      // Label — skip if too close to previous to avoid overlap
      if (screenMidY - lastLabelY < laneFontSize + 2) continue;

      ctx.save();
      const textAlpha = dark ? 0.75 : 0.65;
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${textAlpha})`;
      ctx.font = `600 ${laneFontSize}px "SF Mono", monospace`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(lane.label, axisLeftW - 6, screenMidY);
      ctx.restore();
      lastLabelY = screenMidY;
    }

    // Section headers
    const headerFontSize = Math.max(6, sf(8));
    for (const { label, top } of [
      { label: "ACTION", top: actionSectionTop },
      { label: "PHASE", top: phaseSectionTop },
    ]) {
      const sy = simYToScreen(top) - 3;
      if (sy < gutterTop - 5 || sy > height) continue;
      ctx.save();
      ctx.font = `700 ${headerFontSize}px "SF Mono", monospace`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = dark ? "rgba(200,215,240,0.25)" : "rgba(50,70,90,0.2)";
      ctx.fillText(label, 6, sy);
      ctx.restore();
    }
  }

  // --- Edge Hover Detection ---
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
      const d = pointToSegmentDist(worldX, worldY, spX(srcN), spY(srcN), spX(dstN), spY(dstN));
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
    prerequisite: "read → edit",
    coupling: "edit → edit",
    validation: "edit → run",
    reference: "read → read",
    "test-driven": "run → edit",
    sequence: "→",
  };

  function drawEdgeLabel(edge, dark, mx, my) {
    const srcN = nodes.get(edge.source);
    const dstN = nodes.get(edge.target);
    if (!srcN || !dstN) return;
    const label = EDGE_TYPE_LABELS[edge.type] || edge.type;
    const x = mx !== undefined ? mx : (srcN.x + dstN.x) / 2;
    const y = my !== undefined ? my : (srcN.y + dstN.y) / 2;

    const fontSize = Math.max(4, 8 / Math.max(0.2, camZoom));
    ctx.font = `500 ${fontSize}px "SF Mono","JetBrains Mono",Menlo,monospace`;
    const tw = ctx.measureText(label).width;
    const pad = 3 / Math.max(0.2, camZoom);
    const bw = tw + pad * 2;
    const bh = fontSize + pad * 2;

    // Background pill
    ctx.fillStyle = dark ? "rgba(5,5,16,0.85)" : "rgba(255,255,255,0.9)";
    ctx.beginPath();
    const rx = x - bw / 2, ry = y - bh / 2, cr = 2 / Math.max(0.2, camZoom);
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

    ctx.strokeStyle = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)";
    ctx.lineWidth = 0.5;
    ctx.stroke();

    ctx.fillStyle = dark ? "rgba(200,215,240,0.75)" : "rgba(50,70,90,0.7)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y);
  }

  // --- Neighbor check (cached per frame) ---
  let hoverNeighbors = new Set();
  function buildHoverNeighbors() {
    hoverNeighbors.clear();
    const focus = hoveredNode || selectedNode;
    if (!focus) return;
    hoverNeighbors.add(focus.id);
    for (const e of edges.values()) {
      if (e.source === focus.id) hoverNeighbors.add(e.target);
      if (e.target === focus.id) hoverNeighbors.add(e.source);
    }
  }

  // --- Info card system ---
  // Hover → mini card on canvas (follows hover, disappears on leave)
  // Click node → pins mini card (stays visible)
  // Click pinned mini card → detail popover nearby
  // Click mini card again → close popover
  let infoCard = null; // { node } — pinned node (via click)
  let miniCardRect = null; // screen coords for click detection
  let detailOpen = false;

  function buildInfoCard(node) {
    const now = Date.now();
    const imp = getImportance(node);
    const age = now - node.lastAccessTs;
    const connEdges = [];
    for (const e of edges.values()) {
      if (e.source === node.id || e.target === node.id) connEdges.push(e);
    }
    const connFiles = new Set();
    for (const e of connEdges) {
      if (e.source !== node.id) connFiles.add(e.source);
      if (e.target !== node.id) connFiles.add(e.target);
    }

    let lastActionStr = node.lastAction;
    if (age < 30000) lastActionStr += " · just now";
    else if (age < 60000) lastActionStr += " · <1m ago";
    else lastActionStr += ` · ${Math.round(age / 60000)}m ago`;

    const edgeInfos = [];
    for (const e of connEdges) {
      const dir = e.source === node.id ? "→" : "←";
      const other = e.source === node.id ? shortName(e.target) : shortName(e.source);
      const actionArrow = e.srcAction && e.dstAction
        ? `${e.srcAction[0].toUpperCase()}${e.srcAction.slice(1)} → ${e.dstAction[0].toUpperCase()}${e.dstAction.slice(1)}`
        : "";
      edgeInfos.push({
        label: `${dir} ${other}`,
        type: e.type,
        typeLabel: EDGE_TYPE_LABELS[e.type] || e.type,
        actionArrow,
      });
    }

    return {
      file: node.id, lastAction: lastActionStr, edgeInfos,
      connections: [...connFiles].map(shortName),
      reads: node.readCount, edits: node.editCount, execs: node.execCount,
    };
  }

  // Draw mini card next to a node (on canvas)
  function drawMiniCard(dark) {
    // Show for pinned node, or hovered node (if not pinned to something else)
    const target = infoCard ? infoCard.node : hoveredNode;
    if (!target) { miniCardRect = null; return; }

    const node = target;
    const info = buildInfoCard(node);
    const isPinned = infoCard && infoCard.node === node;

    const sx = (spX(node) - camX) * camZoom;
    const sy = (spY(node) - camY) * camZoom;
    const r = nodeRadius(node) * camZoom;

    const label = shortName(node.id);
    // Show timestamp unless "just now" (< 30s ago)
    const age = Date.now() - node.lastAccessTs;
    let timeStr = "";
    if (age >= 30000 && node.lastAccessTs > 0) {
      const d = new Date(node.lastAccessTs);
      timeStr = " · " + d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    const sub = `R:${info.reads} E:${info.edits} X:${info.execs} · ${info.lastAction}${timeStr}`;

    ctx.font = `600 ${sf(10)}px "SF Mono",Menlo,monospace`;
    const labelW = ctx.measureText(label).width;
    ctx.font = `400 ${sf(8)}px "SF Mono",Menlo,monospace`;
    const subW = ctx.measureText(sub).width;
    const cardW = Math.max(labelW, subW) + 24;
    const cardH = 36;

    let cx = sx + r + 12;
    let cy = sy - cardH / 2;
    if (cx + cardW > width - 10) cx = sx - r - cardW - 12;
    if (cy + cardH > height - 10) cy = height - cardH - 10;
    if (cy < 4) cy = 4;

    // Background — slightly more opaque when pinned
    const bgAlpha = isPinned ? 0.95 : 0.85;
    ctx.fillStyle = dark ? `rgba(10,12,20,${bgAlpha})` : `rgba(255,255,255,${bgAlpha})`;
    ctx.strokeStyle = isPinned
      ? (dark ? "rgba(160,180,208,0.3)" : "rgba(58,90,122,0.2)")
      : (dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(cx, cy, cardW, cardH, 5);
    ctx.fill();
    ctx.stroke();

    // Text
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.font = `600 ${sf(10)}px "SF Mono",Menlo,monospace`;
    ctx.fillStyle = dark ? "rgba(200,215,240,0.9)" : "rgba(30,40,50,0.9)";
    ctx.fillText(label, cx + 10, cy + 6);
    ctx.font = `400 ${sf(8)}px "SF Mono",Menlo,monospace`;
    ctx.fillStyle = dark ? "rgba(200,215,240,0.4)" : "rgba(50,70,90,0.4)";
    ctx.fillText(sub, cx + 10, cy + 20);

    // Pin indicator + expand hint
    if (isPinned) {
      ctx.fillStyle = dark ? "rgba(200,215,240,0.25)" : "rgba(50,70,90,0.2)";
      ctx.textAlign = "right";
      ctx.fillText(detailOpen ? "▾" : "▸", cx + cardW - 8, cy + 12);
    }

    miniCardRect = { x: cx, y: cy, w: cardW, h: cardH };
  }

  // Show detail popover (HTML, positioned near mini card)
  function showDetail(node) {
    const cardEl = document.getElementById("gravity-card");
    if (!cardEl || !miniCardRect) return;

    const info = buildInfoCard(node);
    const NAMES = {
      prerequisite: "prerequisite",
      coupling: "coupling",
      validation: "validation",
      reference: "reference",
      "test-driven": "test-driven",
      iteration: "iteration",
      review: "review",
      sequence: "other",
    };

    let html = `<div class="gc-file">${esc(info.file)}</div>`;
    html += `<div class="gc-action">${esc(info.lastAction)}</div>`;

    // Behavioral patterns — unified section
    const hasPatterns = info.edgeInfos.length > 0 || node.iterationCount || node.reviewCount;
    if (hasPatterns) {
      html += `<div class="gc-section"><div class="gc-label">Behavior</div>`;
      if (node.iterationCount) {
        html += `<div class="gc-edge">↻ ${node.iterationCount}× <span class="gc-type">Edit → Edit</span></div>`;
      }
      if (node.reviewCount) {
        html += `<div class="gc-edge">↩ ${node.reviewCount}× <span class="gc-type">Edit → Read</span></div>`;
      }
      for (const ei of info.edgeInfos) {
        if (ei.type === "sequence") {
          const arrow = ei.actionArrow || "→";
          html += `<div class="gc-edge">${esc(ei.label)} <span class="gc-type">${esc(arrow)}</span></div>`;
        } else {
          html += `<div class="gc-edge">${esc(ei.label)} <span class="gc-type">${esc(ei.typeLabel)}</span></div>`;
        }
      }
      html += `</div>`;
    }

    if (info.connections.length > 0) {
      html += `<div class="gc-section"><div class="gc-label">Connected (${info.connections.length})</div>`;
      html += `<div class="gc-edge">${info.connections.map(esc).join(", ")}</div>`;
      html += `</div>`;
    }

    html += `<div class="gc-section gc-stats">R:${info.reads} E:${info.edits} X:${info.execs}</div>`;

    cardEl.innerHTML = html;
    cardEl.style.display = "";
    cardEl.style.transform = "";

    // Position below the mini card
    let left = miniCardRect.x;
    let top = miniCardRect.y + miniCardRect.h + 6;
    // Keep on screen
    if (top + 200 > height) top = miniCardRect.y - 200 - 6;
    if (left + 240 > width) left = width - 250;
    if (left < 4) left = 4;
    if (top < 4) top = 4;
    cardEl.style.left = left + "px";
    cardEl.style.top = top + "px";
    detailOpen = true;
  }

  function hideDetail() {
    const cardEl = document.getElementById("gravity-card");
    if (cardEl) cardEl.style.display = "none";
    detailOpen = false;
  }

  function dismissAll() {
    selectedNode = null;
    infoCard = null;
    hideDetail();
  }

  function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

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

    // Periodically refresh session filter to drop stale sessions
    if (!render._lastSessionRefresh || now - render._lastSessionRefresh > 30000) {
      render._lastSessionRefresh = now;
      rebuildSessionFilterUI();
    }

    buildHoverNeighbors();
    updateCamera();

    // Background
    if (dark) {
      const bgGrad = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
      bgGrad.addColorStop(0, "#1a1e2e");
      bgGrad.addColorStop(1, "#0c0f18");
      ctx.fillStyle = bgGrad;
    } else {
      ctx.fillStyle = "#f4f3f0";
    }
    ctx.fillRect(0, 0, width, height);
    drawBackground(dark);

    ctx.save();
    ctx.translate(-camX * camZoom, -camY * camZoom);
    ctx.scale(camZoom, camZoom);

    const focusNode = hoveredNode || selectedNode;

    // --- Compute spread center of mass from ALL nodes (stable across filters) ---
    spreadCX = 0; spreadCY = 0;
    let spreadCount = 0;
    for (const n of nodes.values()) {
      spreadCX += n.x; spreadCY += n.y; spreadCount++;
    }
    if (spreadCount > 0) { spreadCX /= spreadCount; spreadCY /= spreadCount; }

    function sp(node) { return { x: spX(node), y: spY(node) }; }

    // --- Edges: consolidate per node-pair, use most recent direction ---
    // Group edges by unordered node pair, pick the most recent for arrow direction
    const pairMap = new Map(); // "nodeA|nodeB" → { edges[], newest }
    for (const edge of edges.values()) {
      if (!edgeVisible(edge)) continue;
      if (!edgeFilterMatch(edge)) continue;
      const srcN = nodes.get(edge.source);
      const dstN = nodes.get(edge.target);
      if (!srcN || !dstN || !nodeVisible(srcN) || !nodeVisible(dstN)) continue;
      const pairKey = edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`;
      if (!pairMap.has(pairKey)) pairMap.set(pairKey, { edges: [], newest: edge });
      const group = pairMap.get(pairKey);
      group.edges.push(edge);
      if (edge.lastTs > group.newest.lastTs) group.newest = edge;
    }

    for (const { edges: groupEdges, newest } of pairMap.values()) {
      // Aggregate weight and pick best opacity across all edges in this pair
      let totalWeight = 0;
      let bestAge = Infinity;
      for (const e of groupEdges) {
        totalWeight += e.weight;
        bestAge = Math.min(bestAge, now - e.lastTs);
      }

      const lw = Math.min(EDGE_MAX_W, EDGE_MIN_W + totalWeight * 0.5) * mapScale;
      let opacity = bestAge < GLOW_DURATION ? 1.0 : bestAge < WARM_DURATION ? 0.8 : 0.6;

      // Arrow direction from most recent edge
      const srcN = nodes.get(newest.source);
      const dstN = nodes.get(newest.target);
      const connected = focusNode &&
        (newest.source === focusNode.id || newest.target === focusNode.id);
      const hasFocus = !!focusNode;

      if (hasFocus && !connected) opacity *= 0.25;
      if (connected) opacity = 1.0;

      if (!activeFilters.has("all")) {
        const srcMatch = filterMatchAction(srcN);
        const dstMatch = filterMatchAction(dstN);
        if (!srcMatch || !dstMatch) opacity *= 0.15;
      }

      ctx.globalAlpha = opacity;
      const sSrc = sp(srcN), sDst = sp(dstN);
      ctx.beginPath();
      ctx.moveTo(sSrc.x, sSrc.y);
      ctx.lineTo(sDst.x, sDst.y);

      ctx.strokeStyle = connected ? getEdgeColor(newest, dark, true) : getEdgeColor(newest, dark, false);
      ctx.lineWidth = connected ? lw * 1.5 : lw;
      ctx.lineCap = "round";
      ctx.stroke();

      // Single direction arrow from most recent edge
      if (connected || (!hasFocus && opacity > 0.2)) {
        const mx = (sSrc.x + sDst.x) / 2;
        const my = (sSrc.y + sDst.y) / 2;
        const angle = Math.atan2(sDst.y - sSrc.y, sDst.x - sSrc.x);
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(angle);
        ctx.beginPath();
        const as = 5 * mapScale;
        const ah = 2.5 * mapScale;
        ctx.moveTo(as, 0);
        ctx.lineTo(-ah, -ah);
        ctx.lineTo(-ah, ah);
        ctx.closePath();
        ctx.fillStyle = connected
          ? getEdgeColor(newest, dark, true)
          : (dark ? `rgba(120,140,170,${opacity * 0.5})` : `rgba(50,70,90,${opacity * 0.5})`);
        ctx.fill();
        ctx.restore();
      }

      ctx.globalAlpha = 1;
    }

    // --- Edge type label: only on the single closest edge to cursor ---
    // (Showing all edge labels at once creates overlapping noise)

    // --- Nodes (drawn twice: once in action section, once in phase section) ---
    const placedLabels = [];
    const renderPasses = ["action", "phase"];
    for (const _pass of renderPasses) {
    for (const node of nodes.values()) {
      if (!nodeVisible(node)) continue;
      const x = spX(node);
      const y = _pass === "phase" ? node._phaseTargetY : node._actionTargetY;
      // Temporarily set lane key for semantic coloring
      const _savedLaneKey = node._laneKey;
      node._laneKey = _pass === "phase" ? node._phaseLaneKey : node._actionLaneKey;
      const baseR = nodeRadius(node);
      const age = now - node.lastAccessTs;
      const isGlowing = age < GLOW_DURATION;
      const isWarm = age < WARM_DURATION;
      const isHovered = hoveredNode === node;
      const isSelected = selectedNode === node;
      const isNeighbor = hoverNeighbors.has(node.id);
      const hasFocus = !!focusNode;
      const dimmed = hasFocus && !isNeighbor;
      const imp = getImportance(node);
      const impNorm = Math.min(1, imp / 30);

      // New node intro glow (fades over 5 seconds)
      const NEW_GLOW_DURATION = 5000;
      const introAge = now - (node.createdAt || 0);
      const isNewNode = introAge < NEW_GLOW_DURATION;
      const introGlow = isNewNode ? 1 - (introAge / NEW_GLOW_DURATION) : 0;

      let alpha = isGlowing ? 1.0 : isWarm ? 0.8 : 0.5;
      if (isNewNode) alpha = Math.max(alpha, 0.7 + introGlow * 0.3);
      if (!activeFilters.has("all") && !filterMatchAction(node)) alpha = 0.15;
      if (dimmed) alpha *= 0.2;
      if (isHovered || isSelected) alpha = 1;

      ctx.globalAlpha = alpha;

      if (dark) {
        // === OBSERVATORY: bright core + soft halo ===
        // New nodes get a boosted core size that settles down
        const introBoost = isNewNode ? introGlow * 4 : 0;
        const coreR = (2.5 + impNorm * 3 + introBoost) * mapScale;
        const laneKey = node._laneKey;
        const introLc = (laneKey && LANE_SEMANTIC_COLORS[laneKey]) ? LANE_SEMANTIC_COLORS[laneKey].dark : { r: 200, g: 220, b: 255 };
        const color = isNewNode
          ? `rgb(${Math.round(introLc.r + introGlow * (255 - introLc.r) * 0.5)},${Math.round(introLc.g + introGlow * (255 - introLc.g) * 0.3)},${Math.round(introLc.b + introGlow * (255 - introLc.b) * 0.2)})`
          : getNodeColor(node, true);
        const rgb = parseRgb(color);

        // Soft halo (importance glow) — boosted for new nodes
        if (!dimmed && rgb) {
          const haloR = coreR + (3 + impNorm * 8 + introBoost * 2) * mapScale;
          const haloAlpha = isNewNode ? (0.15 + introGlow * 0.3) : (isHovered ? 0.12 : (0.03 + impNorm * 0.06));
          const grad = ctx.createRadialGradient(x, y, coreR, x, y, haloR);
          grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${haloAlpha})`);
          grad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(x, y, haloR, 0, Math.PI * 2);
          ctx.fill();
        }

        // Core dot
        ctx.beginPath();
        ctx.arc(x, y, coreR, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        // Active file: subtle breathing pulse ring
        if (isGlowing && !dimmed && rgb) {
          const pulseT = ((now % 3000) / 3000);
          const ringR = coreR + (3 + pulseT * 5) * mapScale;
          const ringAlpha = (1 - pulseT) * 0.2 * alpha;
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${ringAlpha})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // New node intro glow (expanding ring that fades)
        if (isNewNode && !dimmed && rgb) {
          const expandT = introAge / NEW_GLOW_DURATION;
          const glowR = coreR + (6 + expandT * 14) * mapScale;
          const glowAlpha = introGlow * 0.7;
          ctx.beginPath();
          ctx.arc(x, y, glowR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${glowAlpha})`;
          ctx.lineWidth = 2 * mapScale;
          ctx.stroke();
          // Inner bright flash
          if (introGlow > 0.3) {
            const flashAlpha = (introGlow - 0.3) * 1.4 * 0.4;
            const flashGrad = ctx.createRadialGradient(x, y, coreR, x, y, coreR + 6 * mapScale);
            flashGrad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${flashAlpha})`);
            flashGrad.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = flashGrad;
            ctx.beginPath();
            ctx.arc(x, y, coreR + 6 * mapScale, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Hover/select ring
        if (isHovered || isSelected) {
          ctx.beginPath();
          ctx.arc(x, y, coreR + 2 * mapScale, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(200,215,240,0.5)";
          ctx.lineWidth = mapScale;
          ctx.stroke();
        }

        // Claude presence beacon
        if (claudeCurrentFiles.has(node.id) && !dimmed) {
          const beaconT = ((now % 2000) / 2000);
          const beaconR = coreR + (4 + beaconT * 8) * mapScale;
          const beaconAlpha = (1 - beaconT) * 0.3;
          ctx.beginPath();
          ctx.arc(x, y, beaconR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(200,215,240,${beaconAlpha})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

      } else {
        // === BLUEPRINT: hollow circles, stroke weight = importance, semantic lane color ===
        const introBoostL = isNewNode ? introGlow * 4 : 0;
        const r = (5 + impNorm * 5 + introBoostL) * mapScale;
        const strokeW = (1 + impNorm * 1.5 + (isNewNode ? introGlow * 2 : 0)) * mapScale;
        const isActive = claudeCurrentFiles.has(node.id);

        // Get lane-aware color for light mode
        const laneKey = node._laneKey;
        const lc = (laneKey && LANE_SEMANTIC_COLORS[laneKey]) ? LANE_SEMANTIC_COLORS[laneKey].light : { r: 50, g: 70, b: 90 };

        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);

        // Active = filled, otherwise hollow
        if (isActive || isGlowing) {
          ctx.fillStyle = `rgba(${lc.r},${lc.g},${lc.b},${dimmed ? 0.08 : 0.15})`;
          ctx.fill();
          ctx.strokeStyle = dimmed ? `rgba(${lc.r},${lc.g},${lc.b},0.2)` : `rgba(${lc.r},${lc.g},${lc.b},0.7)`;
        } else {
          ctx.fillStyle = `rgba(${lc.r},${lc.g},${lc.b},${dimmed ? 0.02 : 0.05})`;
          ctx.fill();
          ctx.strokeStyle = dimmed ? `rgba(${lc.r},${lc.g},${lc.b},0.12)` : `rgba(${lc.r},${lc.g},${lc.b},${0.25 + impNorm * 0.45})`;
        }
        ctx.lineWidth = strokeW;
        ctx.stroke();

        // Active file: subtle breathing pulse
        if (isGlowing && !dimmed) {
          const pulseT = ((now % 3000) / 3000);
          const ringR = r + 3 + pulseT * 4;
          const ringAlpha = (1 - pulseT) * 0.15;
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${lc.r},${lc.g},${lc.b},${ringAlpha})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }

        // New node intro glow
        if (isNewNode && !dimmed) {
          const expandT = introAge / NEW_GLOW_DURATION;
          const glowR = r + (5 + expandT * 12) * mapScale;
          const glowAlpha = introGlow * 0.6;
          ctx.beginPath();
          ctx.arc(x, y, glowR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${lc.r},${lc.g},${lc.b},${glowAlpha})`;
          ctx.lineWidth = 2 * mapScale;
          ctx.stroke();
        }

        // Hover/select: thicker ring
        if (isHovered || isSelected) {
          ctx.beginPath();
          ctx.arc(x, y, r + 2, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${lc.r},${lc.g},${lc.b},0.4)`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Recently warm: small center dot
        if (isWarm && !isGlowing && !dimmed) {
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${lc.r},${lc.g},${lc.b},0.25)`;
          ctx.fill();
        }
      }

      // --- Momentum phase ring (from Momentum.getFileState) ---
      if (typeof Momentum !== "undefined" && Momentum.getFileState && isGlowing && !dimmed) {
        const mState = Momentum.getFileState(node.id);
        if (mState) {
          const mAge = now - mState.ts;
          if (mAge < GLOW_DURATION) {
            const mAlpha = Math.max(0.1, 0.7 * (1 - mAge / GLOW_DURATION));
            const mPhaseColors = {
              exploring: "#8b5cf6", implementing: "#22c55e", testing: "#06b6d4",
              debugging: "#ef4444", planning: "#f59e0b",
            };
            const mRingColor = mPhaseColors[mState.phase] || "#8b5cf6";
            const baseR = dark ? (2.5 + impNorm * 3) * mapScale : (5 + impNorm * 5) * mapScale;
            const mRingR = baseR + 3 * mapScale;
            ctx.save();
            ctx.globalAlpha = mAlpha;
            ctx.strokeStyle = mRingColor;
            ctx.lineWidth = 2 * mapScale;
            if (mState.progress === "drifting") {
              ctx.setLineDash([4 * mapScale, 3 * mapScale]);
            } else if (mState.progress === "stuck") {
              const pulse = 0.5 + 0.5 * Math.sin(now / 500);
              ctx.globalAlpha = mAlpha * pulse;
            }
            ctx.beginPath();
            ctx.arc(x, y, mRingR, 0, Math.PI * 2);
            ctx.stroke();
            if (mState.progress === "breakthrough") {
              ctx.shadowColor = mRingColor;
              ctx.shadowBlur = 6 * mapScale;
              ctx.stroke();
            }
            ctx.restore();
          }
        }
      }

      ctx.globalAlpha = 1;

      // --- Labels ---
      const effectiveR = dark ? (2.5 + impNorm * 3) : (5 + impNorm * 5);
      if (shouldShowLabel(node, effectiveR, isGlowing, isWarm, isHovered, isSelected)) {
        const dl = disambiguatedLabel(node);
        // Match Y-axis label size (screen-space → world-space conversion)
        const screenFsz = isHovered || isSelected ? 11 : 8;
        const fsz = Math.max(4, screenFsz / Math.max(0.2, camZoom));
        ctx.font = `${isHovered || isSelected ? "600" : "400"} ${fsz}px "SF Mono","JetBrains Mono",Menlo,monospace`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";

        let la;
        if (dark) {
          la = isGlowing ? 0.7 : isWarm ? 0.45 : (0.15 + impNorm * 0.2);
          if (dimmed) la *= 0.2;
          if (isHovered || isSelected) la = 0.9;
          ctx.fillStyle = `rgba(200,215,240,${la})`;
        } else {
          la = isGlowing ? 0.7 : isWarm ? 0.5 : (0.2 + impNorm * 0.25);
          if (dimmed) la *= 0.2;
          if (isHovered || isSelected) la = 0.85;
          ctx.fillStyle = `rgba(30,40,50,${la})`;
        }

        // Stagger: check if this label would overlap a previously placed one
        const labelX = x + effectiveR + 8;
        let labelY = y;
        const labelW = dl.length * fsz * 0.6;
        const labelH = fsz + 2;
        for (const prev of placedLabels) {
          // Check overlap: same horizontal region AND same vertical region
          if (Math.abs(labelY - prev.y) < labelH &&
              labelX < prev.x + prev.w && labelX + labelW > prev.x) {
            // Nudge below the conflicting label
            labelY = prev.y + labelH;
          }
        }
        placedLabels.push({ x: labelX, y: labelY, w: labelW, h: labelH });

        ctx.fillText(dl, labelX, labelY);

        // Dir path on hover/select
        if (isHovered || isSelected) {
          ctx.font = `400 ${sf(8)}px "SF Mono",Menlo,monospace`;
          ctx.fillStyle = dark ? "rgba(200,215,240,0.35)" : "rgba(50,70,90,0.4)";
          ctx.fillText(node.dir, labelX, labelY + 13);
        }
      }
      node._laneKey = _savedLaneKey;
    }
    } // end renderPasses

    // Edge hover label (when not hovering a node)
    if (hoveredEdge && !hoveredNode) {
      const srcN = nodes.get(hoveredEdge.source);
      const dstN = nodes.get(hoveredEdge.target);
      if (srcN && dstN) {
        const sSrc = sp(srcN), sDst = sp(dstN);
        drawEdgeLabel(hoveredEdge, dark, (sSrc.x + sDst.x) / 2, (sSrc.y + sDst.y) / 2);
      }
    }

    ctx.restore();

    // --- Fixed axes (screen space overlays) ---
    drawLaneBackgrounds(dark);  // semi-transparent lane bands
    drawLaneLabels(dark);       // fixed Y-axis gutter with labels
    drawTimeAxis(dark);         // fixed X-axis time strip

    // --- HUD elements ---
    drawMiniCard(dark);
    drawStats(dark, now);
    // minimap removed — both sections visible, no need for overview
  }

  function drawMinimap(dark) {
    if (nodes.size === 0) { miniRect = null; return; }
    const mw = 80 * mapScale, mh = 60 * mapScale;
    const axisLeftW = Math.round(AXIS_LEFT_W * mapScale);
    const axisBottomH = Math.round(AXIS_BOTTOM_H * mapScale);
    const mx = axisLeftW + 4, my = height - axisBottomH - 4 - mh;

    // Compute bounding box of all nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes.values()) {
      const sx = spX(n), sy = spY(n);
      if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
    }
    const pad = 30;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const bw = maxX - minX || 1, bh = maxY - minY || 1;
    const scale = Math.min(mw / bw, mh / bh);

    // Store for drag interaction
    miniRect = { mx, my, mw, mh, minX, minY, scale };

    // Background
    ctx.fillStyle = dark ? "rgba(20,28,45,0.85)" : "rgba(240,245,250,0.7)";
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeStyle = dark ? "rgba(200,215,240,0.3)" : "rgba(50,70,90,0.15)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(mx, my, mw, mh);

    // Draw nodes as dots
    for (const n of nodes.values()) {
      if (!nodeVisible(n)) continue;
      const sx = spX(n), sy = spY(n);
      const dx = mx + (sx - minX) * scale;
      const dy = my + (sy - minY) * scale;
      const age = Date.now() - n.lastAccessTs;
      const dotAlpha = age < GLOW_DURATION ? 1.0 : age < WARM_DURATION ? 0.7 : 0.4;
      ctx.fillStyle = dark ? `rgba(200,215,240,${dotAlpha})` : `rgba(50,70,90,${dotAlpha})`;
      ctx.beginPath();
      ctx.arc(dx, dy, 1.5 * mapScale, 0, Math.PI * 2);
      ctx.fill();
    }

    // Viewport rectangle
    const vx1 = camX, vy1 = camY;
    const vx2 = camX + width / camZoom, vy2 = camY + height / camZoom;
    const rx = mx + (vx1 - minX) * scale;
    const ry = my + (vy1 - minY) * scale;
    const rw = (vx2 - vx1) * scale;
    const rh = (vy2 - vy1) * scale;
    // Clamp viewport rect to minimap bounds
    const crx = Math.max(mx, Math.min(mx + mw - 2, rx));
    const cry = Math.max(my, Math.min(my + mh - 2, ry));
    const crw = Math.min(rw, mx + mw - crx);
    const crh = Math.min(rh, my + mh - cry);
    ctx.fillStyle = dark ? "rgba(160,180,208,0.08)" : "rgba(58,90,122,0.06)";
    ctx.fillRect(crx, cry, crw, crh);
    ctx.strokeStyle = dark ? "rgba(160,180,208,0.6)" : "rgba(58,90,122,0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(crx, cry, crw, crh);
  }

  function filterMatchAction(node) {
    if (activeFilters.has("all")) return true;
    return (activeFilters.has("read") && node.readCount > 0) ||
      (activeFilters.has("edit") && node.editCount > 0) ||
      (activeFilters.has("exec") && node.execCount > 0);
  }

  function edgeFilterMatch(edge) {
    if (!sessionFilters.has("all") && ![...edge.sessions].some(s => sessionFilters.has(s))) return false;
    return true;
  }

  // --- Time axis (fixed X-axis strip at bottom of screen) ---
  // Stored from rebuildSimulation so the axis uses the same mapping
  let timeAxisState = { minTs: 0, maxTs: 1, padLeft: 0, usableW: 200, sorted: [] };

  // Convert a simulation-space X to screen X via camera
  function simXToScreen(simX) {
    return (simX - camX) * camZoom;
  }

  function drawTimeAxis(dark) {
    if (nodes.size === 0 || currentLanes.length === 0) return;
    const { padLeft: axPadLeft, usableW: axUsableW, sorted: axisSorted } = timeAxisState;
    if (!axisSorted || axisSorted.length === 0) return;

    // Find the bottom of the last action lane and last phase lane on screen
    const actionBotScreen = actionLanes.length > 0
      ? simYToScreen(actionLanes[actionLanes.length - 1].y + actionLanes[actionLanes.length - 1].h)
      : -999;
    const phaseBotScreen = phaseLanes.length > 0
      ? simYToScreen(phaseLanes[phaseLanes.length - 1].y + phaseLanes[phaseLanes.length - 1].h)
      : -999;

    // Draw action axis if its section is on screen
    if (actionBotScreen > 0 && actionBotScreen < height + 30) {
      drawTimeAxisAt(dark, axPadLeft, axUsableW, axisSorted, actionBotScreen);
    }
    // Draw phase axis if its section is on screen
    if (phaseBotScreen > 0 && phaseBotScreen < height + 30) {
      drawTimeAxisAt(dark, axPadLeft, axUsableW, axisSorted, phaseBotScreen);
    }
  }

  function drawTimeAxisAt(dark, axPadLeft, axUsableW, axisSorted, screenBotY) {
    const axisLeftW = Math.round(AXIS_LEFT_W * mapScale);
    const axisBottomH = Math.round(AXIS_BOTTOM_H * mapScale);

    // Position just below the section, clamped to viewport
    const axisY = Math.min(Math.round(screenBotY) + 2, height - axisBottomH);

    // Opaque background strip
    ctx.save();
    ctx.fillStyle = dark ? "rgba(12,15,24,0.9)" : "rgba(244,243,240,0.92)";
    ctx.fillRect(axisLeftW, axisY, width - axisLeftW, axisBottomH);
    ctx.restore();

    // Top border
    ctx.save();
    ctx.strokeStyle = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(axisLeftW, axisY);
    ctx.lineTo(width, axisY);
    ctx.stroke();
    ctx.restore();

    if (axisY < 0 || axisY > height - 10) return;

    // Evenly-spaced ticks matching the rank-based node positions
    const screenLeft = simXToScreen(axPadLeft);
    const screenRight = simXToScreen(axPadLeft + axUsableW);
    const visibleAxisW = screenRight - screenLeft;
    if (visibleAxisW < 50) return;

    const tickCount = Math.min(6, Math.max(2, Math.floor(visibleAxisW / 110)));
    const fg = dark ? "rgba(200,215,240,0.4)" : "rgba(50,70,90,0.4)";
    const n = axisSorted.length;

    ctx.save();
    ctx.font = `400 ${sf(8)}px "SF Mono",Menlo,monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = fg;

    for (let i = 0; i <= tickCount; i++) {
      const t = i / tickCount;
      // Map evenly-spaced tick to a rank index, then get that node's timestamp
      const rankIdx = Math.min(n - 1, Math.round(t * (n - 1)));
      const tickTs = axisSorted[rankIdx].lastAccessTs;
      // Screen X from the same rank-based formula
      const simX = axPadLeft + t * axUsableW;
      const sx = simXToScreen(simX);

      if (sx < axisLeftW - 10 || sx > width + 10) continue;

      // Tick mark
      ctx.beginPath();
      ctx.moveTo(sx, axisY);
      ctx.lineTo(sx, axisY + 5);
      ctx.strokeStyle = fg;
      ctx.lineWidth = 0.8;
      ctx.stroke();

      // Time label
      const d = new Date(tickTs);
      const label = d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
      ctx.fillText(label, sx, axisY + 7);
    }

    ctx.restore();
  }

  function drawStats(dark, now) {
    const fg = dark ? "rgba(200,215,240,0.3)" : "rgba(50,70,90,0.3)";
    ctx.font = `400 ${sf(8)}px "SF Mono",Menlo,monospace`; ctx.textAlign = "right"; ctx.textBaseline = "top";

    let ac = 0, wc = 0, sc = 0, vn = 0;
    for (const node of nodes.values()) {
      if (!nodeVisible(node)) continue;
      vn++;
      const age = now - node.lastAccessTs;
      if (age < GLOW_DURATION) ac++;
      else if (age < WARM_DURATION) wc++;
      else sc++;
    }

    let ve = 0;
    for (const edge of edges.values()) {
      if (!edgeVisible(edge) || !edgeFilterMatch(edge)) continue;
      const srcN = nodes.get(edge.source);
      const dstN = nodes.get(edge.target);
      if (srcN && dstN && nodeVisible(srcN) && nodeVisible(dstN)) ve++;
    }

    ctx.fillStyle = fg;
    ctx.textAlign = "left";
    const sy = height - 16;
    ctx.fillText(`${vn}/${nodes.size} files · ${ve} edges · ${ac} active · ${wc} warm · ${sc} stale${camZoom !== 1 ? ` · ${Math.round(camZoom * 100)}%` : ""}`, 12, sy);
  }

  // --- Hit testing (uses spread-adjusted positions) ---
  function nodeAt(mx, my) {
    const wx = mx / camZoom + camX, wy = my / camZoom + camY;
    let closest = null, closestDist = Infinity;
    for (const node of nodes.values()) {
      if (!nodeVisible(node)) continue;
      const dx = spX(node) - wx, dy = spY(node) - wy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const r = nodeRadius(node);
      if (dist < r + 6 && dist < closestDist) { closest = node; closestDist = dist; }
    }
    return closest;
  }

  // --- Interaction ---
  const CLICK_THRESHOLD = 4; // px — less movement = click, more = drag
  let mouseDownPos = null; // { x, y, hit, mx, my }

  function initInteraction() {
    canvas.addEventListener("mouseleave", () => { hoveredNode = null; hoveredEdge = null; });

    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;

      // Check if click is on minimap
      if (miniRect && mx >= miniRect.mx && mx <= miniRect.mx + miniRect.mw &&
          my >= miniRect.my && my <= miniRect.my + miniRect.mh) {
        miniDragging = true;
        userDragged = true;
        // Jump camera to clicked position
        const worldX = miniRect.minX + (mx - miniRect.mx) / miniRect.scale;
        const worldY = miniRect.minY + (my - miniRect.my) / miniRect.scale;
        targetCamX = worldX - width / (2 * camZoom);
        targetCamY = worldY - height / (2 * camZoom);
        camX = targetCamX; camY = targetCamY;
        canvas.style.cursor = "crosshair";
        return;
      }

      const hit = nodeAt(mx, my);
      mouseDownPos = { x: e.clientX, y: e.clientY, hit, mx, my };

      if (hit) {
        // Node clicked — don't drag, let mouseup handle selection
        return;
      }

      // Start panning
      isDragging = true;
      userDragged = true;
      dragStartX = e.clientX; dragStartY = e.clientY;
      dragCamX = camX; dragCamY = camY;
      canvas.style.cursor = "grabbing";
    });

    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;

      // Minimap drag
      if (miniDragging && miniRect) {
        const worldX = miniRect.minX + (mx - miniRect.mx) / miniRect.scale;
        const worldY = miniRect.minY + (my - miniRect.my) / miniRect.scale;
        targetCamX = worldX - width / (2 * camZoom);
        targetCamY = worldY - height / (2 * camZoom);
        camX = targetCamX; camY = targetCamY;
        return;
      }

      // Node dragging disabled — positions are deterministic

      if (isDragging) {
        camX = dragCamX - (e.clientX - dragStartX) / camZoom;
        camY = dragCamY - (e.clientY - dragStartY) / camZoom;
        targetCamX = camX; targetCamY = camY; return;
      }

      const hit = nodeAt(mx, my);
      hoveredNode = hit;
      hoveredEdge = hit ? null : findEdgeAtMouse(mx, my);
      // Pointer cursor on nodes and on pinned mini card
      const overMiniCard = miniCardRect && infoCard &&
        mx >= miniCardRect.x && mx <= miniCardRect.x + miniCardRect.w &&
        my >= miniCardRect.y && my <= miniCardRect.y + miniCardRect.h;
      canvas.style.cursor = (hit || overMiniCard) ? "pointer" : hoveredEdge ? "crosshair" : "grab";
    });

    function releaseNode() {
      if (draggingNode) {
        draggingNode = null;
      }
    }

    canvas.addEventListener("mouseup", (e) => {
      const wasClick = mouseDownPos &&
        Math.abs(e.clientX - mouseDownPos.x) < CLICK_THRESHOLD &&
        Math.abs(e.clientY - mouseDownPos.y) < CLICK_THRESHOLD;

      if (wasClick) {
        const mx = mouseDownPos.mx, my = mouseDownPos.my;

        // Check if clicking on pinned mini card → toggle detail popover
        if (miniCardRect && infoCard &&
            mx >= miniCardRect.x && mx <= miniCardRect.x + miniCardRect.w &&
            my >= miniCardRect.y && my <= miniCardRect.y + miniCardRect.h) {
          if (detailOpen) {
            hideDetail();
          } else {
            showDetail(infoCard.node);
          }
          releaseNode();
          mouseDownPos = null;
          return;
        }

        // Click on a node → pin it (show mini card)
        if (mouseDownPos.hit) {
          hideDetail();
          if (selectedNode === mouseDownPos.hit) {
            // Clicking same pinned node → unpin
            dismissAll();
          } else {
            selectedNode = mouseDownPos.hit;
            infoCard = { node: mouseDownPos.hit };
          }
        } else {
          // Click on empty space → dismiss everything
          dismissAll();
        }
      }

      releaseNode();
      if (miniDragging) {
        miniDragging = false;
        canvas.style.cursor = "grab";
      }
      if (isDragging) {
        isDragging = false;
        targetCamX = camX;
        targetCamY = camY;
        canvas.style.cursor = hoveredNode ? "pointer" : "grab";
      }
      mouseDownPos = null;
    });

    document.addEventListener("mouseup", () => {
      releaseNode();
      miniDragging = false;
      if (isDragging) {
        isDragging = false;
        targetCamX = camX;
        targetCamY = camY;
        canvas.style.cursor = "grab";
      }
    });

    // Escape dismisses card
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") dismissAll();
    });

    canvas.addEventListener("wheel", (e) => {
      if (canvas.style.display === "none") return;
      e.preventDefault();
      // Zoom toward mouse position
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const oldZoom = camZoom;
      camZoom = Math.min(4, Math.max(0.1, camZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      // Adjust camera so the point under the cursor stays fixed
      const worldX = mx / oldZoom + camX;
      const worldY = my / oldZoom + camY;
      camX = worldX - mx / camZoom;
      camY = worldY - my / camZoom;
      targetCamX = camX;
      targetCamY = camY;
      userDragged = true; // stop auto-tracking so zoom spread is visible
    }, { passive: false });

    canvas.addEventListener("dblclick", () => { dismissAll(); userDragged = false; targetCamX = 0; targetCamY = 0; camZoom = 1; });
  }

  function getTooltip() {
    if (!hoveredNode && !selectedNode) return null;
    const n = hoveredNode || selectedNode;
    const imp = getImportance(n);
    return { file: n.id, label: n.label, dir: n.dir, readCount: n.readCount, editCount: n.editCount, execCount: n.execCount, total: n.accessCount };
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
    // Scale everything proportionally (baseline: 500px width)
    mapScale = Math.max(0.55, Math.min(1, width / 500));
    canvas.parentElement.style.setProperty("--map-scale", mapScale);
    // Set initial zoom based on canvas size (smaller canvas = more zoomed out)
    if (!userDragged && camZoom === 0.85) {
      camZoom = Math.max(0.5, Math.min(0.85, height / 700));
    }
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
    animFrame = null; simulation = null;
  }

  function reset() {
    nodes.clear(); edges.clear(); lastToolBySession.clear(); activeFiles.clear();
    labelCounts.clear(); hoveredNode = null; selectedNode = null; infoCard = null;
    if (simulation) simulation.stop(); simulation = null;
  }

  function zoom(f) { camZoom = Math.min(4, Math.max(0.1, camZoom * f)); }
  function deselect() { dismissAll(); }

  function getNodes() { return nodes; }
  function getEdges() { return edges; }

  function setYSpread(v) {
    ySpreadScale = Math.max(0.3, Math.min(3, v));
    rebuildSimulation();
  }

  function setNodeSizeScale(v) {
    nodeSizeScale = Math.max(0.1, Math.min(3, v));
    // Node size affects collision radius too
    if (simulation) {
      simulation.force("collision").radius(d => nodeRadius(d) + 8);
      simulation.alpha(0.3).restart();
    }
  }

  function toggleFilterSet(set, value, btnSelector, dataAttr) {
    if (value === "all") {
      set.clear();
      set.add("all");
    } else {
      set.delete("all");
      if (set.has(value)) set.delete(value); else set.add(value);
      if (set.size === 0) set.add("all");
    }
    document.querySelectorAll(btnSelector).forEach(b => b.classList.toggle("active", set.has(b.getAttribute(dataAttr))));
  }

  function setRecencyFilter(type) {
    toggleFilterSet(recencyFilters, type, ".recency-filter-btn", "data-recency");
  }

  function setFilter(type) {
    toggleFilterSet(activeFilters, type, ".filter-btn", "data-filter");
  }

  function setSessionFilter(id, _fromUI) {
    if (_fromUI) {
      // Toggle behavior from map UI clicks
      toggleFilterSet(sessionFilters, id, ".session-filter-btn", "data-session");
      if (onSessionFilterChange) {
        // Sync to app: single session or "all" as string, multi-select as Set
        if (sessionFilters.has("all")) onSessionFilterChange("all");
        else if (sessionFilters.size === 1) onSessionFilterChange([...sessionFilters][0]);
        else onSessionFilterChange(new Set(sessionFilters));
      }
    } else {
      // Direct set from app tab sync — no toggle, just set
      sessionFilters.clear();
      sessionFilters.add(id);
      document.querySelectorAll(".session-filter-btn").forEach(b =>
        b.classList.toggle("active", sessionFilters.has(b.getAttribute("data-session")))
      );
    }
  }

  function registerSession(id, label, color) {
    knownSessions.set(id, { label, color });
    rebuildSessionFilterUI();
  }

  function unregisterSession(id) {
    knownSessions.delete(id);
    sessionFilters.delete(id);
    if (sessionFilters.size === 0) sessionFilters.add("all");
    // Remove nodes that only belong to this session, clean others
    for (const [fp, node] of nodes) {
      node.sessions.delete(id);
      if (node.sessions.size === 0) nodes.delete(fp);
    }
    // Remove edges that reference deleted nodes
    for (const [key, edge] of edges) {
      edge.sessions.delete(id);
      if (edge.sessions.size === 0 || !nodes.has(edge.source) || !nodes.has(edge.target)) edges.delete(key);
    }
    lastToolBySession.delete(id);
    rebuildSimulation();
    rebuildSessionFilterUI();
    if (onSessionFilterChange) onSessionFilterChange(sessionFilters.has("all") ? "all" : [...sessionFilters][0] || "all");
  }

  function isSessionActive(sessionId) {
    const now = Date.now();
    for (const node of nodes.values()) {
      if (node.sessions.has(sessionId) && (now - node.lastAccessTs) < STALE_CUTOFF) return true;
    }
    return false;
  }

  function rebuildSessionFilterUI() {
    const bar = document.getElementById("session-filter-bar");
    if (!bar) return;
    bar.innerHTML = "";

    const activeSessions = [...knownSessions.entries()];

    // Single session: just show its name, no "All" button
    if (activeSessions.length <= 1) {
      if (activeSessions.length === 1) {
        const [id, info] = activeSessions[0];
        const btn = document.createElement("button");
        btn.className = "session-filter-btn active";
        btn.dataset.session = id;
        btn.innerHTML = `<span class="sf-dot" style="background:${info.color}"></span><span class="sf-label">${info.label}</span>`;
        bar.appendChild(btn);
        // Auto-select the single session
        sessionFilters.clear(); sessionFilters.add(id);
      }
      bar.style.display = activeSessions.length === 1 ? "" : "none";
      return;
    }

    // On first transition from 1→2+ sessions, reset auto-selected single to "all"
    if (!rebuildSessionFilterUI._wasMulti && !sessionFilters.has("all") && sessionFilters.size === 1) {
      sessionFilters.clear();
      sessionFilters.add("all");
      if (onSessionFilterChange) onSessionFilterChange("all");
    }
    rebuildSessionFilterUI._wasMulti = true;

    // Multiple sessions: show "All" + each session
    const allBtn = document.createElement("button");
    allBtn.className = `session-filter-btn ${sessionFilters.has("all") ? "active" : ""}`;
    allBtn.dataset.session = "all";
    allBtn.textContent = "All";
    allBtn.onclick = () => setSessionFilter("all", true);
    bar.appendChild(allBtn);

    for (const [id, info] of activeSessions) {
      const btn = document.createElement("button");
      btn.className = `session-filter-btn ${sessionFilters.has(id) ? "active" : ""}`;
      btn.dataset.session = id;
      btn.innerHTML = `<span class="sf-dot" style="background:${info.color}"></span><span class="sf-label">${info.label}</span><span class="sf-close">&times;</span>`;
      btn.onclick = (e) => {
        if (e.target.classList.contains("sf-close")) {
          unregisterSession(id);
        } else {
          setSessionFilter(id, true);
        }
      };
      bar.appendChild(btn);
    }

    bar.style.display = "";
  }

  function getStats() {
    const now = Date.now();
    let visible = 0;
    nodes.forEach(n => { if (nodeVisible(n)) visible++; });
    return { visible, total: nodes.size, edges: edges.size, zoom: Math.round(camZoom * 100) + "%" };
  }

  function setOnSessionFilterChange(cb) { onSessionFilterChange = cb; }

  function setLaneMode(mode) {
    if (mode === laneMode) return;
    laneMode = mode;
    document.querySelectorAll(".lane-btn").forEach(b =>
      b.classList.toggle("active", b.getAttribute("data-lane") === mode)
    );
    // Rebuild simulation (lane mode affects which section nodes are simulated in)
    isFirstBuild = true;
    rebuildSimulation();
    // Focus camera on the selected section
    userDragged = false;
    const top = mode === "phase" ? phaseSectionTop : actionSectionTop;
    const bot = mode === "phase" ? phaseSectionBot : actionSectionBot;
    const centerY = (top + bot) / 2;
    const sectionH = bot - top;
    camZoom = Math.min(1.2, Math.max(0.3, height / (sectionH + 80)));
    targetCamY = centerY - height / (2 * camZoom);
    camY = targetCamY;
    let cx = 0, cn = 0;
    for (const n of nodes.values()) { if (nodeVisible(n)) { cx += n.x; cn++; } }
    if (cn > 0) { targetCamX = cx / cn - width / (2 * camZoom); camX = targetCamX; }
  }

  return { init, addEntry, addEntries, destroy, reset, getTooltip, getStats, zoom, deselect, getNodes, getEdges, setFilter, setRecencyFilter, setSessionFilter, registerSession, unregisterSession, setNodeSizeScale, setYSpread, setOnSessionFilterChange, setLaneMode };
})();
