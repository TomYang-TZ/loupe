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
  let sessionFilters = new Set(["all"]); // multi-select like gravity
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
  // Monochrome palette — phase distinguished by position/label only
  const MONO = {
    // Dark mode: warm white spectrum
    dark: {
      stroke: [226, 232, 240],     // slate node strokes
      label: [255, 248, 240],      // warm white labels
      edge: [255, 248, 240],       // warm white edges
      fill: [226, 232, 240],       // near-empty node fill
      phaseLbl: [255, 248, 240],   // phase label text
      hullStroke: [148, 163, 184], // session hull
    },
    // Light mode: pure black
    light: {
      stroke: [0, 0, 0],
      label: [0, 0, 0],
      edge: [0, 0, 0],
      fill: [0, 0, 0],
      phaseLbl: [0, 0, 0],
      hullStroke: [0, 0, 0],
    },
  };

  // Progress rings — the ONLY color on the map
  const PROGRESS_COLORS = {
    approaching:  "#06b6d4",
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

  // --- Tool Classification (delegated to LoupeUtils — shared with gravity.js) ---
  const TOOL_ACTIONS = LoupeUtils.TOOL_ACTIONS;
  const BASH_CMD_CATEGORY = LoupeUtils.BASH_CMD_CATEGORY;
  const extractBashSubcommand = LoupeUtils.extractBashSubcommand;
  const extractToolName = LoupeUtils.extractToolName;
  const extractFilePath = LoupeUtils.extractFilePath;
  const extractBashCommand = LoupeUtils.extractBashCommand;
  const classifyAction = LoupeUtils.classifyAction;

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

    const bashCmd = toolName === "Bash" ? (extractBashCommand(entry) || "") : "";
    span.actions.push({ toolName, filePath, action, ts: entry.ts || Date.now(), isError, bashCmd });
    if (filePath) span.files.add(filePath);
    span.endTs = entry.ts || Date.now();

    // Track bash commands for test detection
    if (bashCmd) span.bashCommands.push(bashCmd);

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

    // Update behavioral signature and risk prediction
    updateSignature(span.sessionId, span);

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
  // Mirrors detectPhaseFromTool from shared/tool-detail.js — per-tool classification
  // with span-level error/debugging detection on top.
  // =====================

  function detectPhaseFromTool(toolName, command, currentPhase) {
    if (!toolName) return null;
    if (["Read", "Glob", "Grep", "LSP"].some(t => toolName.includes(t))) return "exploring";
    if (["TodoWrite", "TaskCreate", "TaskUpdate", "EnterPlanMode"].some(t => toolName.includes(t))) return "planning";
    if (["Edit", "Write", "NotebookEdit"].some(t => toolName.includes(t))) return "implementing";
    if (toolName.includes("Bash")) {
      if (/test|jest|pytest|cargo test|npm test/.test(command || "")) return "testing";
      if (currentPhase === "idle" || currentPhase === "starting") return "implementing";
      return null;
    }
    if (toolName.includes("Agent")) return "orchestrating";
    return null;
  }

  function classifyPhase(state, span) {
    // Debugging: error in span OR revisiting errored files (span-level, not per-tool)
    if (span.hasError) return "debugging";
    if (state.erroredFiles.size > 0 && span.files.size > 0) {
      let revisiting = 0;
      for (const f of span.files) {
        if (state.erroredFiles.has(f)) revisiting++;
      }
      if (revisiting > 0 && revisiting / span.files.size > 0.3) return "debugging";
    }

    // Use per-tool classification (same as shared/tool-detail.js detectPhaseFromTool)
    // Last tool wins — matches island/TUI behavior
    let phase = null;
    for (const a of span.actions) {
      const p = detectPhaseFromTool(a.toolName, a.bashCmd || "", phase || "exploring");
      if (p) phase = p;
    }
    if (phase) return phase;

    // No tool actions — thinking-only span
    if (span.thinkingText.length > 500) return "planning";
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
    return Math.min(1, repeats / (recent.length - 2));
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
  // BEHAVIORAL SIGNATURES & RISK PREDICTION
  // =====================

  // Per-session behavioral signature: computed incrementally as spans arrive
  const sessionSignatures = new Map(); // sessionId -> BehavioralSignature

  const PHASES = ["exploring", "implementing", "testing", "debugging", "planning", "orchestrating"];
  const ARCHETYPES = {
    "focused-executor":  { desc: "Direct path, minimal loops, high edit ratio", color: "#06b6d4" },
    "explorer-debugger": { desc: "Wide search, frequent debugging, many reads", color: "#eab308" },
    "loop-fighter":      { desc: "High looping, repeated patterns, slow progress", color: "#ef4444" },
    "methodical-planner":{ desc: "Heavy planning, structured phases, low backtracking", color: "#8b5cf6" },
    "rapid-iterater":    { desc: "Fast cycles, test-heavy, quick pivots", color: "#22c55e" },
    "deep-diver":        { desc: "Long exploring spans, narrow file focus, thorough", color: "#3b82f6" },
  };

  function getSignature(sessionId) {
    if (!sessionSignatures.has(sessionId)) {
      sessionSignatures.set(sessionId, {
        // Phase distribution (normalized)
        phaseDist: { exploring: 0, implementing: 0, testing: 0, debugging: 0, planning: 0, orchestrating: 0 },
        // Transition matrix: phase[i] -> phase[j] counts
        transitions: {},
        // Peak pattern scores across session
        patternPeaks: { looping: 0, narrowing: 0, backtracking: 0, explosion: 0, breakthrough: 0, goalDrift: 0 },
        // Aggregate stats
        totalSpans: 0,
        totalDuration: 0,
        errorCount: 0,
        uniqueFiles: new Set(),
        actionEntropy: 0,
        // Risk prediction state
        riskHistory: [],       // last N risk scores
        riskScore: 0,          // current P(trouble) 0-1
        riskTrend: "neutral",  // "rising", "falling", "neutral"
        // Archetype
        archetype: null,
        archetypeConfidence: 0,
      });
    }
    return sessionSignatures.get(sessionId);
  }

  function updateSignature(sessionId, span) {
    const sig = getSignature(sessionId);
    const state = getSessionState(sessionId);
    const spans = state.spans;

    sig.totalSpans = spans.length;
    sig.totalDuration += Math.max(0, span.endTs - span.startTs);

    // Phase distribution
    sig.phaseDist[span.phase] = (sig.phaseDist[span.phase] || 0) + 1;

    // Transition matrix
    if (spans.length >= 2) {
      const prev = spans[spans.length - 2];
      const key = `${prev.phase}->${span.phase}`;
      sig.transitions[key] = (sig.transitions[key] || 0) + 1;
    }

    // Pattern peaks
    for (const [k, v] of Object.entries(span.patterns)) {
      if (v > (sig.patternPeaks[k] || 0)) sig.patternPeaks[k] = v;
    }

    // Error tracking
    if (span.hasError) sig.errorCount++;

    // File diversity
    for (const f of span.files) sig.uniqueFiles.add(f);

    // Action entropy (diversity of action types)
    const actionCounts = { read: 0, edit: 0, exec: 0 };
    for (const a of span.actions) actionCounts[a.action] = (actionCounts[a.action] || 0) + 1;
    const total = span.actions.length || 1;
    let entropy = 0;
    for (const c of Object.values(actionCounts)) {
      if (c > 0) { const p = c / total; entropy -= p * Math.log2(p); }
    }
    // Rolling average entropy
    sig.actionEntropy = sig.actionEntropy * 0.8 + entropy * 0.2;

    // Risk prediction
    updateRiskScore(sig, span, spans);

    // Archetype classification (every 5 spans)
    if (sig.totalSpans % 5 === 0 || sig.totalSpans <= 3) {
      classifyArchetype(sig);
    }
  }

  function updateRiskScore(sig, span, spans) {
    // Feature vector for current state
    const features = computeRiskFeatures(span, spans);

    // Lightweight logistic-style risk scoring (no training needed — heuristic weights)
    let score = 0;

    // Looping acceleration: are loops getting worse?
    score += features.loopingTrend * 0.35;
    // Backtracking in debug is a strong stuck predictor
    score += features.debugBacktrack * 0.25;
    // File churn without progress
    score += features.fileChurn * 0.15;
    // Action repetition (same tool+file pairs)
    score += features.actionRepetition * 0.2;
    // Error rate acceleration
    score += features.errorAccel * 0.2;
    // Goal drift compound
    score += features.driftCompound * 0.15;
    // Long span without resolution (thinking too long)
    score += features.stallSignal * 0.1;
    // Subtract positive signals
    score -= features.narrowingSignal * 0.2;
    score -= features.freshFiles * 0.1;

    score = Math.max(0, Math.min(1, score));

    // Smooth with exponential moving average
    sig.riskScore = sig.riskScore * 0.6 + score * 0.4;

    // Track trend
    sig.riskHistory.push(sig.riskScore);
    if (sig.riskHistory.length > 20) sig.riskHistory.shift();

    if (sig.riskHistory.length >= 3) {
      const recent = sig.riskHistory.slice(-3);
      const older = sig.riskHistory.slice(-6, -3);
      if (older.length > 0) {
        const recentAvg = recent.reduce((a, b) => a + b) / recent.length;
        const olderAvg = older.reduce((a, b) => a + b) / older.length;
        const delta = recentAvg - olderAvg;
        sig.riskTrend = delta > 0.05 ? "rising" : delta < -0.05 ? "falling" : "neutral";
      }
    }
  }

  function computeRiskFeatures(span, spans) {
    const window = spans.slice(-WINDOW_SIZE);
    const features = {
      loopingTrend: 0,
      debugBacktrack: 0,
      fileChurn: 0,
      actionRepetition: 0,
      errorAccel: 0,
      driftCompound: 0,
      stallSignal: 0,
      narrowingSignal: 0,
      freshFiles: 0,
    };

    // Looping trend: is looping score increasing over recent spans?
    if (window.length >= 3) {
      const loopScores = window.map(s => s.patterns.looping);
      const firstHalf = loopScores.slice(0, Math.floor(loopScores.length / 2));
      const secondHalf = loopScores.slice(Math.floor(loopScores.length / 2));
      const avg1 = firstHalf.reduce((a, b) => a + b, 0) / (firstHalf.length || 1);
      const avg2 = secondHalf.reduce((a, b) => a + b, 0) / (secondHalf.length || 1);
      features.loopingTrend = Math.max(0, (avg2 - avg1) + avg2 * 0.5);
    }

    // Debug + backtracking compound
    if (span.phase === "debugging" && span.patterns.backtracking > 0.3) {
      features.debugBacktrack = span.patterns.backtracking * 0.8;
      const recentDebug = window.filter(s => s.phase === "debugging").length;
      features.debugBacktrack *= Math.min(1, recentDebug / 3);
    }

    // File churn: lots of files touched but no narrowing
    if (window.length >= 3) {
      const allFiles = new Set();
      for (const s of window) for (const f of s.files) allFiles.add(f);
      features.fileChurn = Math.min(1, allFiles.size / 20) * (1 - (span.patterns.narrowing || 0));
    }

    // Action repetition
    features.actionRepetition = span.patterns.looping;

    // Error acceleration
    const recentErrors = window.filter(s => s.hasError).length;
    features.errorAccel = Math.min(1, recentErrors / (window.length || 1));

    // Goal drift compounding over time
    if (window.length >= 3) {
      const drifts = window.map(s => s.patterns.goalDrift || 0);
      features.driftCompound = Math.min(1, drifts.reduce((a, b) => a + b, 0) / drifts.length * 2);
    }

    // Stall signal: very long span with few actions
    const spanDur = (span.endTs - span.startTs) / 1000;
    if (spanDur > 30 && span.actions.length <= 1) {
      features.stallSignal = Math.min(1, spanDur / 120);
    }

    // Positive signals
    features.narrowingSignal = span.patterns.narrowing || 0;
    features.freshFiles = span.patterns.explosion > 0.3 && span.patterns.narrowing < 0.2 ? 0 : (span.patterns.explosion || 0) * 0.5;

    return features;
  }

  function classifyArchetype(sig) {
    if (sig.totalSpans < 3) { sig.archetype = null; return; }

    const total = sig.totalSpans;
    const norm = {};
    for (const p of PHASES) norm[p] = (sig.phaseDist[p] || 0) / total;

    // Score each archetype based on features
    const scores = {};

    // focused-executor: high implementing, low looping, low debugging
    scores["focused-executor"] = norm.implementing * 2 + (1 - sig.patternPeaks.looping) * 1.5
      + (1 - norm.debugging) * 0.8 - sig.patternPeaks.backtracking;

    // explorer-debugger: high exploring + debugging, many unique files
    scores["explorer-debugger"] = norm.exploring * 1.5 + norm.debugging * 1.5
      + Math.min(1, sig.uniqueFiles.size / 15) * 0.8;

    // loop-fighter: high looping peaks, high stuck count
    scores["loop-fighter"] = sig.patternPeaks.looping * 2.5 + sig.patternPeaks.backtracking * 1.5
      + norm.debugging * 0.8;

    // methodical-planner: high planning, low backtracking
    scores["methodical-planner"] = norm.planning * 3 + (1 - sig.patternPeaks.backtracking) * 1
      + (1 - sig.patternPeaks.looping) * 0.5;

    // rapid-iterater: high testing, quick phase transitions
    const transCount = Object.values(sig.transitions).reduce((a, b) => a + b, 0);
    scores["rapid-iterater"] = norm.testing * 2.5 + Math.min(1, transCount / total) * 1.5
      + sig.actionEntropy * 0.8;

    // deep-diver: long exploring, narrow focus, few unique files relative to spans
    const fileDensity = sig.uniqueFiles.size / Math.max(1, total);
    scores["deep-diver"] = norm.exploring * 2 + (1 - Math.min(1, fileDensity)) * 1.5
      + sig.patternPeaks.narrowing * 1;

    // Pick the highest scoring archetype
    let best = null, bestScore = -Infinity;
    for (const [name, score] of Object.entries(scores)) {
      if (score > bestScore) { bestScore = score; best = name; }
    }

    // Confidence: gap between top and second
    const sorted = Object.values(scores).sort((a, b) => b - a);
    const gap = sorted.length >= 2 ? (sorted[0] - sorted[1]) / (Math.abs(sorted[0]) + 0.01) : 0;
    sig.archetype = best;
    sig.archetypeConfidence = Math.min(1, gap);
  }

  // Compute the fixed-length session vector for clustering/archetype library
  function computeSessionVector(sessionId) {
    const sig = getSignature(sessionId);
    const state = getSessionState(sessionId);
    if (!state || state.spans.length < 2) return null;

    const total = sig.totalSpans;
    const phaseDist = PHASES.map(p => (sig.phaseDist[p] || 0) / total);

    // Flatten transition matrix into 5x5 = 25 values (normalized)
    const transTotal = Object.values(sig.transitions).reduce((a, b) => a + b, 0) || 1;
    const transMatrix = [];
    for (const from of PHASES) {
      for (const to of PHASES) {
        transMatrix.push((sig.transitions[`${from}->${to}`] || 0) / transTotal);
      }
    }

    const patternPeaks = ["looping", "narrowing", "backtracking", "explosion", "breakthrough", "goalDrift"]
      .map(k => sig.patternPeaks[k] || 0);

    return {
      phaseDist,       // [5]
      transMatrix,     // [25]
      patternPeaks,    // [6]
      totalSpans: total,
      totalDuration: sig.totalDuration,
      errorRate: sig.errorCount / total,
      fileDiversity: sig.uniqueFiles.size,
      actionEntropy: sig.actionEntropy,
      archetype: sig.archetype,
      archetypeConfidence: sig.archetypeConfidence,
      riskScore: sig.riskScore,
    };
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
      if (!sessionFilters.has("all") && !sessionFilters.has(sid)) continue;
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
      if (!sessionFilters.has("all") && !sessionFilters.has(sid)) continue;
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

  function mono() { return isDark() ? MONO.dark : MONO.light; }

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

    const rect = canvas.parentElement.getBoundingClientRect();
    if (Math.round(rect.width) !== Math.round(width) || Math.round(rect.height) !== Math.round(height)) resizeCanvas();
    ctx.clearRect(0, 0, width, height);

    const dark = isDark();

    // Background
    if (dark) {
      const bgGrad = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
      bgGrad.addColorStop(0, "#0e1118");
      bgGrad.addColorStop(1, "#06080a");
      ctx.fillStyle = bgGrad;
    } else {
      ctx.fillStyle = "#fafafa";
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

    // Draw session convex hulls
    drawSessionHulls(dark);

    // Draw floating phase labels
    drawClusterLabels(dark);

    // Draw edges
    drawEdges(dark);

    // Draw nodes
    drawNodes(dark, now);

    ctx.restore();

    // Minimap (screen space)
    drawMinimap(dark);

    // Risk meter + archetype badge (screen space, top-right)
    drawRiskMeter(dark, now);
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

    // Draw nodes as monochrome dots
    const m = mono();
    const firstTs = simNodes.length > 0 ? simNodes[0].startTs : 0;
    const lastTs = simNodes.length > 0 ? simNodes[simNodes.length - 1].endTs : 1;
    const mmRange = Math.max(1, lastTs - firstTs);
    for (const n of simNodes) {
      if (n.x == null) continue;
      const nx = spX(n), ny = spY(n);
      const dx = mx + (nx - minX) * scale;
      const dy = my + (ny - minY) * scale;
      const age = (lastTs - n.endTs) / mmRange;
      ctx.fillStyle = `rgba(${m.stroke},${0.4 + (1 - age) * 0.5})`;
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

  function drawRiskMeter(dark, now) {
    // Find the active session(s) to show risk for
    const activeSessions = [];
    for (const [sid, state] of sessionState) {
      if (!sessionFilters.has("all") && !sessionFilters.has(sid)) continue;
      if (state.spans.length >= 3) activeSessions.push(sid);
    }
    if (activeSessions.length === 0) return;

    // Aggregate risk from visible sessions (use max)
    let maxRisk = 0, maxTrend = "neutral", bestArchetype = null, bestConf = 0;
    for (const sid of activeSessions) {
      const sig = sessionSignatures.get(sid);
      if (!sig) continue;
      if (sig.riskScore > maxRisk) {
        maxRisk = sig.riskScore;
        maxTrend = sig.riskTrend;
      }
      if (sig.archetype && sig.archetypeConfidence > bestConf) {
        bestArchetype = sig.archetype;
        bestConf = sig.archetypeConfidence;
      }
    }

    const m = mono();
    const mx = width - 8;
    const my = 8;

    // --- Risk arc meter ---
    const arcR = 22 * mapScale;
    const arcCx = mx - arcR - 4;
    const arcCy = my + arcR + 4;
    const arcStart = Math.PI * 0.75;
    const arcEnd = Math.PI * 2.25;
    const arcRange = arcEnd - arcStart;

    // Background arc
    ctx.save();
    ctx.beginPath();
    ctx.arc(arcCx, arcCy, arcR, arcStart, arcEnd);
    ctx.strokeStyle = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)";
    ctx.lineWidth = 4 * mapScale;
    ctx.lineCap = "round";
    ctx.stroke();

    // Risk gradient arc
    const riskAngle = arcStart + arcRange * maxRisk;
    if (maxRisk > 0.02) {
      // Color interpolation: cyan(0) -> amber(0.5) -> red(1)
      let r, g, b;
      if (maxRisk < 0.4) {
        const t = maxRisk / 0.4;
        r = Math.round(6 + t * (234 - 6));
        g = Math.round(182 + t * (179 - 182));
        b = Math.round(212 + t * (8 - 212));
      } else {
        const t = (maxRisk - 0.4) / 0.6;
        r = Math.round(234 + t * (239 - 234));
        g = Math.round(179 - t * 179);
        b = Math.round(8 - t * 8);
      }

      // Pulsing for high risk
      let alpha = 0.7 + maxRisk * 0.3;
      if (maxRisk > 0.6) {
        const pulse = 0.7 + 0.3 * Math.sin(now / (400 - maxRisk * 200));
        alpha *= pulse;
      }

      ctx.beginPath();
      ctx.arc(arcCx, arcCy, arcR, arcStart, riskAngle);
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.lineWidth = 4 * mapScale;
      ctx.lineCap = "round";
      ctx.stroke();

      // Glow for high risk
      if (maxRisk > 0.5) {
        ctx.beginPath();
        ctx.arc(arcCx, arcCy, arcR, arcStart, riskAngle);
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * 0.3})`;
        ctx.lineWidth = 8 * mapScale;
        ctx.stroke();
      }
    }

    // Risk score text in center of arc
    const riskPct = Math.round(maxRisk * 100);
    ctx.fillStyle = dark ? `rgba(255,248,240,${0.5 + maxRisk * 0.4})` : `rgba(0,0,0,${0.4 + maxRisk * 0.4})`;
    ctx.font = `600 ${Math.round(11 * mapScale)}px "SF Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${riskPct}`, arcCx, arcCy - 1);

    // "risk" label below score
    ctx.fillStyle = dark ? "rgba(255,248,240,0.3)" : "rgba(0,0,0,0.2)";
    ctx.font = `400 ${Math.round(7 * mapScale)}px "SF Mono", monospace`;
    ctx.fillText("risk", arcCx, arcCy + 10 * mapScale);

    // Trend arrow
    if (maxTrend !== "neutral") {
      const arrowX = arcCx + arcR + 6;
      const arrowY = arcCy - 4;
      ctx.fillStyle = maxTrend === "rising" ? "rgba(239,68,68,0.6)" : "rgba(6,182,212,0.6)";
      ctx.font = `${Math.round(10 * mapScale)}px "SF Mono", monospace`;
      ctx.textAlign = "left";
      ctx.fillText(maxTrend === "rising" ? "\u2191" : "\u2193", arrowX, arrowY);
    }

    ctx.restore();

    // --- Archetype badge ---
    if (bestArchetype) {
      const badgeY = arcCy + arcR + 10 * mapScale;
      const label = bestArchetype.replace(/-/g, " ");
      const info = ARCHETYPES[bestArchetype];

      ctx.save();
      ctx.fillStyle = dark ? "rgba(255,248,240,0.35)" : "rgba(0,0,0,0.25)";
      ctx.font = `500 ${Math.round(8 * mapScale)}px "SF Mono", monospace`;
      ctx.textAlign = "right";
      ctx.fillText(label, mx - 4, badgeY);

      // Small colored dot for archetype
      if (info) {
        const textW = ctx.measureText(label).width;
        ctx.beginPath();
        ctx.arc(mx - 4 - textW - 6, badgeY - 3, 2.5 * mapScale, 0, Math.PI * 2);
        ctx.fillStyle = info.color + "80";
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawSessionHulls(dark) {
    const sessionGroups = new Map();
    for (const n of simNodes) {
      if (n.x == null) continue;
      if (!sessionGroups.has(n.sessionId)) sessionGroups.set(n.sessionId, []);
      sessionGroups.get(n.sessionId).push(n);
    }
    if (sessionGroups.size < 2) return;

    const m = mono();

    // Convex hull (Andrew's monotone chain)
    function convexHull(points) {
      points = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
      if (points.length <= 1) return points;
      const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
      const lower = [];
      for (const p of points) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
      const upper = [];
      for (let i = points.length - 1; i >= 0; i--) { const p = points[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
      return lower.slice(0, -1).concat(upper.slice(0, -1));
    }

    for (const [sid, nodes] of sessionGroups) {
      if (nodes.length < 1) continue;

      // Session label above topmost node
      let topY = Infinity, sumX = 0;
      for (const n of nodes) { topY = Math.min(topY, spY(n) - nodeRadius(n)); sumX += spX(n); }
      const label = sessionLabels.get(sid) || sid.slice(0, 8);
      ctx.save();
      ctx.globalAlpha = dark ? 0.2 : 0.25;
      ctx.fillStyle = `rgba(${m.phaseLbl},1)`;
      ctx.font = `400 ${Math.round(9 * mapScale)}px "SF Mono", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(label, sumX / nodes.length, topY - 10 * mapScale);
      ctx.restore();
    }
  }

  function drawClusterLabels(dark) {
    const m = mono();
    // Group nodes by cluster to find centroid and bottom edge for label placement
    const clusters = new Map();
    for (const n of simNodes) {
      if (n.x == null) continue;
      const r = nodeRadius(n);
      const k = clusterKey(n);
      if (!clusters.has(k)) {
        clusters.set(k, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, sumX: 0, count: 0, phase: n.phase, sessionId: n.sessionId });
      }
      const c = clusters.get(k);
      const nx = spX(n), ny = spY(n);
      c.minX = Math.min(c.minX, nx - r);
      c.minY = Math.min(c.minY, ny - r);
      c.maxX = Math.max(c.maxX, nx + r);
      c.maxY = Math.max(c.maxY, ny + r);
      c.sumX += nx;
      c.count++;
    }

    clusterRects.clear();
    for (const [key, bounds] of clusters) {
      if (bounds.count < 1) continue;
      const pad = 20 * mapScale;
      const x = bounds.minX - pad;
      const y = bounds.minY - pad;
      const w = bounds.maxX - bounds.minX + pad * 2;
      const h = bounds.maxY - bounds.minY + pad * 2;
      clusterRects.set(key, { x, y, w, h, phase: bounds.phase });

      // Subtle cluster background — sharp corners
      ctx.save();
      ctx.fillStyle = dark ? "rgba(255,255,255,0.06)" : `rgba(${m.fill},0.03)`;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = dark ? "rgba(255,255,255,0.1)" : `rgba(${m.stroke},0.05)`;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();

      // Phase label below cluster
      ctx.save();
      ctx.fillStyle = `rgba(${m.phaseLbl},${dark ? 0.55 : 0.45})`;
      ctx.font = `500 ${Math.round(10 * mapScale)}px "SF Mono", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(bounds.phase, bounds.sumX / bounds.count, y + h + 4 * mapScale);
      ctx.restore();
    }
  }

  function drawEdges(dark) {
    const m = mono();
    const firstTs = simNodes.length > 0 ? simNodes[0].startTs : 0;
    const lastTs = simNodes.length > 0 ? simNodes[simNodes.length - 1].endTs : 1;
    const range = Math.max(1, lastTs - firstTs);

    for (const link of simLinks) {
      const s = link.source;
      const t = link.target;
      if (s.x == null || t.x == null) continue;

      const sx1 = spX(s), sy1 = spY(s), sx2 = spX(t), sy2 = spY(t);
      const dx = sx2 - sx1, dy = sy2 - sy1;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;

      const sr = nodeRadius(s), tr = nodeRadius(t);
      if (dist - sr - tr <= 0) continue;

      // Shorten to node edges
      const x1 = sx1 + dx * (sr / dist), y1 = sy1 + dy * (sr / dist);
      const x2 = sx1 + dx * (1 - tr / dist), y2 = sy1 + dy * (1 - tr / dist);

      // Opacity based on avg recency
      const sAge = (lastTs - s.endTs) / range;
      const tAge = (lastTs - t.endTs) / range;
      const avgAge = (sAge + tAge) / 2;
      const edgeAlpha = dark ? 0.12 + (1 - avgAge) * 0.2 : 0.06 + (1 - avgAge) * 0.12;

      ctx.save();
      ctx.strokeStyle = `rgba(${m.edge},${edgeAlpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // Small arrowhead at target
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const aSize = 4;
      ctx.fillStyle = `rgba(${m.edge},${edgeAlpha})`;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - aSize * Math.cos(angle - 0.4), y2 - aSize * Math.sin(angle - 0.4));
      ctx.lineTo(x2 - aSize * Math.cos(angle + 0.4), y2 - aSize * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawNodes(dark, now) {
    const m = mono();
    const firstTs = simNodes.length > 0 ? simNodes[0].startTs : now;
    const lastTs = simNodes.length > 0 ? simNodes[simNodes.length - 1].endTs : now;
    const range = Math.max(1, lastTs - firstTs);

    for (const node of simNodes) {
      if (node.x == null) continue;
      const x = spX(node), y = spY(node);
      const r = nodeRadius(node);

      // Age 0 = newest, 1 = oldest (clamped to prevent runaway stroke width)
      const age = Math.max(0, Math.min(1, (lastTs - node.endTs) / range));

      // --- Progress ring (only color on the map) ---
      if (node.progress) {
        const ringColor = PROGRESS_COLORS[node.progress];
        const p = node.patterns;
        let intensity = 0.5;
        if (node.progress === "stuck") intensity = Math.max(p.looping, p.backtracking);
        else if (node.progress === "drifting") intensity = Math.max(p.goalDrift, p.explosion);
        else if (node.progress === "approaching") intensity = p.narrowing;
        else if (node.progress === "breakthrough") intensity = p.breakthrough;
        intensity = Math.max(0.3, Math.min(1, intensity));

        const lineW = 1 + intensity * 1.5;
        const ringAlpha = (0.3 + intensity * 0.5) * (0.6 + (1 - age) * 0.4);
        const ringR = r + 3 + intensity * 2;

        ctx.save();
        ctx.strokeStyle = ringColor;

        if (node.progress === "stuck") {
          const pulseSpeed = 300 + (1 - intensity) * 400;
          const pulse = 0.3 + 0.7 * Math.sin(now / pulseSpeed);
          ctx.globalAlpha = ringAlpha * pulse;
          ctx.lineWidth = lineW;
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.stroke();
        } else if (node.progress === "drifting") {
          ctx.globalAlpha = ringAlpha * 0.7;
          ctx.lineWidth = lineW;
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.stroke();
        } else if (node.progress === "breakthrough") {
          ctx.globalAlpha = ringAlpha;
          ctx.lineWidth = lineW;
          ctx.shadowColor = ringColor;
          ctx.shadowBlur = intensity * 10;
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.stroke();
        } else if (node.progress === "approaching") {
          ctx.globalAlpha = ringAlpha;
          ctx.lineWidth = lineW;
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.restore();
      }

      // --- Hollow wireframe node ---
      const strokeAlpha = dark ? 0.25 + (1 - age) * 0.45 : 0.1 + (1 - age) * 0.2;
      const strokeW = dark ? 0.75 + (1 - age) * 0.75 : 0.5 + (1 - age) * 0.5;
      const fillAlpha = dark ? 0.01 + (1 - age) * 0.03 : 0;

      // Near-empty fill
      ctx.save();
      ctx.fillStyle = `rgba(${m.fill},${fillAlpha})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      // Stroke
      ctx.strokeStyle = `rgba(${m.stroke},${strokeAlpha})`;
      ctx.lineWidth = strokeW;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // --- Sequence label ---
      const labelAlpha = dark ? 0.55 + (1 - age) * 0.4 : 0.4 + (1 - age) * 0.45;
      const seq = String(node.sequenceNum);
      ctx.save();
      ctx.fillStyle = `rgba(${m.label},${labelAlpha})`;
      ctx.font = `500 ${Math.max(8, r * 0.7)}px "SF Mono", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(seq, x, y + 0.5);
      ctx.restore();

      // --- Hover highlight ---
      if (hoveredNode && hoveredNode.id === node.id) {
        ctx.save();
        ctx.strokeStyle = dark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.4)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, r + 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
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
      <span class="momentum-tip-state">#${span.sequenceNum} ${phaseLabel}</span>
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
    sessionSignatures.clear();
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

  function setSessionFilter(filter) {
    if (filter instanceof Set) {
      // Multi-select from shared session filter bar
      sessionFilters = new Set(filter);
    } else {
      // Direct set from app tab sync — single session or "all"
      sessionFilters.clear();
      sessionFilters.add(filter);
    }
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
    // Behavioral signatures & risk prediction
    getSignature: (sid) => sessionSignatures.get(sid) || null,
    getSessionVector: computeSessionVector,
    getAllSignatures: () => new Map(sessionSignatures),
    getSessionSpans: (sid) => {
      const state = sessionState.get(sid);
      return state ? [...state.spans] : [];
    },
  };
})();
