"use strict";

// ===== Momentum Map v2 =====
// Force-directed behavioral graph for Claude Code sessions.
// Thought-action spans as nodes, clustered by workflow phase.
// Two-layer state: phase (fill) + progress signal (ring).

const Momentum = (() => {
  // --- State ---
  let canvas, ctx;
  let width = 0, height = 0;
  let simulation = null;
  let animFrame = null;
  let lastRenderTime = 0;

  // Per-session span state
  const sessionState = new Map(); // sessionId -> { spans: [], current: null, erroredFiles: Set }
  let spanIdCounter = 0;
  const sessionSeqCounters = new Map(); // sessionId -> counter

  // File phase map (shared with gravity for augmentation)
  const filePhaseMap = new Map(); // filePath -> { phase, progress, ts }

  // Session registry
  const sessionColors = new Map();
  const sessionLabels = new Map();
  let sessionFilter = "all";
  let onSessionFilterChange = null;

  // Interaction
  let hoveredNode = null;
  let tooltipEl = null;
  let onClickSpan = null;

  // Camera (pan/zoom like gravity.js)
  let camX = 0, camY = 0, camZoom = 1.0;
  let isDragging = false, dragStartX = 0, dragStartY = 0, dragCamX = 0, dragCamY = 0;
  let draggingNode = null;
  let draggingCluster = null; // { phase, startWX, startWY, nodeStarts: [{node, x, y}] }
  let wasDragging = false; // suppress click after drag
  let dragMoved = false; // did mouse actually move during drag?

  // Cluster hit rects (updated each frame)
  const clusterRects = new Map(); // phase -> { x, y, w, h }

  // Spread scale
  let edgeLengthScale = 1.0;
  let spreadCX = 0, spreadCY = 0;

  // D3 simulation nodes/links
  let simNodes = [];
  let simLinks = [];
  let dirty = false;
  let rebuildTimer = null;

  // --- Constants ---
  const PHASE_COLORS = {
    exploring:    { dark: "#8b5cf6", light: "#6d28d9" },
    implementing: { dark: "#22c55e", light: "#15803d" },
    testing:      { dark: "#06b6d4", light: "#0e7490" },
    debugging:    { dark: "#ef4444", light: "#b91c1c" },
    planning:     { dark: "#f59e0b", light: "#b45309" },
  };

  const PROGRESS_COLORS = {
    approaching:  "#22c55e",
    drifting:     "#eab308",
    stuck:        "#ef4444",
    breakthrough: "#3b82f6",
  };

  const WINDOW_SIZE = 5;
  const NODE_MIN_R = 8;
  const NODE_MAX_R = 24;
  let mapScale = 1.0; // scale factor based on canvas size (baseline 400px)
  const TEST_CMD_RE = /\b(test|pytest|vitest|jest|mocha|karma|cypress|playwright)\b|npm\s+(run\s+)?test|npx\s+test/i;

  // Stopwords for goal drift
  const STOPWORDS = new Set([
    "i", "me", "my", "we", "our", "you", "your", "the", "a", "an", "is", "are",
    "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
    "did", "will", "would", "could", "should", "may", "might", "shall", "can",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into",
    "through", "during", "before", "after", "above", "below", "between",
    "and", "but", "or", "nor", "not", "no", "so", "if", "then", "than",
    "that", "this", "these", "those", "it", "its", "let", "just", "also",
    "about", "up", "out", "off", "over", "under", "again", "further",
    "here", "there", "when", "where", "why", "how", "all", "each", "every",
    "both", "few", "more", "most", "other", "some", "such", "only", "own",
    "same", "very", "need", "check", "look", "see", "use", "make", "get",
    "now", "well", "also", "back", "still", "even", "way", "want", "going",
    "ll", "re", "ve", "don", "doesn", "didn", "won", "wouldn", "couldn",
  ]);

  // --- Tool Classification ---
  const TOOL_ACTIONS = {
    Read: "read", Grep: "read", Glob: "read",
    Edit: "edit", Write: "edit",
    Bash: "exec",
  };

  const BASH_CMD_CATEGORY = {
    cat: "read", head: "read", tail: "read", less: "read", more: "read",
    ls: "read", stat: "read", file: "read", wc: "read",
    sed: "edit", awk: "edit", tee: "edit", chmod: "edit", chown: "edit",
    touch: "edit", mv: "edit", cp: "edit",
    rm: "exec", mkdir: "exec", rmdir: "exec",
    node: "exec", python: "exec", python3: "exec", npm: "exec", npx: "exec",
    make: "exec", cargo: "exec", go: "exec", git: "exec", docker: "exec",
    curl: "exec", wget: "exec",
  };

  function extractBashSubcommand(cmd) {
    if (!cmd) return null;
    const m = cmd.match(/^(?:sudo\s+|env\s+\S+=\S+\s+)*(\w[\w.+-]*)/);
    return m ? m[1] : null;
  }

  function extractToolName(entry) {
    const json = entry.json; if (!json) return null;
    const hook = (json._logstream_type && json.data) ? json.data : null;
    return (hook || json).tool_name || (hook || json).name || null;
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
      const fileMatch = cmd.match(/(?:^|\s)(\/\S+\.\w+)/);
      if (fileMatch) return fileMatch[1];
      const dirMatch = cmd.match(/(?:^|\s)(\/(?:[^\s/]+\/)+[^\s/]+)/);
      if (dirMatch) return dirMatch[1];
    }
    return null;
  }

  function extractBashCommand(entry) {
    const json = entry.json; if (!json) return null;
    const hook = (json._logstream_type && json.data) ? json.data : null;
    const inner = hook || json;
    const input = inner.tool_input || inner.input || {};
    return input.command || null;
  }

  function classifyAction(entry) {
    const toolName = extractToolName(entry);
    if (!toolName) return "read";
    let action = TOOL_ACTIONS[toolName] || "read";
    if (toolName === "Bash") {
      const json = entry.json;
      const hook = (json._logstream_type && json.data) ? json.data : null;
      const input = (hook || json).tool_input || (hook || json).input || {};
      const subcmd = extractBashSubcommand(input.command);
      if (subcmd && BASH_CMD_CATEGORY[subcmd]) action = BASH_CMD_CATEGORY[subcmd];
      else if (subcmd) action = "exec";
    }
    return action;
  }

  // =====================
  // SPAN PARSER
  // =====================

  function getSessionState(sessionId) {
    if (!sessionState.has(sessionId)) {
      sessionState.set(sessionId, { spans: [], current: null, erroredFiles: new Set() });
    }
    return sessionState.get(sessionId);
  }

  function nextSeq(sessionId) {
    const c = (sessionSeqCounters.get(sessionId) || 0) + 1;
    sessionSeqCounters.set(sessionId, c);
    return c;
  }

  function newSpan(entry) {
    const sid = entry.sessionId || "default";
    const thinkingText = entry.json?.data?.thinking || entry.body || "";
    return {
      id: spanIdCounter++,
      sequenceNum: nextSeq(sid),
      sessionId: sid,
      startTs: entry.ts || Date.now(),
      endTs: entry.ts || Date.now(),
      userQuery: entry.userQuery || null,
      thinkingText: thinkingText.slice(0, 500),
      entryId: entry.id,
      actions: [],
      files: new Set(),
      bashCommands: [],
      hasError: false,
      phase: "exploring",
      progress: null,
      patterns: { looping: 0, narrowing: 0, backtracking: 0, explosion: 0, breakthrough: 0, goalDrift: 0 },
      causalTrigger: null,
      // D3 simulation fields (added during rebuild)
      x: undefined, y: undefined, vx: 0, vy: 0,
    };
  }

  function newPreambleSpan(sessionId, ts) {
    return {
      id: spanIdCounter++,
      sequenceNum: nextSeq(sessionId),
      sessionId,
      startTs: ts,
      endTs: ts,
      userQuery: null,
      thinkingText: "",
      entryId: null,
      actions: [],
      files: new Set(),
      bashCommands: [],
      hasError: false,
      phase: "exploring",
      progress: null,
      patterns: { looping: 0, narrowing: 0, backtracking: 0, explosion: 0, breakthrough: 0, goalDrift: 0 },
      causalTrigger: null,
      x: undefined, y: undefined, vx: 0, vy: 0,
    };
  }

  function appendAction(span, entry) {
    const toolName = extractToolName(entry) || entry.title || "unknown";
    const filePath = extractFilePath(entry);
    const action = classifyAction(entry);
    const isError = entry.category === "error";

    span.actions.push({ toolName, filePath, action, ts: entry.ts || Date.now(), isError });
    if (filePath) span.files.add(filePath);
    span.endTs = entry.ts || Date.now();

    // Track bash commands for test detection
    if (toolName === "Bash") {
      const cmd = extractBashCommand(entry);
      if (cmd) span.bashCommands.push(cmd);
    }

    if (isError) {
      span.hasError = true;
      if (filePath) {
        const state = getSessionState(span.sessionId);
        state.erroredFiles.add(filePath);
      }
    }
  }

  function finalizeSpan(state) {
    const span = state.current;
    if (!span) return;

    const window = state.spans.slice(-WINDOW_SIZE);

    // Classify workflow phase
    span.phase = classifyPhase(state, span);

    // Run pattern detectors
    span.patterns.looping = detectLooping(window, span);
    span.patterns.narrowing = detectNarrowing(window, span);
    span.patterns.backtracking = detectBacktracking(state, span);
    span.patterns.explosion = detectExplosion(window, span);
    span.patterns.breakthrough = detectBreakthrough(window, span);
    span.patterns.goalDrift = detectGoalDrift(window, span);

    // Classify progress signal
    span.progress = classifyProgress(window, span);

    // Update file phase map (for gravity augmentation)
    for (const f of span.files) {
      filePhaseMap.set(f, { phase: span.phase, progress: span.progress, ts: span.endTs });
    }

    state.spans.push(span);
    state.current = null;
    scheduleRebuild();
  }

  function processEntry(entry) {
    const sid = entry.sessionId || "default";
    const state = getSessionState(sid);

    if (entry.category === "thinking") {
      if (state.current) finalizeSpan(state);
      state.current = newSpan(entry);
      return;
    }

    if (entry.category === "tool_use" || entry.category === "sub_agent") {
      if (!state.current) state.current = newPreambleSpan(sid, entry.ts || Date.now());
      appendAction(state.current, entry);
      return;
    }

    if (entry.category === "error") {
      if (state.current) {
        state.current.causalTrigger = { type: "error", entry };
        appendAction(state.current, entry);
      }
      return;
    }

    if (entry.category === "sub_agent_result") {
      if (state.current && !state.current.causalTrigger) {
        state.current.causalTrigger = { type: "subagent_result", entry };
      }
    }
  }

  // =====================
  // PHASE CLASSIFIER (Layer 1)
  // =====================

  function classifyPhase(state, span) {
    const total = span.actions.length;
    if (total === 0) {
      // Thinking-only span with long text = planning
      if (span.thinkingText.length > 500) return "planning";
      return "exploring";
    }

    let reads = 0, edits = 0, execs = 0;
    for (const a of span.actions) {
      if (a.action === "read") reads++;
      else if (a.action === "edit") edits++;
      else if (a.action === "exec") execs++;
    }

    // Priority cascade: debugging > testing > implementing > planning > exploring
    // Debugging: error in span OR revisiting errored files
    if (span.hasError) return "debugging";
    if (state.erroredFiles.size > 0) {
      let revisiting = 0;
      for (const f of span.files) {
        if (state.erroredFiles.has(f)) revisiting++;
      }
      if (revisiting > 0 && revisiting / span.files.size > 0.3) return "debugging";
    }

    // Testing: exec actions with test-like commands
    if (execs / total >= 0.3) {
      const hasTestCmd = span.bashCommands.some(cmd => TEST_CMD_RE.test(cmd));
      if (hasTestCmd) return "testing";
    }

    // Implementing: edit-heavy
    if (edits / total >= 0.4) return "implementing";

    // Planning: long thinking, few actions
    if (span.thinkingText.length > 500 && total <= 2) return "planning";

    // Exploring: default
    return "exploring";
  }

  // =====================
  // PROGRESS CLASSIFIER (Layer 2)
  // =====================

  function classifyProgress(window, span) {
    const p = span.patterns;

    // Breakthrough: new files after stuck/narrowing plateau
    if (p.breakthrough > 0.5) return "breakthrough";
    // Also check if previous spans were stuck
    const recentStuck = window.slice(-3).filter(s => s.progress === "stuck").length;
    if (recentStuck >= 2 && p.explosion > 0.4) return "breakthrough";

    // Stuck: looping or repeated backtracking in debug phase
    if (p.looping > 0.5) return "stuck";
    const recentDebug = window.slice(-3).filter(s => s.phase === "debugging").length;
    if (p.backtracking > 0.4 && recentDebug >= 3) return "stuck";

    // Drifting: goal drift or unstructured explosion
    if (p.goalDrift > 0.3) return "drifting";
    if (p.explosion > 0.5 && p.narrowing < 0.2) return "drifting";

    // Approaching: narrowing without looping
    if (p.narrowing > 0.4 && p.looping < 0.3) return "approaching";

    // Neutral: not enough signal
    return null;
  }

  // =====================
  // PATTERN DETECTORS (unchanged from v1)
  // =====================

  function detectLooping(window, span) {
    if (span.actions.length < 2) return 0;
    const recent = [];
    if (window.length > 0) {
      const prev = window[window.length - 1];
      for (const a of prev.actions) recent.push(`${a.toolName}:${a.filePath || ""}`);
    }
    for (const a of span.actions) recent.push(`${a.toolName}:${a.filePath || ""}`);
    if (recent.length < 4) return 0;
    let repeats = 0;
    for (let i = 2; i < recent.length; i++) {
      if (recent[i] === recent[i - 2] && recent[i - 1] === recent[i - 3]) repeats++;
    }
    return Math.min(1, repeats / (recent.length / 2));
  }

  function detectNarrowing(window, span) {
    const counts = [...window, span].map(s => s.files.size);
    if (counts.length < 3) return 0;
    const mid = Math.floor(counts.length / 2);
    const firstHalf = counts.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const secondHalf = counts.slice(mid).reduce((a, b) => a + b, 0) / (counts.length - mid);
    if (firstHalf <= 0) return 0;
    return Math.max(0, Math.min(1, (firstHalf - secondHalf) / firstHalf));
  }

  function detectBacktracking(state, span) {
    if (state.erroredFiles.size === 0 || span.files.size === 0) return 0;
    let revisited = 0;
    for (const f of span.files) {
      if (state.erroredFiles.has(f)) revisited++;
    }
    return Math.min(1, revisited / span.files.size);
  }

  function detectExplosion(window, span) {
    if (span.files.size === 0) return 0;
    const knownFiles = new Set();
    for (const s of window) {
      for (const f of s.files) knownFiles.add(f);
    }
    let newFiles = 0;
    for (const f of span.files) {
      if (!knownFiles.has(f)) newFiles++;
    }
    return Math.min(1, newFiles / span.files.size);
  }

  function detectBreakthrough(window, span) {
    if (window.length < 3) return 0;
    const narrowScores = window.slice(-3).map(s => s.patterns.narrowing || 0);
    const avgNarrow = narrowScores.reduce((a, b) => a + b, 0) / narrowScores.length;
    const explosionScore = detectExplosion(window, span);
    if (avgNarrow < 0.3 || explosionScore < 0.4) return 0;
    return Math.min(1, avgNarrow * explosionScore * 2);
  }

  function detectGoalDrift(window, span) {
    const query = span.userQuery;
    if (!query) return 0;
    const queryKeywords = extractKeywords(query);
    if (queryKeywords.size === 0) return 0;
    const allSpans = [...window, span];
    if (allSpans.length < 3) return 0;
    const overlaps = allSpans.map(s => {
      const entities = extractSpanEntities(s);
      let overlap = 0;
      for (const kw of queryKeywords) {
        for (const e of entities) {
          if (e.includes(kw) || kw.includes(e)) { overlap++; break; }
        }
      }
      return queryKeywords.size > 0 ? overlap / queryKeywords.size : 0;
    });
    if (overlaps.length < 2) return 0;
    const mid = Math.floor(overlaps.length / 2);
    const firstHalf = overlaps.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const secondHalf = overlaps.slice(mid).reduce((a, b) => a + b, 0) / (overlaps.length - mid);
    return Math.max(0, Math.min(1, (firstHalf - secondHalf) * 2));
  }

  function extractKeywords(text) {
    const words = text.toLowerCase().replace(/[^a-z0-9_./\s-]/g, " ").split(/\s+/);
    const kws = new Set();
    for (const w of words) {
      if (w.length > 2 && !STOPWORDS.has(w)) kws.add(w);
    }
    return kws;
  }

  function extractSpanEntities(span) {
    const entities = new Set();
    for (const f of span.files) {
      const parts = f.split("/");
      const base = parts[parts.length - 1];
      if (base) entities.add(base.toLowerCase().replace(/\.\w+$/, ""));
    }
    for (const a of span.actions) entities.add(a.toolName.toLowerCase());
    if (span.thinkingText) {
      for (const kw of extractKeywords(span.thinkingText.slice(0, 200))) entities.add(kw);
    }
    return entities;
  }

  // =====================
  // FORCE-DIRECTED GRAPH
  // =====================

  function nodeRadius(span) {
    const dur = Math.max(500, span.endTs - span.startTs);
    const base = Math.max(NODE_MIN_R, Math.min(NODE_MAX_R, 10 + Math.log2(1 + dur / 1000) * 2.5));
    return base * mapScale;
  }

  function collectAllSpans() {
    const spans = [];
    for (const [sid, state] of sessionState) {
      if (sessionFilter !== "all" && sessionFilter !== sid) continue;
      for (const s of state.spans) spans.push(s);
      if (state.current) spans.push(state.current);
    }
    return spans;
  }

  function rebuildSimulation() {
    const allSpans = collectAllSpans();
    simNodes = allSpans;
    simLinks = [];

    // Build sequential edges
    for (const [sid, state] of sessionState) {
      if (sessionFilter !== "all" && sessionFilter !== sid) continue;
      const spans = [...state.spans];
      if (state.current) spans.push(state.current);
      for (let i = 1; i < spans.length; i++) {
        simLinks.push({ source: spans[i - 1], target: spans[i] });
      }
    }

    if (simulation) simulation.stop();

    if (simNodes.length === 0) {
      simulation = null;
      return;
    }

    // Count phase-to-phase transition frequencies for edge thickness
    const transFreq = new Map();
    for (const link of simLinks) {
      const key = `${link.source.phase}->${link.target.phase}`;
      transFreq.set(key, (transFreq.get(key) || 0) + 1);
    }
    for (const link of simLinks) {
      const key = `${link.source.phase}->${link.target.phase}`;
      link.freq = transFreq.get(key) || 1;
    }

    // Ensure canvas is sized before building simulation
    resizeCanvas();
    const cx = width > 0 ? width / 2 : 300;
    const cy = height > 0 ? height / 2 : 200;

    // Place nodes near center if they have no position yet
    for (const n of simNodes) {
      if (n.x == null || n.x === undefined) { n.x = cx + (Math.random() - 0.5) * 50; }
      if (n.y == null || n.y === undefined) { n.y = cy + (Math.random() - 0.5) * 50; }
    }

    simulation = d3.forceSimulation(simNodes)
      .force("charge", d3.forceManyBody().strength(-150).distanceMax(400))
      .force("link", d3.forceLink(simLinks).distance(70).strength(0.06))
      .force("center", d3.forceCenter(cx, cy).strength(0.02))
      .force("collision", d3.forceCollide().radius(d => nodeRadius(d) + 6).strength(0.8))
      .force("cluster", clusterForce(0.08))
      .velocityDecay(0.4)
      .alphaDecay(0.05);

    // Warm up
    simulation.tick(Math.min(80, simNodes.length * 20 + 20));

    simulation.on("tick", () => {});
    autoFitCamera();
  }

  function autoFitCamera() {
    if (simNodes.length === 0 || width === 0 || height === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of simNodes) {
      if (n.x == null) continue;
      const r = nodeRadius(n);
      minX = Math.min(minX, n.x - r);
      minY = Math.min(minY, n.y - r);
      maxX = Math.max(maxX, n.x + r);
      maxY = Math.max(maxY, n.y + r);
    }
    if (minX === Infinity) return;
    const pad = 80;
    const bw = Math.max(200, maxX - minX + pad * 2);
    const bh = Math.max(150, maxY - minY + pad * 2);
    camZoom = Math.min(width / bw, height / bh, 1.2);
    camZoom = Math.max(0.3, camZoom);
    // Center the bounding box in the viewport
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    camX = cx - (width / camZoom) / 2;
    camY = cy - (height / camZoom) / 2;
  }

  // Custom cluster force: pull nodes with same phase together
  function clusterForce(strength) {
    let nodes;
    function force(alpha) {
      const centroids = new Map();
      const counts = new Map();
      for (const n of nodes) {
        if (n.x == null) continue;
        const k = clusterKey(n);
        if (!centroids.has(k)) { centroids.set(k, { x: 0, y: 0 }); counts.set(k, 0); }
        centroids.get(k).x += n.x;
        centroids.get(k).y += n.y;
        counts.set(k, counts.get(k) + 1);
      }
      for (const [k, c] of centroids) {
        c.x /= counts.get(k);
        c.y /= counts.get(k);
      }
      for (const n of nodes) {
        if (n.x == null) continue;
        const c = centroids.get(clusterKey(n));
        if (c) {
          n.vx += (c.x - n.x) * strength * alpha;
          n.vy += (c.y - n.y) * strength * alpha;
        }
      }
    }
    force.initialize = (n) => { nodes = n; };
    return force;
  }

  // Cluster key: session + phase (so different sessions don't share a box)
  function clusterKey(n) { return `${n.sessionId}::${n.phase}`; }

  // Spread-scaled position helpers
  function spX(n) { return spreadCX + (n.x - spreadCX) * edgeLengthScale; }
  function spY(n) { return spreadCY + (n.y - spreadCY) * edgeLengthScale; }

  function scheduleRebuild() {
    if (!dirty) {
      dirty = true;
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => { dirty = false; rebuildSimulation(); }, 150);
    }
  }

  // =====================
  // CANVAS RENDERER
  // =====================

  function isDark() {
    return document.documentElement.getAttribute("data-theme") !== "light";
  }

  function phaseColor(phase) {
    const mode = isDark() ? "dark" : "light";
    return (PHASE_COLORS[phase] || PHASE_COLORS.exploring)[mode];
  }

  function resizeCanvas() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mapScale = Math.max(0.5, Math.min(1, Math.min(width, height) / 400));
  }

  function render() {
    if (!canvas || !ctx) return;
    animFrame = requestAnimationFrame(render);

    const now = performance.now();
    if (now - lastRenderTime < 16) return; // ~60fps for smooth simulation
    lastRenderTime = now;

    resizeCanvas();
    ctx.clearRect(0, 0, width, height);

    const dark = isDark();

    // Background — subtle radial gradient for depth
    if (dark) {
      const bgGrad = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
      bgGrad.addColorStop(0, "#1a1e2e");
      bgGrad.addColorStop(1, "#0c0f18");
      ctx.fillStyle = bgGrad;
    } else {
      ctx.fillStyle = "#f4f3f0";
    }
    ctx.fillRect(0, 0, width, height);

    if (simNodes.length === 0) {
      drawEmptyState();
      return;
    }

    // Compute spread center of mass
    let sx = 0, sy = 0, sc = 0;
    for (const n of simNodes) {
      if (n.x != null) { sx += n.x; sy += n.y; sc++; }
    }
    if (sc > 0) { spreadCX = sx / sc; spreadCY = sy / sc; }

    ctx.save();
    ctx.translate(-camX * camZoom, -camY * camZoom);
    ctx.scale(camZoom, camZoom);

    // Draw session circles (faint circular territory per session)
    drawSessionCircles(dark);

    // Draw phase cluster backgrounds
    drawClusterBackgrounds(dark, now);

    // Draw edges
    drawEdges(dark, now);

    // Draw nodes
    drawNodes(dark, now);

    ctx.restore();

    // Minimap (screen space)
    drawMinimap(dark);
  }

  function drawMinimap(dark) {
    if (simNodes.length === 0) return;
    const mw = 80 * mapScale, mh = 60 * mapScale;
    const mx = 8, my = height - 8 - mh;

    // Bounding box of all nodes (in spread-scaled coords)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of simNodes) {
      if (n.x == null) continue;
      const nx = spX(n), ny = spY(n);
      if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
      if (ny < minY) minY = ny; if (ny > maxY) maxY = ny;
    }
    const pad = 30;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const bw = maxX - minX || 1, bh = maxY - minY || 1;
    const scale = Math.min(mw / bw, mh / bh);

    // Background
    ctx.fillStyle = dark ? "rgba(20,28,45,0.85)" : "rgba(240,245,250,0.7)";
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeStyle = dark ? "rgba(200,215,240,0.3)" : "rgba(50,70,90,0.15)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(mx, my, mw, mh);

    // Draw nodes as colored dots
    for (const n of simNodes) {
      if (n.x == null) continue;
      const nx = spX(n), ny = spY(n);
      const dx = mx + (nx - minX) * scale;
      const dy = my + (ny - minY) * scale;
      ctx.fillStyle = phaseColor(n.phase);
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(dx, dy, Math.max(1.5, 2 * mapScale), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Viewport rectangle
    const vx1 = camX, vy1 = camY;
    const vx2 = camX + width / camZoom, vy2 = camY + height / camZoom;
    const rx = mx + (vx1 - minX) * scale;
    const ry = my + (vy1 - minY) * scale;
    const rw = (vx2 - vx1) * scale;
    const rh = (vy2 - vy1) * scale;
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

  function drawSessionCircles(dark) {
    const sessionGroups = new Map();
    for (const n of simNodes) {
      if (n.x == null) continue;
      if (!sessionGroups.has(n.sessionId)) sessionGroups.set(n.sessionId, []);
      sessionGroups.get(n.sessionId).push(n);
    }
    if (sessionGroups.size < 2) return;

    function hexToRgb(hex) {
      return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    }

    for (const [sid, nodes] of sessionGroups) {
      if (nodes.length === 0) continue;
      const color = sessionColors.get(sid) || (dark ? "#a1a1aa" : "#71717a");
      const [cr, cg, cb] = hexToRgb(color);

      let cx = 0, cy = 0;
      for (const n of nodes) { cx += spX(n); cy += spY(n); }
      cx /= nodes.length; cy /= nodes.length;
      let maxDist = 0;
      for (const n of nodes) {
        const dx = spX(n) - cx, dy = spY(n) - cy;
        maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy) + nodeRadius(n));
      }
      const radius = maxDist + 40 * mapScale;
      const seed = sid.length + nodes.length;

      // Draw wobbly blob with radial gradient fill (fades at edges)
      ctx.save();

      // Build wobbly path
      const pts = 12;
      const blobPoints = [];
      for (let i = 0; i < pts; i++) {
        const angle = (i / pts) * Math.PI * 2;
        const wobble = 1 + 0.12 * Math.sin(angle * 3.7 + seed * 1.3) * Math.cos(angle * 2.1 + seed * 0.7);
        const r = radius * wobble;
        blobPoints.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
      }

      // Smooth closed curve through points
      ctx.beginPath();
      ctx.moveTo(blobPoints[0].x, blobPoints[0].y);
      for (let i = 0; i < pts; i++) {
        const curr = blobPoints[i];
        const next = blobPoints[(i + 1) % pts];
        const cpx = (curr.x + next.x) / 2;
        const cpy = (curr.y + next.y) / 2;
        ctx.quadraticCurveTo(curr.x, curr.y, cpx, cpy);
      }
      ctx.closePath();

      // Clip to blob shape, then fill with radial gradient for fade effect
      ctx.save();
      ctx.clip();
      const outerR = radius * 1.15;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR);
      // In dark mode, blend toward lighter tint so it's visible against #050510
      const dr = dark ? Math.min(255, cr + 80) : cr;
      const dg = dark ? Math.min(255, cg + 80) : cg;
      const db = dark ? Math.min(255, cb + 80) : cb;
      const alpha = dark ? 0.18 : 0.12;
      grad.addColorStop(0, `rgba(${dr},${dg},${db},${alpha})`);
      grad.addColorStop(0.6, `rgba(${dr},${dg},${db},${alpha * 0.6})`);
      grad.addColorStop(1, `rgba(${dr},${dg},${db},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(cx - outerR, cy - outerR, outerR * 2, outerR * 2);
      ctx.restore();

      // Session label above
      let topY = Infinity;
      for (const n of nodes) { topY = Math.min(topY, spY(n) - nodeRadius(n)); }
      const label = sessionLabels.get(sid) || sid.slice(0, 8);
      ctx.globalAlpha = dark ? 0.35 : 0.45;
      ctx.fillStyle = color;
      ctx.font = `600 ${Math.round(11 * mapScale)}px "SF Mono", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(label, cx, topY - 14 * mapScale);

      ctx.restore();
    }
  }

  function drawClusterBackgrounds(dark, now) {
    const clusters = new Map(); // clusterKey -> { minX, minY, maxX, maxY, count, phase, sessionId }
    for (const n of simNodes) {
      if (n.x == null) continue;
      const r = nodeRadius(n);
      const k = clusterKey(n);
      if (!clusters.has(k)) {
        clusters.set(k, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, count: 0, phase: n.phase, sessionId: n.sessionId });
      }
      const c = clusters.get(k);
      c.minX = Math.min(c.minX, spX(n) - r);
      c.minY = Math.min(c.minY, spY(n) - r);
      c.maxX = Math.max(c.maxX, spX(n) + r);
      c.maxY = Math.max(c.maxY, spY(n) + r);
      c.count++;
    }

    clusterRects.clear();
    for (const [key, bounds] of clusters) {
      if (bounds.count < 1) continue;
      const pad = 24 * mapScale;
      const x = bounds.minX - pad;
      const y = bounds.minY - pad;
      const w = bounds.maxX - bounds.minX + pad * 2;
      const h = bounds.maxY - bounds.minY + pad * 2;
      clusterRects.set(key, { x, y, w, h, phase: bounds.phase });
      const color = phaseColor(bounds.phase);

      ctx.save();
      ctx.fillStyle = color;
      ctx.globalAlpha = dark ? 0.15 : 0.12;
      drawRoundedRect(x, y, w, h, 12);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.globalAlpha = dark ? 0.35 : 0.35;
      ctx.lineWidth = 1;
      drawRoundedRect(x, y, w, h, 12);
      ctx.stroke();

      // Phase label below cluster (session identity comes from the circle)
      const label = bounds.phase;
      ctx.globalAlpha = dark ? 0.6 : 0.7;
      ctx.font = `500 ${Math.round(10 * mapScale)}px "SF Mono", monospace`;
      ctx.fillStyle = dark ? "rgba(220,230,255,0.9)" : color;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(label, x + w / 2, y + h + 4);
      ctx.restore();
    }
  }

  function drawEdges(dark, now) {
    const arrowSize = 6;
    for (const link of simLinks) {
      const s = link.source;
      const t = link.target;
      if (s.x == null || t.x == null) continue;

      const sx1 = spX(s), sy1 = spY(s), sx2 = spX(t), sy2 = spY(t);
      const dx = sx2 - sx1;
      const dy = sy2 - sy1;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;

      const sr = nodeRadius(s);
      const tr = nodeRadius(t);
      // Shorten to node edges
      const ratio = (dist - sr - tr) / dist;
      if (ratio <= 0) continue;
      const x1 = sx1 + dx * (sr / dist);
      const y1 = sy1 + dy * (sr / dist);
      const x2 = sx1 + dx * (1 - tr / dist);
      const y2 = sy1 + dy * (1 - tr / dist);

      const destColor = phaseColor(t.phase);
      const thickness = Math.min(3, 1 + (link.freq - 1) * 0.4);

      ctx.save();
      ctx.strokeStyle = destColor;
      ctx.globalAlpha = dark ? 0.25 : 0.3;
      ctx.lineWidth = thickness;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // Arrow at target end
      const angle = Math.atan2(y2 - y1, x2 - x1);
      ctx.fillStyle = destColor;
      ctx.globalAlpha = dark ? 0.35 : 0.4;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - arrowSize * Math.cos(angle - 0.4), y2 - arrowSize * Math.sin(angle - 0.4));
      ctx.lineTo(x2 - arrowSize * Math.cos(angle + 0.4), y2 - arrowSize * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawNodes(dark, now) {
    const firstTs = simNodes.length > 0 ? simNodes[0].startTs : now;
    const lastTs = simNodes.length > 0 ? simNodes[simNodes.length - 1].endTs : now;
    const range = Math.max(1, lastTs - firstTs);

    for (const node of simNodes) {
      if (node.x == null) continue;
      const x = spX(node), y = spY(node);
      const r = nodeRadius(node);
      const color = phaseColor(node.phase);

      // Opacity based on recency
      const age = (lastTs - node.endTs) / range;
      const alpha = Math.max(0.55, 1 - age * 0.4);

      // --- Progress ring ---
      if (node.progress) {
        const ringColor = PROGRESS_COLORS[node.progress];
        const ringR = r + 3;
        ctx.save();

        if (node.progress === "stuck") {
          // Pulsing red ring
          const pulse = 0.4 + 0.4 * Math.sin(now / 500);
          ctx.globalAlpha = pulse * alpha;
          ctx.strokeStyle = ringColor;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.stroke();
          // Glow
          ctx.globalAlpha = pulse * alpha * 0.3;
          ctx.beginPath();
          ctx.arc(x, y, ringR + 4, 0, Math.PI * 2);
          ctx.stroke();
        } else if (node.progress === "drifting") {
          // Dashed yellow ring
          ctx.globalAlpha = 0.7 * alpha;
          ctx.strokeStyle = ringColor;
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.stroke();
        } else if (node.progress === "breakthrough") {
          // Glowing blue ring
          ctx.globalAlpha = 0.8 * alpha;
          ctx.strokeStyle = ringColor;
          ctx.lineWidth = 2.5;
          ctx.shadowColor = ringColor;
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.stroke();
        } else if (node.progress === "approaching") {
          // Solid green ring
          ctx.globalAlpha = 0.6 * alpha;
          ctx.strokeStyle = ringColor;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.restore();
      }

      // --- Node fill ---
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      // Soft halo
      if (dark) {
        const grad = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 1.8);
        grad.addColorStop(0, color);
        grad.addColorStop(1, "transparent");
        ctx.globalAlpha = 0.1 * alpha;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // --- Sequence number label ---
      ctx.save();
      ctx.globalAlpha = Math.max(0.9, alpha);
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${Math.max(9, r * 0.85)}px "SF Mono", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(node.sequenceNum), x, y + 0.5);
      ctx.restore();

      // --- Hover highlight ---
      if (hoveredNode && hoveredNode.id === node.id) {
        ctx.save();
        ctx.strokeStyle = dark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.5)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r + 1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function drawRoundedRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawEmptyState() {
    ctx.save();
    ctx.font = '11px "SF Mono", monospace';
    ctx.fillStyle = isDark() ? "#52525b" : "#a1a1aa";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("waiting for activity...", width / 2, height / 2);
    ctx.restore();
  }

  // =====================
  // INTERACTIONS
  // =====================

  function initInteraction() {
    tooltipEl = document.getElementById("momentum-tooltip");

    canvas.addEventListener("mousemove", (e) => {
      if (draggingNode) {
        dragMoved = true;
        const [wx, wy] = screenToWorld(e);
        draggingNode.x = spreadCX + (wx - spreadCX) / edgeLengthScale;
        draggingNode.y = spreadCY + (wy - spreadCY) / edgeLengthScale;
        draggingNode.fx = draggingNode.x;
        draggingNode.fy = draggingNode.y;
        hideTooltip();
        return;
      }
      if (draggingCluster) {
        dragMoved = true;
        const [wx, wy] = screenToWorld(e);
        const dx = (wx - draggingCluster.startWX) / edgeLengthScale;
        const dy = (wy - draggingCluster.startWY) / edgeLengthScale;
        for (const ns of draggingCluster.nodeStarts) {
          ns.node.x = ns.x + dx;
          ns.node.y = ns.y + dy;
          ns.node.fx = ns.node.x;
          ns.node.fy = ns.node.y;
        }
        hideTooltip();
        return;
      }
      if (isDragging) {
        dragMoved = true;
        camX = dragCamX - (e.clientX - dragStartX) / camZoom;
        camY = dragCamY - (e.clientY - dragStartY) / camZoom;
        return;
      }
      const [wx, wy] = screenToWorld(e);
      const node = hitTestNode(wx, wy);
      if (node !== hoveredNode) {
        hoveredNode = node;
        if (node) {
          canvas.style.cursor = "pointer";
          showTooltip(node, e.clientX, e.clientY);
        } else {
          const cluster = hitTestCluster(wx, wy);
          canvas.style.cursor = cluster ? "move" : "grab";
          hideTooltip();
        }
      } else if (node && tooltipEl) {
        positionTooltip(e.clientX, e.clientY);
      } else if (!node) {
        const cluster = hitTestCluster(wx, wy);
        canvas.style.cursor = cluster ? "move" : "grab";
      }
    });

    canvas.addEventListener("mousedown", (e) => {
      const [wx, wy] = screenToWorld(e);
      if (hoveredNode) {
        // Start dragging node
        draggingNode = hoveredNode;
        draggingNode.fx = draggingNode.x;
        draggingNode.fy = draggingNode.y;
        canvas.style.cursor = "grabbing";
        hideTooltip();
      } else {
        const cluster = hitTestCluster(wx, wy);
        if (cluster) {
          // Start dragging cluster — move all nodes with this cluster key
          const nodeStarts = [];
          for (const n of simNodes) {
            if (clusterKey(n) === cluster && n.x != null) {
              nodeStarts.push({ node: n, x: n.x, y: n.y });
            }
          }
          draggingCluster = { phase: cluster, startWX: wx, startWY: wy, nodeStarts };
          canvas.style.cursor = "grabbing";
          hideTooltip();
        } else {
          isDragging = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          dragCamX = camX;
          dragCamY = camY;
          canvas.style.cursor = "grabbing";
        }
      }
    });

    canvas.addEventListener("mouseup", () => {
      if (dragMoved) {
        wasDragging = true;
        setTimeout(() => { wasDragging = false; }, 50);
      }
      dragMoved = false;
      if (draggingNode) draggingNode = null;
      if (draggingCluster) draggingCluster = null;
      isDragging = false;
      canvas.style.cursor = hoveredNode ? "pointer" : "grab";
    });

    canvas.addEventListener("mouseleave", () => {
      isDragging = false;
      hoveredNode = null;
      canvas.style.cursor = "default";
      hideTooltip();
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      camZoom = Math.min(4, Math.max(0.2, camZoom * factor));
    }, { passive: false });

    canvas.addEventListener("click", (e) => {
      if (wasDragging) return;
      if (hoveredNode && hoveredNode.entryId != null && onClickSpan) {
        onClickSpan(hoveredNode.entryId);
      }
    });
  }

  function screenToWorld(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wx = sx / camZoom + camX;
    const wy = sy / camZoom + camY;
    return [wx, wy];
  }

  function hitTestCluster(wx, wy) {
    for (const [key, r] of clusterRects) {
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return key;
    }
    return null;
  }

  function hitTestNode(wx, wy) {
    // Reverse order so topmost (last drawn) is hit first
    for (let i = simNodes.length - 1; i >= 0; i--) {
      const n = simNodes[i];
      if (n.x == null) continue;
      const r = nodeRadius(n);
      const dx = wx - spX(n);
      const dy = wy - spY(n);
      if (dx * dx + dy * dy <= (r + 4) * (r + 4)) return n;
    }
    return null;
  }

  function showTooltip(span, clientX, clientY) {
    if (!tooltipEl) return;

    const duration = ((span.endTs - span.startTs) / 1000).toFixed(1);
    const files = [...span.files].slice(0, 3).map(f => {
      const parts = f.split("/");
      return parts[parts.length - 1];
    });
    const moreFiles = span.files.size > 3 ? ` +${span.files.size - 3}` : "";

    let reads = 0, edits = 0, execs = 0;
    for (const a of span.actions) {
      if (a.action === "read") reads++;
      else if (a.action === "edit") edits++;
      else if (a.action === "exec") execs++;
    }

    let maxPattern = "", maxScore = 0;
    for (const [k, v] of Object.entries(span.patterns)) {
      if (v > maxScore) { maxScore = v; maxPattern = k; }
    }

    const phaseLabel = span.phase.charAt(0).toUpperCase() + span.phase.slice(1);
    const progressLabel = span.progress ? (span.progress.charAt(0).toUpperCase() + span.progress.slice(1)) : "";
    const progressColor = span.progress ? PROGRESS_COLORS[span.progress] : "";

    let html = `<div class="momentum-tip-header">
      <span class="momentum-tip-state" style="color:${phaseColor(span.phase)}">#${span.sequenceNum} ${phaseLabel}</span>
      <span class="momentum-tip-duration">${duration}s</span>
    </div>`;

    if (progressLabel) {
      html += `<div class="momentum-tip-progress" style="color:${progressColor}">${progressLabel}</div>`;
    }

    if (span.actions.length > 0) {
      const actionStr = [reads && `${reads}r`, edits && `${edits}e`, execs && `${execs}x`].filter(Boolean).join(" ");
      html += `<div class="momentum-tip-actions">${actionStr}</div>`;
    }

    if (files.length > 0) {
      html += `<div class="momentum-tip-files">${files.join(", ")}${moreFiles}</div>`;
    }

    if (maxScore > 0.1) {
      html += `<div class="momentum-tip-pattern">${maxPattern}: ${(maxScore * 100).toFixed(0)}%</div>`;
    }

    if (span.causalTrigger) {
      const triggerType = span.causalTrigger.type.replace("_", " ");
      html += `<div class="momentum-tip-trigger">trigger: ${triggerType}</div>`;
    }

    tooltipEl.innerHTML = html;
    tooltipEl.style.display = "block";
    positionTooltip(clientX, clientY);
  }

  function positionTooltip(clientX, clientY) {
    if (!tooltipEl) return;
    const containerRect = canvas.parentElement.getBoundingClientRect();
    let tx = clientX - containerRect.left + 12;
    let ty = clientY - containerRect.top - 10;
    const tipRect = tooltipEl.getBoundingClientRect();
    if (tx + tipRect.width > containerRect.width) tx = clientX - containerRect.left - tipRect.width - 12;
    if (ty < 0) ty = 4;
    tooltipEl.style.left = tx + "px";
    tooltipEl.style.top = ty + "px";
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }

  // =====================
  // PUBLIC API
  // =====================

  function init(el) {
    canvas = el;
    ctx = canvas.getContext("2d");
    initInteraction();
    resizeCanvas();
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => resizeCanvas()).observe(canvas.parentElement);
    }
    animFrame = requestAnimationFrame(render);
  }

  function addEntry(entry) {
    processEntry(entry);
  }

  function addEntries(list) {
    for (const e of list) processEntry(e);
    rebuildSimulation();
  }

  function reset() {
    sessionState.clear();
    filePhaseMap.clear();
    sessionSeqCounters.clear();
    simNodes = [];
    simLinks = [];
    spanIdCounter = 0;
    sequenceCounter = 0;
    hoveredNode = null;
    if (simulation) simulation.stop();
    simulation = null;
    hideTooltip();
  }

  function registerSession(id, label, color) {
    sessionColors.set(id, color);
    sessionLabels.set(id, label);
  }

  function unregisterSession(id) {
    sessionColors.delete(id);
    sessionLabels.delete(id);
    sessionState.delete(id);
    scheduleRebuild();
  }

  function setSessionFilter(id) {
    sessionFilter = id;
    rebuildSimulation();
  }

  function setOnSessionFilterChange(cb) { onSessionFilterChange = cb; }
  function setOnClickSpan(cb) { onClickSpan = cb; }

  function setEdgeLengthScale(v) {
    edgeLengthScale = Math.max(0.2, Math.min(3, v));
  }

  // Gravity augmentation API
  function getFileState(filePath) {
    return filePhaseMap.get(filePath) || null;
  }

  function destroy() {
    if (animFrame) cancelAnimationFrame(animFrame);
    if (simulation) simulation.stop();
    animFrame = null;
    simulation = null;
    canvas = null;
    ctx = null;
  }

  return {
    init,
    addEntry,
    addEntries,
    reset,
    registerSession,
    unregisterSession,
    setSessionFilter,
    setOnSessionFilterChange,
    setOnClickSpan,
    setEdgeLengthScale,
    getFileState,
    destroy,
  };
})();
