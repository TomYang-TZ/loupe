"use strict";

// ===== File Gravity Map — 3D =====
// Reads data from the 2D Gravity module (single source of truth).
// Only renders — no duplicate data processing.

const Gravity3D = (() => {
  let container = null;
  let graph = null;

  const STALE_CUTOFF = 30 * 60 * 1000; // 30 min — same as 2D

  function nodeImportance(n) { return (n.editCount || 0) * 3 + (n.execCount || 0) * 2 + (n.readCount || 0); }

  function nodeColor(n) {
    if (n.lastAction === "edit") return "#4ade80";
    if (n.lastAction === "exec") return "#f97316";
    if (n.lastAction === "read") return "#3b82f6";
    return "#8b8b96";
  }

  function edgeColor(type) {
    return ({ prerequisite: "#8b5cf6", coupling: "#f97316", validation: "#4ade80", discovery: "#3b82f6", sequence: "#334155" })[type] || "#334155";
  }

  // Extract repo from path for clustering
  function repoGroup(fp) {
    if (!fp) return "other";
    const m = fp.match(/\/pal\/([^/]+)/);
    if (m) return m[1];
    const p = fp.split("/");
    return p[4] || p[3] || "other";
  }

  function shortLabel(node) {
    // Check for duplicate names
    const allNodes = Gravity.getNodes();
    let dupeCount = 0;
    for (const n of allNodes.values()) {
      if (n.label === node.label) dupeCount++;
    }
    if (dupeCount > 1 && node.dir) {
      const dp = node.dir.split("/");
      const parent = dp[dp.length - 1] || "";
      return parent ? `${parent}/${node.label}` : node.label;
    }
    return node.label;
  }

  // --- Build graph data from 2D Gravity's shared state ---
  function buildGraphData() {
    const srcNodes = Gravity.getNodes();
    const srcEdges = Gravity.getEdges();
    const now = Date.now();
    const visibleIds = new Set();

    const nodes = [];
    for (const n of srcNodes.values()) {
      const imp = nodeImportance(n);
      if (imp < 1) continue;
      const age = now - n.lastAccessTs;
      if (age > STALE_CUTOFF) continue;
      visibleIds.add(n.id);
      nodes.push({
        id: n.id,
        label: shortLabel(n),
        dir: n.dir,
        group: repoGroup(n.id),
        importance: imp,
        color: nodeColor(n),
        readCount: n.readCount,
        editCount: n.editCount,
        execCount: n.execCount,
        accessCount: n.accessCount,
      });
    }

    const links = [];
    for (const e of srcEdges.values()) {
      if (e.weight < 2 && e.type === "sequence") continue;
      if (!visibleIds.has(e.source) || !visibleIds.has(e.target)) continue;
      links.push({ source: e.source, target: e.target, type: e.type, weight: e.weight, color: edgeColor(e.type) });
    }

    return { nodes, links };
  }

  // --- Init ---
  function init(containerEl) {
    container = containerEl;
    const dark = (document.documentElement.dataset.theme || "dark") === "dark";

    graph = ForceGraph3D()(container)
      .backgroundColor(dark ? "#0f172a" : "#f8fafc")
      .nodeLabel(n => `<div style="font:600 11px 'SF Mono',monospace;color:#f1f5f9;background:rgba(15,23,42,0.85);padding:4px 8px;border-radius:4px;border:1px solid #334155">
        <div>${n.label}</div>
        <div style="font:400 9px 'SF Mono',monospace;color:#94a3b8">${n.dir}</div>
        <div style="font:400 9px sans-serif;color:#64748b;margin-top:2px">${n.readCount}r · ${n.editCount}e · ${n.execCount}x</div>
      </div>`)
      .nodeVal(n => Math.max(0.5, Math.sqrt(n.importance) * 0.8))
      .nodeColor(n => n.color)
      .nodeOpacity(0.9)
      .nodeResolution(12)
      .nodeThreeObjectExtend(true)
      .nodeThreeObject(n => {
        if (n.accessCount < 3) return null;
        const sprite = new SpriteText(n.label, 3, n.color);
        sprite.fontFace = "SF Mono, JetBrains Mono, Menlo, monospace";
        sprite.fontWeight = "500";
        sprite.backgroundColor = false;
        sprite.padding = 0;
        const r = Math.max(3, Math.sqrt(n.importance) * 1.2);
        sprite.position.set(0, -(r + 4), 0);
        return sprite;
      })
      .linkColor(l => l.color)
      .linkWidth(l => Math.min(2.5, 0.2 + l.weight * 0.25))
      .linkOpacity(0.25)
      .linkDirectionalParticles(l => l.weight >= 2 ? Math.min(5, Math.ceil(l.weight / 3)) : 0)
      .linkDirectionalParticleSpeed(0.005)
      .linkDirectionalParticleWidth(l => Math.min(2.5, 0.8 + l.weight * 0.15))
      .linkDirectionalParticleColor(l => l.color)
      .onNodeClick(node => {
        const dist = 100;
        graph.cameraPosition(
          { x: node.x + dist, y: node.y + dist, z: node.z + dist },
          { x: node.x, y: node.y, z: node.z },
          1000
        );
      })
      .warmupTicks(100)
      .cooldownTicks(200);

    // Forces
    graph.d3Force("charge").strength(-40).distanceMax(250);
    graph.d3Force("link").distance(50).strength(l => 0.04 + (l.weight || 0) * 0.015);
    graph.d3Force("center").strength(0.01);

    // Repo clustering force
    graph.d3Force("cluster", (alpha) => {
      const gd = graph.graphData();
      if (!gd || !gd.nodes.length) return;
      const groups = new Map();
      for (const n of gd.nodes) {
        const g = n.group || "other";
        if (!groups.has(g)) groups.set(g, { x: 0, y: 0, z: 0, count: 0 });
        const c = groups.get(g);
        c.x += n.x || 0; c.y += n.y || 0; c.z += n.z || 0; c.count++;
      }
      for (const c of groups.values()) { c.x /= c.count; c.y /= c.count; c.z /= c.count; }
      const strength = 0.15;
      for (const n of gd.nodes) {
        const c = groups.get(n.group || "other");
        if (!c || c.count < 2) continue;
        n.vx += (c.x - (n.x || 0)) * strength * alpha;
        n.vy += (c.y - (n.y || 0)) * strength * alpha;
        n.vz += (c.z - (n.z || 0)) * strength * alpha;
      }
    });

    graph.cameraPosition({ x: 0, y: 0, z: 350 });
  }

  function rebuild() {
    if (!graph) return;
    graph.graphData(buildGraphData());
    if (window.updateGravityHud) window.updateGravityHud();
  }

  // No loadFullHistory — 2D module already loaded data. Just rebuild from its state.
  function loadFullHistory() {
    rebuild();
  }

  function addEntry() {
    // Data already processed by 2D Gravity. Just rebuild view.
    rebuild();
  }

  function destroy() {
    if (graph) { if (graph._destructor) graph._destructor(); graph = null; }
    if (container) container.innerHTML = "";
  }

  function resize() {
    if (graph && container) { graph.width(container.clientWidth); graph.height(container.clientHeight); }
  }

  function zoom(factor) {
    if (!graph) return;
    const cam = graph.camera();
    cam.position.multiplyScalar(1 / factor);
    cam.updateProjectionMatrix();
  }

  function getStats() {
    const data = graph ? graph.graphData() : { nodes: [], links: [] };
    return { nodes: data.nodes.length, totalNodes: Gravity.getNodes().size, edges: data.links.length, totalEdges: Gravity.getEdges().size };
  }

  return { init, loadFullHistory, addEntry, rebuild, destroy, resize, getStats, zoom };
})();
