"use strict";

// ===== Minimal Mode =====
const initialMinimal = new URLSearchParams(window.location.search).get("mode") === "minimal";
if (initialMinimal) document.body.classList.add("minimal");
function isMinimalMode() { return document.body.classList.contains("minimal"); }

// ===== Theme =====
(function initTheme() {
  const saved = localStorage.getItem("loupe-theme") || "dark";
  document.documentElement.dataset.theme = saved;
})();

// ===== Zoom =====
(function initZoom() {
  const saved = localStorage.getItem("loupe-zoom");
  if (saved) {
    document.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll(".log-scroll").forEach(el => { el.style.zoom = (parseFloat(saved) / 100).toString(); });
    });
  }
})();

// ===== State =====
const entries = [];
let lineCounter = 0;
// Multi-select filter: set of HIDDEN types (everything shown by default)
const hiddenTypes = new Set();
let activeSession = "all";
let searchQuery = "";
let autoScroll = true;
let selectedIdx = -1;
let firstEventTs = null;
let lastEventTime = 0;
const sessions = new Map();

// ===== Sub-agent Session Mapping =====
// When Agent tool fires, parent session spawns a sub-agent with its own session_id.
// Map child session_ids back to parent so they nest correctly.
const childSessionMap = new Map();   // childSessionId -> parentSessionId
const pendingAgentSpawns = new Map(); // parentSessionId -> { ts, count }

// ===== Task/Query Grouping State =====
const TASK_GAP_MS = 5 * 60 * 1000; // 5 minutes between queries = new task
let taskIdCounter = 0;
let queryIdCounter = 0;

// Per-session grouping state: sessionId -> GroupState
const sessionGroups = new Map();

function getGroupState(sessionId) {
  if (!sessionGroups.has(sessionId)) {
    sessionGroups.set(sessionId, {
      tasks: [],
      currentTask: null,
      currentQuery: null,
      agentStack: [],   // stack of { agentEntry, children: [], el: null, childrenEl: null }
    });
  }
  return sessionGroups.get(sessionId);
}

function assignToGroup(entry) {
  const sid = entry.sessionId || "default";
  const gs = getGroupState(sid);

  // user_query or thinking with userQuery = new query boundary
  // But skip if the current query already has the same userQuery (dedup)
  // Also skip if we're inside an agent stack — sub-agent thinking/queries
  // should nest as agent children, not create new top-level queries
  const insideAgent = gs.agentStack.length > 0;
  const isDuplicate = gs.currentQuery && entry.userQuery &&
    gs.currentQuery.userQuery === entry.userQuery;
  const isQueryBoundary = !insideAgent && !isDuplicate && (
    (entry.category === "user_query" && entry.userQuery) ||
    (entry.category === "thinking" && entry.userQuery)
  );
  if (isQueryBoundary) {
    // Close current agent stack (shouldn't happen, but defensive)
    gs.agentStack = [];

    // If current query is a preamble (no userQuery), absorb its items into the new query
    const preambleItems = (gs.currentQuery && !gs.currentQuery.userQuery) ? gs.currentQuery.items : null;
    if (preambleItems && gs.currentTask) {
      // Remove the preamble query from the task
      const idx = gs.currentTask.queries.indexOf(gs.currentQuery);
      if (idx !== -1) gs.currentTask.queries.splice(idx, 1);
      // If the task is now empty and this is the only task, reuse it
      if (gs.currentTask.queries.length === 0) {
        gs.currentTask.startTs = entry.ts;
      }
    }

    const prevEndTs = gs.currentQuery ? gs.currentQuery.endTs : 0;
    const gap = entry.ts - prevEndTs;

    // New task if first query or gap > 5 min
    if (!gs.currentTask || (gs.currentTask.queries.length === 0 && gs.tasks.length === 0) || gap > TASK_GAP_MS) {
      if (!gs.currentTask || gs.currentTask.queries.length > 0) {
        gs.currentTask = { id: ++taskIdCounter, seqNum: taskIdCounter, startTs: entry.ts, endTs: entry.ts, queries: [], el: null, bodyEl: null, headerEl: null };
        gs.tasks.push(gs.currentTask);
      }
    }

    // New query — include absorbed preamble items
    gs.currentQuery = { id: ++queryIdCounter, userQuery: entry.userQuery, thinkingEntry: entry.category === "thinking" ? entry : null, startTs: entry.ts, endTs: entry.ts, items: preambleItems || [], el: null, actionsEl: null, headerEl: null, collapsed: true };
    gs.currentTask.queries.push(gs.currentQuery);
    gs.currentTask.endTs = entry.ts;
    return;
  }

  // If thinking arrives after user_query already set the boundary, attach it as the thinkingEntry
  if (entry.category === "thinking" && entry.userQuery && gs.currentQuery && gs.currentQuery.userQuery === entry.userQuery) {
    gs.currentQuery.thinkingEntry = entry;
    // Don't return — let it fall through to be added as an item so the thinking text is accessible
  }

  // Ensure we have a current query (preamble)
  if (!gs.currentQuery) {
    if (!gs.currentTask) {
      gs.currentTask = { id: ++taskIdCounter, seqNum: taskIdCounter, startTs: entry.ts, endTs: entry.ts, queries: [], el: null, bodyEl: null, headerEl: null };
      gs.tasks.push(gs.currentTask);
    }
    gs.currentQuery = { id: ++queryIdCounter, userQuery: null, thinkingEntry: null, startTs: entry.ts, endTs: entry.ts, items: [], el: null, actionsEl: null, headerEl: null, collapsed: true };
    gs.currentTask.queries.push(gs.currentQuery);
  }

  // Sub-agent spawn: push onto stack
  if (entry.category === "sub_agent") {
    const ag = { agentEntry: entry, children: [], resultEntry: null, el: null, childrenEl: null };
    if (gs.agentStack.length > 0) {
      gs.agentStack[gs.agentStack.length - 1].children.push(ag);
    } else {
      gs.currentQuery.items.push(ag);
    }
    gs.agentStack.push(ag);
    gs.currentQuery.endTs = entry.ts;
    gs.currentTask.endTs = entry.ts;
    return;
  }

  // Sub-agent result: pop stack
  if (entry.category === "sub_agent_result") {
    if (gs.agentStack.length > 0) {
      const ag = gs.agentStack.pop();
      ag.resultEntry = entry;
    } else {
      // Orphan result, treat as regular item
      gs.currentQuery.items.push(entry);
    }
    gs.currentQuery.endTs = entry.ts;
    gs.currentTask.endTs = entry.ts;
    return;
  }

  // Regular entry: add to top-of-stack agent or current query
  if (gs.agentStack.length > 0) {
    gs.agentStack[gs.agentStack.length - 1].children.push(entry);
  } else {
    gs.currentQuery.items.push(entry);
  }
  gs.currentQuery.endTs = entry.ts;
  gs.currentTask.endTs = entry.ts;
}

// DOM
const paneContainer = document.getElementById("pane-container");
const scrollFab = document.getElementById("scroll-fab");
const searchInput = document.getElementById("search-input");
const searchCount = document.getElementById("search-count");
const lineCountEl = document.getElementById("line-count");
const connDot = document.getElementById("conn-dot");
const connStatus = document.getElementById("conn-status");
const tabBar = document.getElementById("tab-bar");
const filterTrigger = document.getElementById("filter-trigger");
const filterMenu = document.getElementById("filter-menu");
const filterDropdown = document.getElementById("filter-dropdown");
const scanline = document.getElementById("scanline");
const modalOverlay = document.getElementById("modal-overlay");
const modalPanel = document.getElementById("modal-panel");
const modalBadge = document.getElementById("modal-badge");
const modalTool = document.getElementById("modal-tool");
const modalTime = document.getElementById("modal-time");
const modalBody = document.getElementById("modal-body");
const modalClose = document.getElementById("modal-close");
const gridControls = document.getElementById("grid-controls");
const gridLabel = document.getElementById("grid-label");
const gridSep = document.getElementById("grid-sep");

// Pane management
const panes = new Map();
let mainContainer = null;
const MAP_SESSION_ID = "__gravity_map__";

const SESSION_COLORS = ["#8b5cf6", "#3b82f6", "#4ade80", "#f97316", "#ec4899", "#06b6d4", "#eab308", "#a78bfa"];
let colorIdx = 0;
function nextSessionColor() { return SESSION_COLORS[colorIdx++ % SESSION_COLORS.length]; }

function makeEmptyState() {
  const div = document.createElement("div");
  div.className = "empty-state";
  div.innerHTML = '<div class="empty-icon">loupe_</div><div class="empty-text">Waiting for events...</div><div class="empty-hint">Tool calls appear here as Claude works</div>';
  return div;
}

// ===== Activity indicators =====
let activityTimeout = null;

function signalActivity() {
  lastEventTime = Date.now();
  // Scanline
  scanline.classList.add("active");
  clearTimeout(activityTimeout);
  activityTimeout = setTimeout(() => scanline.classList.remove("active"), 3000);
  // Breathing speed
  connDot.classList.add("active");
  setTimeout(() => connDot.classList.remove("active"), 2000);
}

// ===== Panes =====
function formatInactive(ts) {
  if (!ts) return "";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 30) return "";
  if (sec < 60) return `${sec}s idle`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m idle`;
  return `${Math.floor(sec / 3600)}h idle`;
}

function createPane(sessionId, label, color) {
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.dataset.session = sessionId;

  const header = document.createElement("div");
  header.className = "pane-header";

  const dot = document.createElement("span");
  dot.className = "pane-session-dot";
  dot.style.background = color || "var(--accent)";
  header.appendChild(dot);

  const titleSpan = document.createElement("span");
  titleSpan.textContent = label;
  header.appendChild(titleSpan);

  const idleSpan = document.createElement("span");
  idleSpan.className = "pane-idle";
  header.appendChild(idleSpan);

  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  header.appendChild(spacer);

  if (sessionId !== "main") {
    const closeBtn = document.createElement("button");
    closeBtn.className = "pane-close-btn";
    closeBtn.innerHTML = "&times;";
    closeBtn.title = "Remove session";
    closeBtn.onclick = (e) => { e.stopPropagation(); removeSession(sessionId); };
    header.appendChild(closeBtn);

    // Drag for tiling: set session-id data type for Tiling drop zones
    header.draggable = true;
    header.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/session-id", sessionId);
      e.dataTransfer.setData("text/plain", sessionId);
      e.dataTransfer.effectAllowed = "move";
      pane.classList.add("pane-dragging");
    });
    header.addEventListener("dragend", () => {
      pane.classList.remove("pane-dragging");
      document.querySelectorAll(".tile-drop-indicator").forEach(el => el.remove());
    });
  }

  pane.appendChild(header);

  const scroll = document.createElement("div");
  scroll.className = "log-scroll";
  scroll.appendChild(makeEmptyState());
  pane.appendChild(scroll);

  const paneObj = { id: sessionId, el: pane, scrollEl: scroll, autoScroll: true, color, idleSpan };

  scroll.addEventListener("scroll", () => {
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 50;
    paneObj.autoScroll = atBottom;
    // Only show fade when content overflows AND user has scrolled down
    scroll.classList.toggle("has-overflow", scroll.scrollTop > 20);
  });

  return paneObj;
}

function updatePaneIdleLabels() {
  for (const [id, p] of panes) {
    if (!p.idleSpan) continue;
    const info = sessions.get(id);
    p.idleSpan.textContent = info ? formatInactive(info.lastEventTs) : "";
  }
}
setInterval(updatePaneIdleLabels, 5000);

// ===== Tiling integration =====
// Initialize tiling with a callback that creates pane elements
Tiling.init(paneContainer, (sessionId) => {
  const info = sessions.get(sessionId);
  if (!info) return null;
  if (!info.color) info.color = nextSessionColor();
  const p = createPane(sessionId, info.label, info.color);
  panes.set(sessionId, p);
  return p.el;
}, {
  onBeforeRebuild: () => { panes.clear(); },
  onRebuild: () => { rebuildAllPaneContents(); },
});

function rebuildPanes() {
  paneContainer.innerHTML = "";
  panes.clear();
  mainContainer = null;

  if (activeSession !== "all" || sessions.size <= 1) {
    paneContainer.classList.remove("multi-pane");
    paneContainer.classList.remove("grid-layout");
    paneContainer.style.removeProperty("grid-template-columns");
    paneContainer.style.removeProperty("grid-template-rows");
    const p = createPane("main", "All", "var(--accent)");
    paneContainer.appendChild(p.el);
    panes.set("main", p);
    mainContainer = p.scrollEl;
    Tiling.clear();
  } else {
    syncSessionOrder();
    paneContainer.classList.remove("grid-layout");

    // Build tiling tree from session order (preserves existing tree if sessions match)
    const tilingIds = Tiling.getSessionIds();
    const currentIds = new Set(sessionOrder.filter(id => sessions.has(id)));
    const tilingSet = new Set(tilingIds);

    // Batch add/remove without per-op rebuilds
    for (const id of currentIds) {
      if (!tilingSet.has(id)) Tiling.addSession(id, false);
    }
    for (const id of tilingIds) {
      if (!currentIds.has(id)) Tiling.removeSession(id, false);
    }

    Tiling.rebuild();
  }

  // Apply saved zoom
  const z = localStorage.getItem("loupe-zoom");
  if (z) applyZoom(parseFloat(z));
}

// Grid controls no longer needed — tiling handles layout
window.setGridCols = () => {};
let gridCols = 4; // kept for backwards compat with HTML onclick

function updateGridControlsVisibility() {
  if (gridControls) gridControls.style.display = "none";
  if (gridSep) gridSep.style.display = "none";
}

function getContainerFor(entry) {
  if (activeSession !== "all" || sessions.size <= 1) return panes.get("main")?.scrollEl || null;
  if (entry.sessionId && panes.has(entry.sessionId)) return panes.get(entry.sessionId).scrollEl;
  const first = panes.values().next().value;
  return first?.scrollEl || null;
}

function shouldAutoScroll(entry) {
  if (activeSession !== "all" || sessions.size <= 1) return panes.get("main")?.autoScroll ?? true;
  if (entry.sessionId && panes.has(entry.sessionId)) return panes.get(entry.sessionId).autoScroll;
  return true;
}

function scrollPaneToBottom(entry) {
  const container = getContainerFor(entry);
  if (container) container.scrollTop = container.scrollHeight;
}

rebuildPanes();
updateGridControlsVisibility();

// ===== WebSocket =====
let ws;
let reconnectDelay = 500;

function connect() {
  const host = window.__LOGSTREAM_HOST || location.host;
  ws = new WebSocket(`ws://${host}/ws`);

  ws.onopen = () => { reconnectDelay = 500; setConnState("connected"); };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "reset") { resetAll(); return; }
    if (msg.type === "backlog_done") { scrollToBottom(); return; }
    if (msg.type === "sessions") { reconcileSessions(msg.list); return; }
    if (msg.type === "session_remove") { pruneSessionTab(msg.id); return; }
    if (msg.type === "line") handleLine(msg);
  };

  ws.onclose = () => {
    setConnState("disconnected");
    setTimeout(() => { reconnectDelay = Math.min(reconnectDelay * 1.5, 5000); connect(); }, reconnectDelay);
  };
  ws.onerror = () => setConnState("disconnected");
}

function setConnState(state) {
  connDot.className = `conn-dot ${state}`;
  connStatus.textContent = state;
}

function resetAll() {
  entries.length = 0;
  lineCounter = 0;
  firstEventTs = null;
  sessions.clear();
  sessionGroups.clear();
  taskIdCounter = 0;
  queryIdCounter = 0;
  colorIdx = 0;
  if (momentumInitialized) Momentum.reset();
  rebuildTabs();
  rebuildPanes();
}

// ===== Parse =====
function unwrapHook(json) {
  if (json && json._logstream_type && json.data) return { hookType: json._logstream_type, ts: json._ts, inner: json.data };
  return null;
}

function categorize(msg) {
  const json = msg.json;
  if (json) {
    const hook = unwrapHook(json);
    if (hook) {
      if (hook.hookType === "PreToolUse") {
        if (hook.inner?.tool_name === "Agent") return "sub_agent";
        return "tool_use";
      }
      if (hook.hookType === "PostToolUse") {
        if (hook.inner?.tool_name === "Agent") return "sub_agent_result";
        const inner = hook.inner;
        if (inner && (inner.is_error || inner.error)) return "error";
        return "post_tool";
      }
      if (hook.hookType === "thinking") return "thinking";
      if (hook.hookType === "user_query") return "user_query";
    }
    const t = json.type;
    if (t === "user_query") return "user_query";
    if (t === "thinking" || json.thinking) return "thinking";
    if (t === "tool_use") return "tool_use";
    if (t === "tool_result") return json.is_error ? "error" : "tool_result";
    if (t === "error" || json.error) return "error";
    if (t === "text" || t === "content_block_delta" || t === "assistant") return "text";
  }
  const lower = (msg.data || "").toLowerCase();
  if (lower.includes("error") || lower.includes("fatal")) return "error";
  return "text";
}

function extractTitle(msg, category) {
  const json = msg.json;
  if (!json) return null;
  const hook = unwrapHook(json);
  if (hook && hook.inner) {
    if (category === "sub_agent" || category === "sub_agent_result") {
      const input = hook.inner.tool_input || {};
      return input.subagent_type || input.description || "Agent";
    }
    return hook.inner.tool_name || hook.inner.name || null;
  }
  if (category === "tool_use") return json.name || json.tool_name || null;
  return null;
}

function extractSummary(msg, category) {
  const json = msg.json;
  if (!json) return msg.data || "";
  const hook = unwrapHook(json);
  const inner = hook?.inner || json;

  if (category === "tool_use") {
    const input = inner.tool_input || inner.input || {};
    if (input.description) return input.description;
    if (input.file_path) return input.file_path;
    if (input.command) return input.command.split("\n")[0];
    if (input.pattern) return `pattern: ${input.pattern}`;
    if (input.query) return input.query;
    return Object.keys(input).slice(0, 3).join(", ");
  }
  if (category === "tool_result" || category === "post_tool") {
    const resp = inner.tool_response || {};
    const out = resp.stdout || inner.tool_result || inner.output || inner.content;
    if (typeof out === "string") return out.split("\n")[0];
    return "";
  }
  if (category === "error") return inner.error || inner.tool_result || "Error";
  if (category === "thinking") {
    const t = inner.thinking || inner.content || inner.text || "";
    return typeof t === "string" ? t : "";
  }
  if (category === "sub_agent") {
    const input = inner.tool_input || {};
    return input.description || input.prompt?.slice(0, 100) || "";
  }
  if (category === "sub_agent_result") {
    const resp = inner.tool_response || {};
    const text = resp.content?.[0]?.text || resp.status || "";
    return typeof text === "string" ? text.split("\n")[0] : "";
  }
  return "";
}

function extractBody(msg, category) {
  const json = msg.json;
  if (!json) return msg.data;
  const hook = unwrapHook(json);
  if (hook && hook.inner) {
    const inner = hook.inner;
    if (category === "sub_agent") return inner.tool_input || inner;
    if (category === "sub_agent_result") return inner.tool_response || inner;
    if (category === "tool_use") return inner.tool_input || inner.input || inner;
    if (category === "tool_result" || category === "post_tool") return inner.tool_response || inner.tool_result || inner.output || inner.content || inner;
    if (category === "error") return inner.error || inner.tool_result || inner;
    if (category === "thinking") return inner.thinking || inner.content || inner.text || inner;
    return inner;
  }
  if (category === "thinking") return json.thinking || json.content || json.text || msg.data;
  if (category === "text") return json.text || json.content || json.data || msg.data;
  if (category === "tool_use") return json.input || json.parameters || json;
  if (category === "tool_result" || category === "post_tool" || category === "error") return json.content || json.output || json.result || json.error || msg.data;
  return json;
}

function extractSessionId(msg) {
  const json = msg.json;
  if (!json) return null;
  const hook = unwrapHook(json);
  return (hook?.inner || json).session_id || null;
}

function extractUserQuery(msg) {
  const json = msg.json;
  if (!json) return null;
  const hook = unwrapHook(json);
  return (hook?.inner || json).user_query || null;
}

function extractMeta(msg) {
  const json = msg.json;
  if (!json) return null;
  const hook = unwrapHook(json);
  return (hook?.inner || json).meta || null;
}

function extractUserImages(msg) {
  const json = msg.json;
  if (!json) return null;
  const hook = unwrapHook(json);
  return (hook?.inner || json).user_images || null;
}

function extractSessionLabel(msg) {
  const json = msg.json;
  if (!json) return null;
  const hook = unwrapHook(json);
  const cwd = (hook?.inner || json).cwd;
  if (cwd) { const parts = cwd.split("/"); return parts[parts.length - 1] || parts[parts.length - 2] || cwd; }
  return null;
}

// ===== Render =====
function handleLine(msg) {
  lineCounter++;
  signalActivity();

  const category = categorize(msg);
  const title = extractTitle(msg, category);
  const summary = extractSummary(msg, category);
  const body = extractBody(msg, category);
  let sessionId = extractSessionId(msg);
  const sessionLabel = extractSessionLabel(msg);
  const userQuery = extractUserQuery(msg);
  const meta = extractMeta(msg);
  const userImages = extractUserImages(msg);
  if (!firstEventTs) firstEventTs = msg.ts;

  // --- Sub-agent session mapping ---
  // Track agent spawns so we can remap child sessions
  if (category === "sub_agent" && sessionId) {
    const pending = pendingAgentSpawns.get(sessionId) || { ts: msg.ts, count: 0 };
    pending.count++;
    pending.ts = msg.ts;
    pendingAgentSpawns.set(sessionId, pending);
  }
  if (category === "sub_agent_result" && sessionId) {
    const pending = pendingAgentSpawns.get(sessionId);
    if (pending) {
      pending.count = Math.max(0, pending.count - 1);
      if (pending.count === 0) pendingAgentSpawns.delete(sessionId);
    }
  }

  // If this is a new session_id and there's a pending agent spawn, map it to the parent
  if (sessionId && !sessions.has(sessionId) && !childSessionMap.has(sessionId)) {
    for (const [parentSid, info] of pendingAgentSpawns) {
      if (parentSid !== sessionId && msg.ts - info.ts < 60000) {
        childSessionMap.set(sessionId, parentSid);
        break;
      }
    }
  }

  // Remap child session to parent
  if (sessionId && childSessionMap.has(sessionId)) {
    sessionId = childSessionMap.get(sessionId);
  }

  let newSession = false;
  if (sessionId && !sessions.has(sessionId)) {
    const sColor = nextSessionColor();
    const sLabel = sessionLabel || sessionId.slice(0, 8);
    sessions.set(sessionId, { label: sLabel, count: 0, color: sColor, lastEventTs: msg.ts });
    newSession = true;
    rebuildTabs();
    if (Gravity.registerSession) Gravity.registerSession(sessionId, sLabel, sColor);
    if (momentumInitialized) Momentum.registerSession(sessionId, sLabel, sColor);
  }
  if (sessionId && sessions.has(sessionId)) {
    const sInfo = sessions.get(sessionId);
    sInfo.count++;
    sInfo.lastEventTs = msg.ts;
    if (sInfo.stale) { sInfo.stale = false; rebuildTabs(); }
    if (activeSession !== "all" && activeSession !== sessionId) {
      const tab = tabBar.querySelector(`[data-session="${sessionId}"] .tab-dot`);
      if (tab) tab.classList.add("has-activity");
    }
  }

  const entry = { id: lineCounter, category, title, summary, body, raw: msg.data, json: msg.json, ts: msg.ts, sessionId, userQuery, userImages, meta };
  entries.push(entry);

  // Assign to task/query group
  assignToGroup(entry);

  // Feed to universe renderer if initialized
  if (gravityInitialized) Gravity.addEntry(entry);
  if (momentumInitialized) Momentum.addEntry(entry);

  if (newSession && activeSession === "all" && sessions.size > 1) {
    rebuildPanes();
    rebuildAllPaneContents();
  } else if (matchesAll(entry)) {
    appendEntryGrouped(entry);
  }

  lineCountEl.textContent = lineCounter;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function badgeLabel(cat) {
  return { tool_use: "USE", tool_result: "RESULT", post_tool: "POST", error: "ERROR", thinking: "THINK", text: "TEXT", sub_agent: "AGENT", sub_agent_result: "AGENT", user_query: "QUERY" }[cat] || cat.toUpperCase();
}

function esc(str) { const d = document.createElement("div"); d.textContent = str; return d.innerHTML; }

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } catch (err) {
    console.warn("Fallback copy failed:", err);
  }
  document.body.removeChild(ta);
  return Promise.resolve();
}

function renderEntry(entry) {
  const div = document.createElement("div");
  div.className = "log-entry";
  div.dataset.id = entry.id;
  div.dataset.category = entry.category;
  if (entry.sessionId) div.dataset.session = entry.sessionId;

  div.innerHTML = `
    <div class="entry-row">
      <span class="entry-badge cat-${entry.category}">${badgeLabel(entry.category)}</span>
      ${entry.title ? `<span class="entry-tool">${esc(entry.title)}</span>` : ""}
      <span class="entry-summary">${esc(entry.summary)}</span>
      <span class="entry-time">${formatTime(entry.ts)}</span>
    </div>
  `;

  div.addEventListener("click", () => openModal(entry.id));
  return div;
}

// ===== Grouped Rendering =====

function formatTimeRange(startTs, endTs) {
  const s = formatTime(startTs);
  const e = formatTime(endTs);
  return s === e ? s : `${s}–${e}`;
}

function countItemActions(items) {
  let count = 0;
  for (const item of items) {
    if (item.agentEntry) {
      count += 1 + item.children.length + (item.resultEntry ? 1 : 0);
    } else {
      count++;
    }
  }
  return count;
}

function renderTaskHeader(task) {
  const div = document.createElement("div");
  div.className = "task-header";
  const qCount = task.queries.length;
  const chevron = task.collapsed ? "\u25B6" : "\u25BC";
  div.innerHTML = `<span class="task-chevron">${chevron}</span><span class="task-label">Task ${task.seqNum}</span><span class="task-time">${formatTimeRange(task.startTs, task.endTs)}</span><span class="task-qcount">${qCount} ${qCount === 1 ? "query" : "queries"}</span>`;
  return div;
}

function bindTaskHeaderClick(task) {
  task.headerEl.addEventListener("click", () => {
    const isCollapsed = task.bodyEl.classList.toggle("collapsed");
    task.headerEl.querySelector(".task-chevron").textContent = isCollapsed ? "\u25B6" : "\u25BC";
    task.collapsed = isCollapsed;
  });
}

function renderQueryHeader(query) {
  const div = document.createElement("div");
  div.className = "query-header";
  const actionCount = countItemActions(query.items);
  const qText = query.userQuery ? esc(query.userQuery) : "No user query found";
  div.innerHTML = `<span class="query-chevron">\u25B6</span><span class="query-badge">Q</span><span class="query-text-wrap"><span class="query-text">${qText}</span>${query.userQuery ? `<span class="query-tooltip">${esc(query.userQuery)}</span>` : ""}<span class="query-copied">Copied!</span></span><span class="query-count">${actionCount}</span><span class="query-time">${formatTimeRange(query.startTs, query.endTs)}</span>`;

  // Click on query text copies the full query
  if (query.userQuery) {
    const wrapEl = div.querySelector(".query-text-wrap");
    wrapEl.addEventListener("click", (e) => {
      e.stopPropagation();
      copyToClipboard(query.userQuery).then(() => {
        const copiedEl = wrapEl.querySelector(".query-copied");
        copiedEl.classList.add("visible");
        wrapEl.classList.add("just-copied");
        setTimeout(() => {
          copiedEl.classList.remove("visible");
          wrapEl.classList.remove("just-copied");
        }, 1000);
      });
    });
  }

  return div;
}

function renderAgentHeader(agentEntry) {
  const div = document.createElement("div");
  div.className = "agent-header";
  div.innerHTML = `<span class="agent-chevron">\u25B6</span><span class="entry-badge cat-sub_agent">AGENT</span><span class="agent-desc">${esc(agentEntry.title || agentEntry.summary || "Agent")}</span><span class="entry-time">${formatTime(agentEntry.ts)}</span>`;
  return div;
}

function renderAgentGroup(ag, matchFn) {
  const wrap = document.createElement("div");
  wrap.className = "agent-group";

  const header = renderAgentHeader(ag.agentEntry);
  wrap.appendChild(header);

  const childrenEl = document.createElement("div");
  childrenEl.className = "agent-children collapsed";

  for (const child of ag.children) {
    if (child.agentEntry) {
      // Nested agent
      const nested = renderAgentGroup(child, matchFn);
      if (nested) childrenEl.appendChild(nested);
    } else {
      if (matchFn && !matchFn(child)) continue;
      const el = renderEntry(child);
      childrenEl.appendChild(el);
      child.el = el;
    }
  }
  if (ag.resultEntry) {
    if (!matchFn || matchFn(ag.resultEntry)) {
      const resEl = renderEntry(ag.resultEntry);
      childrenEl.appendChild(resEl);
      ag.resultEntry.el = resEl;
    }
  }

  wrap.appendChild(childrenEl);

  // Chevron click: toggle collapse
  const chevronEl = header.querySelector(".agent-chevron");
  chevronEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const isCollapsed = childrenEl.classList.toggle("collapsed");
    chevronEl.textContent = isCollapsed ? "\u25B6" : "\u25BC";
  });

  // Click on badge/desc: open modal to see the agent prompt
  header.addEventListener("click", (e) => {
    e.stopPropagation();
    // If clicking the chevron, let its own handler deal with it
    if (e.target === chevronEl || e.target.closest(".agent-chevron")) return;
    openModal(ag.agentEntry.id);
  });

  ag.el = wrap;
  ag.childrenEl = childrenEl;
  return wrap;
}

function renderQueryGroup(query, matchFn) {
  const wrap = document.createElement("div");
  wrap.className = "query-group";

  const header = renderQueryHeader(query);
  wrap.appendChild(header);

  const actionsEl = document.createElement("div");
  actionsEl.className = "query-actions collapsed";

  for (const item of query.items) {
    if (item.agentEntry) {
      const agEl = renderAgentGroup(item, matchFn);
      if (agEl) actionsEl.appendChild(agEl);
    } else {
      if (matchFn && !matchFn(item)) continue;
      const el = renderEntry(item);
      actionsEl.appendChild(el);
      item.el = el;
    }
  }

  wrap.appendChild(actionsEl);

  header.addEventListener("click", (e) => {
    e.stopPropagation();
    const isCollapsed = actionsEl.classList.toggle("collapsed");
    header.querySelector(".query-chevron").textContent = isCollapsed ? "\u25B6" : "\u25BC";
    query.collapsed = isCollapsed;
  });

  // Double-click opens thinking entry modal
  if (query.thinkingEntry) {
    header.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      openModal(query.thinkingEntry.id);
    });
  }

  query.el = wrap;
  query.actionsEl = actionsEl;
  query.headerEl = header;
  return wrap;
}

function renderTaskGroup(task, matchFn) {
  const wrap = document.createElement("div");
  wrap.className = "task-group";

  const header = renderTaskHeader(task);
  wrap.appendChild(header);

  const bodyEl = document.createElement("div");
  bodyEl.className = "task-body";

  for (const query of task.queries) {
    const qEl = renderQueryGroup(query, matchFn);
    bodyEl.appendChild(qEl);
  }

  wrap.appendChild(bodyEl);

  task.el = wrap;
  task.bodyEl = bodyEl;
  task.headerEl = header;
  bindTaskHeaderClick(task);
  return wrap;
}

// Render all grouped entries for a given session into a container
function renderGroupedEntries(container, sessionId) {
  const gs = sessionGroups.get(sessionId);
  if (!gs) return 0;

  const matchFn = (entry) => matchesFilter(entry) && matchesSearch(entry);
  let matchCount = 0;

  for (let i = 0; i < gs.tasks.length; i++) {
    const task = gs.tasks[i];
    const taskEl = renderTaskGroup(task, matchFn);
    container.appendChild(taskEl);
    // Count visible entries
    taskEl.querySelectorAll(".log-entry").forEach(() => matchCount++);
  }

  return matchCount;
}

// Real-time append: insert entry into its correct grouped DOM position
function appendEntryGrouped(entry) {
  const container = getContainerFor(entry);
  if (!container) return;

  const empty = container.querySelector(".empty-state");
  if (empty) empty.remove();

  const sid = entry.sessionId || "default";
  const gs = sessionGroups.get(sid);
  if (!gs) return;

  const task = gs.currentTask;
  const query = gs.currentQuery;
  if (!task || !query) return;

  // Ensure task DOM exists
  if (!task.el) {
    const taskEl = document.createElement("div");
    taskEl.className = "task-group";
    const header = renderTaskHeader(task);
    taskEl.appendChild(header);
    const bodyEl = document.createElement("div");
    bodyEl.className = "task-body";
    taskEl.appendChild(bodyEl);
    task.el = taskEl;
    task.bodyEl = bodyEl;
    task.headerEl = header;
    bindTaskHeaderClick(task);
    container.appendChild(taskEl);
  } else {
    // Update task header (time range, query count may have changed)
    const newHeader = renderTaskHeader(task);
    if (task.headerEl && task.el.contains(task.headerEl)) {
      task.el.replaceChild(newHeader, task.headerEl);
    } else {
      task.el.insertBefore(newHeader, task.el.firstChild);
    }
    task.headerEl = newHeader;
    bindTaskHeaderClick(task);
  }

  // Ensure query DOM exists
  if (!query.el) {
    const matchFn = (e) => matchesFilter(e) && matchesSearch(e);
    const qEl = renderQueryGroup(query, matchFn);
    task.bodyEl.appendChild(qEl);
  } else {
    // Update query header (action count may have changed)
    const newQHeader = renderQueryHeader(query);
    // Preserve collapse state in new header
    if (!query.collapsed) {
      newQHeader.querySelector(".query-chevron").textContent = "\u25BC";
    }
    // Re-bind click handler
    newQHeader.addEventListener("click", (e) => {
      e.stopPropagation();
      const isCollapsed = query.actionsEl.classList.toggle("collapsed");
      newQHeader.querySelector(".query-chevron").textContent = isCollapsed ? "\u25B6" : "\u25BC";
      query.collapsed = isCollapsed;
    });
    if (query.thinkingEntry) {
      newQHeader.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        openModal(query.thinkingEntry.id);
      });
    }
    if (query.headerEl && query.el.contains(query.headerEl)) {
      query.el.replaceChild(newQHeader, query.headerEl);
    } else {
      query.el.insertBefore(newQHeader, query.el.firstChild);
    }
    query.headerEl = newQHeader;
  }

  // user_query and thinking entries that started a new query are represented by the query header
  if (entry.category === "user_query") {
    if (shouldAutoScroll(entry)) scrollPaneToBottom(entry);
    return;
  }
  if (entry.category === "thinking" && entry.userQuery && query.thinkingEntry === entry && query.items.length === 0) {
    if (shouldAutoScroll(entry)) scrollPaneToBottom(entry);
    return;
  }

  // For sub_agent and sub_agent_result, the agent group rendering handles it
  if (entry.category === "sub_agent") {
    // Find the agent group just created by assignToGroup
    const ag = findAgentGroupForEntry(gs, entry);
    if (ag) {
      const agEl = renderAgentGroup(ag, (e) => matchesFilter(e) && matchesSearch(e));
      if (agEl) {
        // Insert into correct parent
        if (gs.agentStack.length > 1) {
          // Nested: parent agent's childrenEl
          const parentAg = gs.agentStack[gs.agentStack.length - 2];
          if (parentAg && parentAg.childrenEl) parentAg.childrenEl.appendChild(agEl);
        } else {
          query.actionsEl.appendChild(agEl);
        }
      }
    }
    if (shouldAutoScroll(entry)) scrollPaneToBottom(entry);
    return;
  }

  if (entry.category === "sub_agent_result") {
    // Result was already attached to agent group by assignToGroup
    // Re-render the agent group or just append result entry
    // Find the agent group that just got its result
    const ag = findAgentGroupForResult(gs, entry);
    if (ag && ag.childrenEl) {
      if (matchesFilter(entry) && matchesSearch(entry)) {
        const resEl = renderEntry(entry);
        resEl.classList.add("flash");
        ag.childrenEl.appendChild(resEl);
        entry.el = resEl;
      }
    }
    if (shouldAutoScroll(entry)) scrollPaneToBottom(entry);
    return;
  }

  // Regular entry
  if (!matchesFilter(entry) || !matchesSearch(entry)) return;

  const el = renderEntry(entry);
  el.classList.add("flash");

  // Append to top-of-stack agent or query actions
  if (gs.agentStack.length > 0) {
    const topAg = gs.agentStack[gs.agentStack.length - 1];
    if (topAg.childrenEl) topAg.childrenEl.appendChild(el);
    else query.actionsEl.appendChild(el);
  } else {
    query.actionsEl.appendChild(el);
  }

  entry.el = el;
  if (shouldAutoScroll(entry)) scrollPaneToBottom(entry);
}

function findAgentGroupForEntry(gs, entry) {
  // The entry was just pushed as the last item on the agent stack
  if (gs.agentStack.length > 0) {
    const top = gs.agentStack[gs.agentStack.length - 1];
    if (top.agentEntry === entry) return top;
  }
  return null;
}

function findAgentGroupForResult(gs, entry) {
  // The result was just popped off the stack — search recent query items
  const query = gs.currentQuery;
  if (!query) return null;
  function searchItems(items) {
    for (const item of items) {
      if (item.agentEntry && item.resultEntry === entry) return item;
      if (item.agentEntry) {
        const found = searchItems(item.children);
        if (found) return found;
      }
    }
    return null;
  }
  return searchItems(query.items);
}

// ===== Detail Modal =====
let modalEntryId = null;

function openModal(id) {
  const entry = entries.find(e => e.id === id);
  if (!entry) return;
  modalEntryId = id;

  modalBadge.className = `modal-badge cat-${entry.category}`;
  modalBadge.textContent = badgeLabel(entry.category);
  modalTool.textContent = entry.title || "";
  modalTime.textContent = formatTime(entry.ts);

  // Apply thinking variant to panel
  modalPanel.classList.toggle("modal-thinking", entry.category === "thinking");

  modalBody.innerHTML = "";

  if (entry.category === "thinking") {
    // Thinking modal: user query + thinking content
    if (entry.userQuery) {
      const queryWrap = document.createElement("div");
      queryWrap.className = "modal-user-query-inline";
      queryWrap.innerHTML = `<span class="modal-user-query-label">Q</span><span class="modal-user-query-text">${esc(entry.userQuery)}</span>`;
      queryWrap.style.cursor = "pointer";
      queryWrap.addEventListener("click", () => {
        const isExpanded = queryWrap.classList.toggle("expanded");
        queryWrap.title = isExpanded ? "Click to collapse" : "Click to expand";
      });
      queryWrap.title = "Click to expand";
      modalBody.appendChild(queryWrap);
    }
    // Image thumbnails
    if (entry.userImages && entry.userImages.length > 0) {
      const imgRow = document.createElement("div");
      imgRow.className = "modal-image-row";
      for (const imgPath of entry.userImages) {
        const thumb = document.createElement("img");
        thumb.className = "modal-image-thumb";
        thumb.src = `/image?path=${encodeURIComponent(imgPath)}`;
        thumb.alt = "User image";
        thumb.addEventListener("click", () => {
          thumb.classList.toggle("modal-image-expanded");
        });
        imgRow.appendChild(thumb);
      }
      modalBody.appendChild(imgRow);
    }
    const thinkCode = document.createElement("div");
    thinkCode.className = "modal-code modal-thinking-body";
    thinkCode.textContent = String(entry.body || "");
    modalBody.appendChild(thinkCode);

    // Collapsible metadata
    if (entry.meta) {
      const metaToggle = document.createElement("div");
      metaToggle.className = "modal-meta-toggle";
      metaToggle.innerHTML = `<span class="modal-meta-arrow">\u25b6</span> Metadata`;
      const metaContent = document.createElement("div");
      metaContent.className = "modal-meta-content";
      metaContent.style.display = "none";
      const m = entry.meta;
      const rows = [];
      if (m.model) rows.push(["Model", m.model]);
      if (m.input_tokens) rows.push(["Input tokens", m.input_tokens.toLocaleString()]);
      if (m.output_tokens) rows.push(["Output tokens", m.output_tokens.toLocaleString()]);
      if (m.cache_read) rows.push(["Cache read", m.cache_read.toLocaleString()]);
      if (m.cache_create) rows.push(["Cache create", m.cache_create.toLocaleString()]);
      if (m.cwd) rows.push(["Working dir", m.cwd]);
      if (m.git_branch) rows.push(["Branch", m.git_branch]);
      if (m.version) rows.push(["Version", m.version]);
      metaContent.innerHTML = rows.map(([k, v]) =>
        `<div class="modal-meta-row"><span class="modal-meta-key">${esc(k)}</span><span class="modal-meta-val">${esc(String(v))}</span></div>`
      ).join("");
      metaToggle.addEventListener("click", () => {
        const open = metaContent.style.display !== "none";
        metaContent.style.display = open ? "none" : "";
        metaToggle.querySelector(".modal-meta-arrow").textContent = open ? "\u25b6" : "\u25bc";
      });
      modalBody.appendChild(metaToggle);
      modalBody.appendChild(metaContent);
    }
  } else if (entry.category === "sub_agent" || entry.category === "sub_agent_result") {
    const content = entry.body;
    if (content && typeof content === "object") {
      // Prompt section
      const prompt = content.prompt || content.description;
      if (prompt) {
        const lbl = document.createElement("div");
        lbl.className = "modal-section-label";
        lbl.textContent = "Prompt";
        modalBody.appendChild(lbl);
        const code = document.createElement("div");
        code.className = "modal-code";
        code.textContent = prompt;
        modalBody.appendChild(code);
      }
      // Content blocks
      const blocks = content.content || [];
      if (Array.isArray(blocks) && blocks.length > 0) {
        const lbl = document.createElement("div");
        lbl.className = "modal-section-label";
        lbl.textContent = "Response";
        modalBody.appendChild(lbl);
        for (const block of blocks) {
          const blockDiv = document.createElement("div");
          blockDiv.className = "modal-code modal-agent-block";
          if (block.type && block.type !== "text") {
            const tag = document.createElement("span");
            tag.className = "modal-agent-block-type";
            tag.textContent = block.type;
            blockDiv.appendChild(tag);
          }
          const text = block.text || block.content || (typeof block === "string" ? block : JSON.stringify(block));
          const textNode = document.createTextNode(text);
          blockDiv.appendChild(textNode);
          modalBody.appendChild(blockDiv);
        }
      }
      // Status if present
      if (content.status && content.status !== "completed") {
        const lbl = document.createElement("div");
        lbl.className = "modal-section-label";
        lbl.textContent = "Status";
        modalBody.appendChild(lbl);
        const code = document.createElement("div");
        code.className = "modal-code";
        code.textContent = content.status;
        modalBody.appendChild(code);
      }
    } else if (content) {
      const code = document.createElement("div");
      code.className = "modal-code";
      code.textContent = String(content);
      modalBody.appendChild(code);
    }
  } else {
    const content = entry.body;
    if (content && typeof content === "object") {
      if (content.tool_input || content.command || content.file_path) {
        addModalSection("Input", content);
      } else if (content.tool_response) {
        addModalSection("Input", { ...content, tool_response: undefined });
        addModalSection("Response", content.tool_response);
      } else {
        addModalSection("Detail", content);
      }
    } else if (content) {
      const code = document.createElement("div");
      code.className = "modal-code";
      code.textContent = String(content);
      modalBody.appendChild(code);
    }
  }

  modalOverlay.classList.add("visible");
}

function addModalSection(label, obj) {
  const lbl = document.createElement("div");
  lbl.className = "modal-section-label";
  lbl.textContent = label;
  modalBody.appendChild(lbl);

  const code = document.createElement("div");
  code.className = "modal-code";
  if (typeof obj === "object" && obj !== null) {
    code.appendChild(renderJsonTree(obj));
  } else {
    code.textContent = String(obj || "");
  }
  modalBody.appendChild(code);
}

function closeModal() {
  modalOverlay.classList.remove("visible");
  modalOverlay.classList.remove("modal-replay");
  modalEntryId = null;
}

modalClose.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });

document.getElementById("modal-copy").addEventListener("click", () => {
  const text = modalBody.innerText || modalBody.textContent || "";
  copyToClipboard(text);
  const btn = document.getElementById("modal-copy");
  btn.textContent = "\u2713";
  setTimeout(() => { btn.innerHTML = "&#x2398;"; }, 1000);
});

// ===== JSON Tree =====
function renderJsonTree(obj, depth = 0) {
  const wrap = document.createElement("div");
  wrap.className = "json-tree";
  if (typeof obj !== "object" || obj === null) { wrap.innerHTML = renderPrimitive(obj); return wrap; }

  const isArr = Array.isArray(obj);
  const keys = Object.keys(obj);
  const open = isArr ? "[" : "{";
  const close = isArr ? "]" : "}";
  if (keys.length === 0) { wrap.innerHTML = `<span class="json-bracket">${open}${close}</span>`; return wrap; }

  const collapsed = depth > 1;
  const toggle = document.createElement("span");
  toggle.className = "json-toggle";
  toggle.textContent = collapsed ? "\u25b6 " : "\u25bc ";
  toggle.onclick = (e) => {
    e.stopPropagation();
    const c = wrap.querySelector(".json-content");
    const ind = wrap.querySelector(".json-collapsed-indicator");
    if (c.style.display === "none") { c.style.display = ""; if (ind) ind.style.display = "none"; toggle.textContent = "\u25bc "; }
    else { c.style.display = "none"; if (ind) ind.style.display = ""; toggle.textContent = "\u25b6 "; }
  };
  wrap.appendChild(toggle);
  wrap.appendChild(spanOf(open, "json-bracket"));

  const indicator = document.createElement("span");
  indicator.className = "json-collapsed-indicator";
  indicator.textContent = ` ${keys.length} items `;
  indicator.style.display = collapsed ? "" : "none";
  wrap.appendChild(indicator);

  const content = document.createElement("div");
  content.className = "json-content";
  content.style.paddingLeft = "14px";
  content.style.display = collapsed ? "none" : "";

  keys.forEach((key, i) => {
    const line = document.createElement("div");
    if (!isArr) { line.appendChild(spanOf(`"${key}"`, "json-key")); line.appendChild(spanOf(": ", "json-bracket")); }
    const val = obj[key];
    if (typeof val === "object" && val !== null) line.appendChild(renderJsonTree(val, depth + 1));
    else line.innerHTML += renderPrimitive(val);
    if (i < keys.length - 1) line.appendChild(spanOf(",", "json-bracket"));
    content.appendChild(line);
  });

  wrap.appendChild(content);
  wrap.appendChild(spanOf(close, "json-bracket"));
  return wrap;
}

let truncId = 0;
function renderPrimitive(val) {
  if (val === null) return `<span class="json-null">null</span>`;
  if (typeof val === "boolean") return `<span class="json-bool">${val}</span>`;
  if (typeof val === "number") return `<span class="json-number">${val}</span>`;
  const str = String(val);
  if (str.length <= 800) return `<span class="json-string">"${esc(str)}"</span>`;
  const id = "trunc-" + (truncId++);
  return `<span class="json-string" id="${id}">"${esc(str.slice(0, 800))}<span class="trunc-fade">...</span>"<button class="trunc-btn" onclick="event.stopPropagation(); expandTruncated('${id}', this)" data-full="${esc(str).replace(/"/g, '&quot;')}">${str.length.toLocaleString()} chars</button></span>`;
}

window.expandTruncated = (id, btn) => {
  const el = document.getElementById(id);
  if (el) el.innerHTML = `"${btn.dataset.full}"`;
};

function spanOf(text, cls) { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; }

// ===== Filtering =====
function matchesAll(entry) { return matchesFilter(entry) && matchesSession(entry) && matchesSearch(entry); }
function matchesFilter(entry) {
  if (entry.category === "user_query") return true; // always show (represented by query header)
  if (entry.category === "sub_agent_result") return !hiddenTypes.has("sub_agent");
  return !hiddenTypes.has(entry.category);
}
function matchesSession(entry) { return activeSession === "all" || entry.sessionId === activeSession; }
function matchesSearch(entry) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (entry.raw || "").toLowerCase().includes(q) || (entry.title || "").toLowerCase().includes(q) || (entry.summary || "").toLowerCase().includes(q);
}

function applySearch(text) {
  if (!searchQuery) return esc(text);
  const escaped = esc(text);
  const q = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(new RegExp(`(${q})`, "gi"), "<mark>$1</mark>");
}

// ===== Multi-select filter dropdown =====
const FILTER_TYPES = [
  { key: "tool_use", label: "Tool Use", color: "#06b6d4" },
  { key: "post_tool", label: "Post Tool", color: "#f97316" },
  { key: "tool_result", label: "Result", color: "#4ade80" },
  { key: "error", label: "Error", color: "#ef4444" },
  { key: "thinking", label: "Thinking", color: "#8b5cf6" },
  { key: "sub_agent", label: "Agent", color: "#f59e0b" },
  { key: "text", label: "Other", color: "#8b8b96" },
];

function buildFilterMenu() {
  filterMenu.innerHTML = "";
  for (const ft of FILTER_TYPES) {
    const item = document.createElement("div");
    item.className = "filter-item";
    item.dataset.type = ft.key;
    const checked = !hiddenTypes.has(ft.key);

    // Checkbox: toggles this type on/off
    const check = document.createElement("span");
    check.className = `filter-check ${checked ? "checked" : ""}`;
    check.textContent = checked ? "\u2713" : "";
    check.onclick = (e) => {
      e.stopPropagation();
      if (hiddenTypes.has(ft.key)) hiddenTypes.delete(ft.key);
      else hiddenTypes.add(ft.key);
      buildFilterMenu();
      updateFilterLabel();
      rebuildView();
    };

    const color = document.createElement("span");
    color.className = "filter-color";
    color.style.background = ft.color;

    // Label: click to show ONLY this type
    const label = document.createElement("span");
    label.className = "filter-label";
    label.textContent = ft.label;
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

    item.appendChild(check);
    item.appendChild(color);
    item.appendChild(label);
    filterMenu.appendChild(item);
  }

  // "Show all" option at bottom
  const showAll = document.createElement("div");
  showAll.className = "filter-item";
  showAll.style.borderTop = "1px solid var(--border)";
  showAll.style.marginTop = "2px";
  showAll.style.paddingTop = "6px";
  showAll.innerHTML = '<span class="filter-check" style="visibility:hidden"></span><span class="filter-label">Show all</span>';
  showAll.onclick = (e) => {
    e.stopPropagation();
    hiddenTypes.clear();
    buildFilterMenu();
    updateFilterLabel();
    rebuildView();
  };
  filterMenu.appendChild(showAll);
}

function updateFilterLabel() {
  if (hiddenTypes.size === 0) filterTrigger.textContent = "All types";
  else if (hiddenTypes.size === FILTER_TYPES.length) filterTrigger.textContent = "None";
  else {
    const shown = FILTER_TYPES.filter(ft => !hiddenTypes.has(ft.key));
    filterTrigger.textContent = shown.map(ft => ft.label).join(", ");
  }
}

filterTrigger.onclick = () => filterMenu.classList.toggle("open");
document.addEventListener("click", (e) => {
  if (!filterDropdown.contains(e.target)) filterMenu.classList.remove("open");
});

buildFilterMenu();
searchInput.addEventListener("input", (e) => { searchQuery = e.target.value; rebuildView(); });

function rebuildView() {
  rebuildPanes();
  rebuildAllPaneContents();
  updateGridControlsVisibility();
}

function rebuildAllPaneContents() {
  for (const p of panes.values()) p.scrollEl.innerHTML = "";

  // Clear DOM references in group state so they get re-created
  for (const gs of sessionGroups.values()) {
    for (const task of gs.tasks) {
      task.el = null; task.bodyEl = null; task.headerEl = null;
      for (const query of task.queries) {
        query.el = null; query.actionsEl = null; query.headerEl = null;
        function clearAgentEls(items) {
          for (const item of items) {
            if (item.agentEntry) { item.el = null; item.childrenEl = null; clearAgentEls(item.children); }
          }
        }
        clearAgentEls(query.items);
      }
    }
  }

  let matchCount = 0;

  if (activeSession !== "all") {
    // Single session: render grouped
    const container = panes.get("main")?.scrollEl;
    if (container) {
      matchCount = renderGroupedEntries(container, activeSession);
    }
  } else if (sessions.size <= 1) {
    // Single session in "all" mode
    const sid = sessions.keys().next().value || "default";
    const container = panes.get("main")?.scrollEl;
    if (container) {
      matchCount = renderGroupedEntries(container, sid);
    }
  } else {
    // Multi-session: render grouped per pane
    for (const [sid] of sessions) {
      const pane = panes.get(sid);
      if (pane) {
        matchCount += renderGroupedEntries(pane.scrollEl, sid);
      }
    }
  }

  for (const p of panes.values()) {
    if (p.scrollEl.children.length === 0) p.scrollEl.appendChild(makeEmptyState());
    p.scrollEl.scrollTop = p.scrollEl.scrollHeight;
  }

  searchCount.textContent = searchQuery ? `${matchCount}` : "";
}

// ===== Session Tabs =====
let sessionOrder = [];

function syncSessionOrder() {
  for (const id of sessions.keys()) { if (!sessionOrder.includes(id)) sessionOrder.push(id); }
  sessionOrder = sessionOrder.filter(id => sessions.has(id));
}

function rebuildTabs() {
  syncSessionOrder();
  tabBar.innerHTML = "";

  // In minimal mode, show "loupe_" brand in the tab bar
  if (isMinimalMode()) {
    const brand = document.createElement("div");
    brand.className = "tab-brand";
    brand.innerHTML = 'loupe<span class="logo-cursor">_</span>';
    tabBar.appendChild(brand);
  }

  // Single session: just show its name (brand already shows in minimal mode)
  if (sessions.size <= 1) {
    if (sessions.size === 1) {
      const [id, info] = [...sessions.entries()][0];
      const tab = document.createElement("div");
      tab.className = "session-tab active";
      tab.dataset.session = id;
      tab.innerHTML = `<span class="tab-label">${esc(info.label)}</span>`;
      tabBar.appendChild(tab);
    }
    return;
  }

  {
    const allTab = document.createElement("div");
    allTab.className = `session-tab ${activeSession === "all" ? "active" : ""}`;
    allTab.dataset.session = "all";
    allTab.innerHTML = 'All <span class="tab-shortcut">1</span>';
    allTab.onclick = () => switchSession("all");
    tabBar.appendChild(allTab);
  }

  let tabIdx = 2;
  const now = Date.now();
  for (const id of sessionOrder) {
    const info = sessions.get(id);
    if (!info) continue;
    const staleMinutes = info.lastEventTs ? Math.floor((now - info.lastEventTs) / 60000) : 0;
    const isStale = staleMinutes >= 2;

    const tab = document.createElement("div");
    tab.className = `session-tab ${activeSession === id ? "active" : ""} ${isStale ? "tab-stale" : ""}`;
    tab.dataset.session = id;
    tab.draggable = true;
    const shortcut = tabIdx <= 9 ? `<span class="tab-shortcut">${tabIdx}</span>` : "";
    const staleLabel = isStale ? `<span class="tab-stale-label">${staleMinutes}m</span>` : "";
    tab.innerHTML = `<span class="tab-label">${esc(info.label)}</span>${shortcut}${staleLabel}<span class="tab-dot"></span><button class="tab-close" title="Remove">&times;</button>`;
    tab.onclick = (e) => { if (!e.target.classList.contains("tab-close")) switchSession(id); };
    tab.querySelector(".tab-close").onclick = (e) => { e.stopPropagation(); removeSession(id); };

    // Drag
    tab.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", id); e.dataTransfer.setData("text/session-id", id); tab.classList.add("tab-dragging"); e.dataTransfer.effectAllowed = "move"; });
    tab.addEventListener("dragend", () => { tab.classList.remove("tab-dragging"); tabBar.querySelectorAll(".tab-drop-target").forEach(el => el.classList.remove("tab-drop-target")); });
    tab.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; tab.classList.add("tab-drop-target"); });
    tab.addEventListener("dragleave", () => tab.classList.remove("tab-drop-target"));
    tab.addEventListener("drop", (e) => {
      e.preventDefault(); tab.classList.remove("tab-drop-target");
      const draggedId = e.dataTransfer.getData("text/plain");
      if (draggedId === id) return;
      const fromIdx = sessionOrder.indexOf(draggedId); const toIdx = sessionOrder.indexOf(id);
      if (fromIdx === -1 || toIdx === -1) return;
      sessionOrder.splice(fromIdx, 1); sessionOrder.splice(toIdx, 0, draggedId);
      rebuildTabs();
      if (activeSession === "all") rebuildView();
    });

    tabBar.appendChild(tab);
    tabIdx++;
  }

  // In minimal mode, no extra buttons in tab bar (they're in topbar)
  if (isMinimalMode()) {}
}

function switchSession(id) {
  activeSession = id;
  const dot = tabBar.querySelector(`[data-session="${id}"] .tab-dot`);
  if (dot) dot.classList.remove("has-activity");
  // Sync gravity map session filter with active tab
  if (Gravity.setSessionFilter) Gravity.setSessionFilter(id === "all" ? "all" : id);
  if (momentumInitialized) Momentum.setSessionFilter(id === "all" ? "all" : id);
  rebuildTabs();
  rebuildView();
  updateGridControlsVisibility();
}

function removeSession(id) {
  sessions.delete(id);
  sessionOrder = sessionOrder.filter(s => s !== id);
  for (let i = entries.length - 1; i >= 0; i--) { if (entries[i].sessionId === id) entries.splice(i, 1); }
  if (activeSession === id) activeSession = "all";
  if (Gravity.unregisterSession) Gravity.unregisterSession(id);
  if (momentumInitialized) Momentum.unregisterSession(id);
  rebuildTabs();
  rebuildView();
}

function pruneSessionTab(id) {
  // Mark as stale instead of removing — keep session and entries intact
  const sInfo = sessions.get(id);
  if (sInfo) sInfo.stale = true;
  rebuildTabs();
}

function reconcileSessions(serverList) {
  const serverIds = new Set(serverList.map(s => s.id));
  let changed = false;
  // Mark sessions not in server's list as stale (don't delete)
  for (const id of [...sessions.keys()]) {
    if (!serverIds.has(id)) {
      const sInfo = sessions.get(id);
      if (sInfo && !sInfo.stale) { sInfo.stale = true; changed = true; }
    }
  }
  // Add missing sessions from server
  for (const s of serverList) {
    if (!sessions.has(s.id)) {
      const sColor = nextSessionColor();
      sessions.set(s.id, { label: s.label, count: 0, color: sColor, lastEventTs: null });
      if (Gravity.registerSession) Gravity.registerSession(s.id, s.label, sColor);
      changed = true;
    }
  }
  if (changed) {
    rebuildTabs();
    rebuildView();
  }
}

setInterval(rebuildTabs, 30000);

// ===== Lock (window pinning) =====
// Lock ON = window stays visible, fades on blur. Lock OFF = window hides on blur.
let locked = true; // default: locked (window stays)

window.toggleLock = () => {
  locked = !locked;
  // Sync both lock checkboxes
  document.querySelectorAll("#lock-toggle, #lock-toggle-mini, #lock-toggle-popover").forEach(el => {
    if (el.checked !== locked) el.checked = locked;
  });
  // Auto-hide is the inverse of lock
  if (window.webkit?.messageHandlers?.autoHide) {
    window.webkit.messageHandlers.autoHide.postMessage(!locked);
  }
};

// Backward compat: native app calls toggleAutoHide via ⌘⇧H
window.toggleAutoHide = window.toggleLock;

function scrollAllToBottom() { for (const p of panes.values()) p.scrollEl.scrollTop = p.scrollEl.scrollHeight; }

// ===== Actions =====
window.collapseAll = () => { /* no-op: entries don't expand inline anymore */ };

// ===== Expand/Collapse All =====
let allExpanded = false;

window.toggleExpandAll = () => {
  allExpanded = !allExpanded;
  const btn = document.getElementById("expand-all-btn");
  btn.textContent = allExpanded ? "Collapse All" : "Expand All";

  // Toggle all task, query, and agent groups
  document.querySelectorAll(".task-body").forEach(el => {
    el.classList.toggle("collapsed", !allExpanded);
  });
  document.querySelectorAll(".query-actions").forEach(el => {
    el.classList.toggle("collapsed", !allExpanded);
  });
  document.querySelectorAll(".agent-children").forEach(el => {
    el.classList.toggle("collapsed", !allExpanded);
  });
  document.querySelectorAll(".task-chevron, .query-chevron, .agent-chevron").forEach(el => {
    el.textContent = allExpanded ? "\u25BC" : "\u25B6";
  });

  // Update collapsed state in data model
  for (const gs of sessionGroups.values()) {
    for (const task of gs.tasks) {
      task.collapsed = !allExpanded;
      for (const query of task.queries) {
        query.collapsed = !allExpanded;
      }
    }
  }
};

// ===== Replay Analysis =====
let replayAbort = null;      // current AbortController
let replaySessionId = null;  // session being analyzed
let replayAnalyzing = false;
let replayRawMarkdown = null; // raw analysis text for export

window.requestReplayAnalysis = async () => {
  const btn = document.getElementById("replay-btn");
  const sid = activeSession === "all" ? (sessions.keys().next().value || null) : activeSession;
  if (!sid) return;

  btn.classList.add("loading");
  btn.disabled = true;
  btn.textContent = "Analyzing...";

  openReplayPopover(sid);
  await runReplayAnalysis(sid);

  btn.classList.remove("loading");
  btn.disabled = false;
  btn.textContent = "Replay";
};

async function runReplayAnalysis(sid) {
  // Cancel any in-flight analysis
  if (replayAbort) replayAbort.abort();
  replayAbort = new AbortController();
  replaySessionId = sid;
  replayAnalyzing = true;
  updateReplayActionBtn();

  const scroll = document.getElementById("replay-analysis-scroll");
  scroll.innerHTML = '<div class="replay-loading">Analyzing session...</div>';

  // Fetch timeline (not cancellable — fast)
  const timelinePromise = fetch("/api/session-timeline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid }),
  }).then(r => r.json()).catch(() => ({ timeline: [] }));

  // Fetch analysis (cancellable)
  const analysisPromise = fetch("/api/replay-analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid }),
    signal: replayAbort.signal,
  }).then(r => r.json()).catch(err => {
    if (err.name === "AbortError") return { cancelled: true };
    return { error: `Request failed: ${err.message}` };
  });

  try {
    const tlData = await timelinePromise;
    renderReplayTimeline(tlData.timeline || [], tlData.totalEntries || 0);
  } catch {}

  const data = await analysisPromise;
  replayAnalyzing = false;
  updateReplayActionBtn();

  if (data.cancelled) {
    replayRawMarkdown = null;
    scroll.innerHTML = '<div class="replay-error" style="color:var(--text-muted)">Analysis cancelled.</div>';
  } else if (data.error) {
    replayRawMarkdown = null;
    scroll.innerHTML = `<div class="replay-error">${esc(data.error)}</div>`;
  } else {
    replayRawMarkdown = data.analysis;
    scroll.innerHTML = `<div class="replay-content">${renderMarkdown(data.analysis)}</div>`;
  }
  updateExportBtn();
}

window.cancelReplayAnalysis = function() {
  if (replayAbort) { replayAbort.abort(); replayAbort = null; }
};

window.restartReplayAnalysis = function() {
  if (!replaySessionId) return;
  runReplayAnalysis(replaySessionId);
};

function updateReplayActionBtn() {
  const btn = document.getElementById("replay-action-btn");
  if (!btn) return;
  if (replayAnalyzing) {
    btn.textContent = "Cancel";
    btn.title = "Cancel analysis";
    btn.onclick = cancelReplayAnalysis;
    btn.className = "replay-action-btn replay-action-cancel";
  } else {
    btn.textContent = "Restart";
    btn.title = "Re-run analysis";
    btn.onclick = restartReplayAnalysis;
    btn.className = "replay-action-btn replay-action-restart";
  }
}

function updateExportBtn() {
  const btn = document.getElementById("replay-export-btn");
  if (!btn) return;
  btn.disabled = !replayRawMarkdown;
  btn.style.opacity = replayRawMarkdown ? "1" : "0.4";
}

window.exportReplayMd = function() {
  if (!replayRawMarkdown) return;
  const sInfo = replaySessionId ? sessions.get(replaySessionId) : null;
  const label = sInfo ? sInfo.label : "session";
  const date = new Date().toISOString().slice(0, 10);
  const filename = `replay-${label}-${date}.md`;

  const blob = new Blob([replayRawMarkdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

function openReplayPopover(sessionId) {
  const overlay = document.getElementById("replay-popover-overlay");
  const sessionLabel = document.getElementById("replay-session-label");
  const archetypeBadge = document.getElementById("replay-archetype-badge");
  const timelineScroll = document.getElementById("replay-timeline-scroll");
  const analysisScroll = document.getElementById("replay-analysis-scroll");
  const riskMeter = document.getElementById("replay-risk-meter");

  // Reset content
  replayRawMarkdown = null;
  timelineScroll.innerHTML = '<div class="replay-loading">Loading timeline...</div>';
  analysisScroll.innerHTML = '<div class="replay-loading">Analyzing session...</div>';
  updateExportBtn();

  // Session label
  const sInfo = sessions.get(sessionId);
  sessionLabel.textContent = sInfo ? sInfo.label : sessionId.slice(0, 12);

  // Behavioral signature data from Momentum
  const sig = Momentum.getSignature ? Momentum.getSignature(sessionId) : null;
  if (sig && sig.archetype) {
    archetypeBadge.textContent = sig.archetype.replace(/-/g, " ");
    archetypeBadge.style.display = "";
  } else {
    archetypeBadge.style.display = "none";
  }

  // Risk meter
  if (sig) {
    const risk = Math.round(sig.riskScore * 100);
    let barColor;
    if (sig.riskScore < 0.3) barColor = "#06b6d4";
    else if (sig.riskScore < 0.6) barColor = "#eab308";
    else barColor = "#ef4444";
    riskMeter.innerHTML = `
      <span class="risk-label">risk ${risk}%</span>
      <div class="risk-bar"><div class="risk-fill" style="width:${risk}%;background:${barColor}"></div></div>
    `;
  } else {
    riskMeter.innerHTML = "";
  }

  overlay.style.display = "";
}

window.closeReplayPopover = function() {
  document.getElementById("replay-popover-overlay").style.display = "none";
};

function renderReplayTimeline(timeline, totalEntries) {
  const scroll = document.getElementById("replay-timeline-scroll");
  if (!timeline || timeline.length === 0) {
    scroll.innerHTML = '<div class="replay-loading" style="animation:none">No timeline data available</div>';
    return;
  }

  const frag = document.createDocumentFragment();

  for (const item of timeline) {
    const div = document.createElement("div");
    div.className = `tl-entry tl-${item.type}`;

    const num = document.createElement("span");
    num.className = "tl-num";
    num.textContent = item.n;
    div.appendChild(num);

    const badge = document.createElement("span");
    badge.className = `tl-badge tl-badge-${item.type}`;
    if (item.type === "user") badge.textContent = "Q";
    else if (item.type === "think") badge.textContent = "T";
    else if (item.type === "tool") badge.textContent = item.tool || "USE";
    else if (item.type === "error") badge.textContent = "ERR";
    else badge.textContent = "TXT";
    div.appendChild(badge);

    const text = document.createElement("span");
    text.className = "tl-text";
    let displayText = item.text || item.detail || "";
    // Shorten file paths to basename for readability
    displayText = displayText.replace(/\/[\w./-]+\/([\w.-]+)/g, "$1");
    text.textContent = displayText;
    text.title = item.text || item.detail || ""; // full path in tooltip
    div.appendChild(text);

    frag.appendChild(div);
  }

  // Summary at top
  const summary = document.createElement("div");
  summary.className = "tl-entry";
  summary.style.cssText = "padding:8px 10px;color:var(--text-muted);border-bottom:1px solid var(--border,rgba(255,255,255,0.06));margin-bottom:4px";
  const userCount = timeline.filter(t => t.type === "user").length;
  const toolCount = timeline.filter(t => t.type === "tool").length;
  const errCount = timeline.filter(t => t.type === "error").length;
  summary.innerHTML = `<span style="font-size:10px">${totalEntries} entries &middot; ${userCount} queries &middot; ${toolCount} tools${errCount ? ` &middot; <span style="color:#ef4444">${errCount} errors</span>` : ""}</span>`;

  scroll.innerHTML = "";
  scroll.appendChild(summary);
  scroll.appendChild(frag);
}

function renderMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^(\s*)(█+░*)\s*(.*)$/gm, '<div style="font-family:monospace;font-size:10px;color:var(--text-muted)">$1<span style="color:#06b6d4">$2</span> $3</div>')
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n- /g, "<br>• ")
    .replace(/\n(\d+)\. /g, "<br>$1. ");
}

// Legacy modal fallback (kept for non-popover contexts)
function showReplayModal(html) {
  modalOverlay.classList.add("modal-replay");
  modalBadge.className = "modal-badge cat-thinking";
  modalBadge.textContent = "REPLAY";
  modalTool.textContent = "Session Analysis";
  modalTime.textContent = formatTime(Date.now());
  modalPanel.classList.remove("modal-thinking");
  modalBody.innerHTML = html;
  modalOverlay.classList.add("visible");
}

window.clearLogs = () => {
  if (activeSession === "all") {
    // Clear everything
    entries.length = 0;
    lineCounter = 0;
    firstEventTs = null;
    sessions.clear();
    sessionGroups.clear();
    childSessionMap.clear();
    pendingAgentSpawns.clear();
    taskIdCounter = 0;
    queryIdCounter = 0;
    colorIdx = 0;
    rebuildTabs();
    rebuildPanes();
    lineCountEl.textContent = "0";
  } else {
    // Clear only the active session
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].sessionId === activeSession) entries.splice(i, 1);
    }
    sessionGroups.delete(activeSession);
    rebuildView();
  }
};

function scrollToBottom() { scrollAllToBottom(); }

window.jumpToBottom = () => {
  autoScroll = true;
  for (const p of panes.values()) p.autoScroll = true;
  scrollAllToBottom();
  scrollFab.classList.remove("visible");
};

// ===== Session cycling =====
function getSessionList() { syncSessionOrder(); return ["all", ...sessionOrder]; }

function cycleSession(dir) {
  const list = getSessionList();
  if (list.length <= 1) return;
  const idx = list.indexOf(activeSession);
  switchSession(list[(idx + dir + list.length) % list.length]);
}

// ===== Help overlay =====
let helpVisible = false;
function toggleHelp() {
  helpVisible = !helpVisible;
  let overlay = document.getElementById("help-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "help-overlay";
    overlay.innerHTML = `
      <div class="help-panel">
        <div class="help-title">Keyboard Shortcuts</div>
        <div class="help-grid">
          <div class="help-section">
            <div class="help-section-title">Navigation</div>
            <div class="help-row"><kbd>j</kbd> <kbd>k</kbd> <span>Move up / down</span></div>
            <div class="help-row"><kbd>Enter</kbd> <span>Open detail</span></div>
            <div class="help-row"><kbd>g</kbd> <span>Jump to bottom</span></div>
            <div class="help-row"><kbd>/</kbd> <span>Search</span></div>
            <div class="help-row"><kbd>Esc</kbd> <span>Close / clear</span></div>
          </div>
          <div class="help-section">
            <div class="help-section-title">Sessions</div>
            <div class="help-row"><kbd>\u2318</kbd><kbd>\u2325</kbd><kbd>\u2190</kbd><kbd>\u2192</kbd> <span>Prev / next</span></div>
            <div class="help-row"><kbd>0</kbd> <span>All sessions</span></div>
            <div class="help-row"><kbd>1</kbd>-<kbd>9</kbd> <span>Jump to session</span></div>
          </div>
          <div class="help-section">
            <div class="help-section-title">Actions</div>
            <div class="help-row"><kbd>e</kbd> <span>Toggle errors</span></div>
            <div class="help-row"><kbd>&#8984;</kbd><kbd>T</kbd> <span>Toggle theme</span></div>
            <div class="help-row"><kbd>&#8984;</kbd><kbd>+</kbd><kbd>-</kbd> <span>Zoom</span></div>
            <div class="help-row"><kbd>&#8984;</kbd><kbd>&#8679;</kbd><kbd>+</kbd><kbd>-</kbd> <span>Columns</span></div>
            <div class="help-row"><kbd>?</kbd> <span>This help</span></div>
          </div>
        </div>
      </div>
    `;
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) toggleHelp(); });
    document.body.appendChild(overlay);
  }
  overlay.style.display = helpVisible ? "flex" : "none";
}

// ===== Keyboard =====
document.addEventListener("keydown", (e) => {
  // Actively handle Cmd+C for webview contexts where native copy is blocked
  if ((e.metaKey || e.ctrlKey) && e.key === "c") {
    const sel = window.getSelection();
    if (sel && sel.toString()) {
      e.preventDefault();
      copyToClipboard(sel.toString());
    }
    return;
  }
  // Let other standard editing shortcuts through
  if ((e.metaKey || e.ctrlKey) && ["v","x","a","z"].includes(e.key)) return;

  if ((e.metaKey && e.altKey) || (e.ctrlKey && e.altKey)) {
    if (e.key === "ArrowLeft") { e.preventDefault(); cycleSession(-1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); cycleSession(1); return; }
  }

  // Modal open: Esc closes it
  if (modalOverlay.classList.contains("visible")) {
    if (e.key === "Escape") { closeModal(); return; }
    return; // Don't process other keys while modal is open
  }

  const inSearch = document.activeElement === searchInput;

  // Let standard text editing shortcuts through when in search input
  if (inSearch && (e.metaKey || e.ctrlKey) && ["v","c","x","a","z"].includes(e.key)) return;

  if (e.key === "?" && !inSearch) { toggleHelp(); return; }
  if (e.key === "m" && !inSearch) { toggleView(); return; }
  if (e.key === "n" && e.metaKey && e.shiftKey) { e.preventDefault(); setMapMode(mapMode === "files" ? "flow" : "files"); return; }
  if (e.key === "t" && e.metaKey) { e.preventDefault(); toggleTheme(); return; }
  if ((e.key === "=" || e.key === "+") && e.metaKey && e.shiftKey) { e.preventDefault(); if (gravityView) Gravity.zoom(1.2); return; }
  if ((e.key === "-" || e.key === "_") && e.metaKey && e.shiftKey) { e.preventDefault(); if (gravityView) Gravity.zoom(0.8); return; }
  if ((e.key === "=" || e.key === "+") && e.metaKey) { e.preventDefault(); adjustFontSize(1); return; }
  if (e.key === "-" && e.metaKey) { e.preventDefault(); adjustFontSize(-1); return; }
  if (e.key === "Escape") {
    const replayOverlay = document.getElementById("replay-popover-overlay");
    if (replayOverlay && replayOverlay.style.display !== "none") { closeReplayPopover(); return; }
    if (helpVisible) { toggleHelp(); return; }
    if (gravityView) { Gravity.deselect(); return; }
    searchInput.blur(); searchInput.value = ""; searchQuery = ""; rebuildView(); return;
  }
  if (e.key === "/" && !inSearch) { e.preventDefault(); searchInput.focus(); return; }
  if (inSearch) return;

  const firstPane = panes.values().next().value;
  if (!firstPane) return;
  const visible = [...firstPane.scrollEl.querySelectorAll(".log-entry")];

  if (e.key === "j" || e.key === "ArrowDown") { if (!visible.length) return; e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, visible.length - 1); focusEntry(visible, selectedIdx); }
  if (e.key === "k" || e.key === "ArrowUp") { if (!visible.length) return; e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); focusEntry(visible, selectedIdx); }
  if (e.key === "Enter") { if (selectedIdx < 0 || !visible[selectedIdx]) return; e.preventDefault(); openModal(parseInt(visible[selectedIdx].dataset.id)); }
  if (e.key === "e") {
    // Toggle: show only errors vs show all
    if (hiddenTypes.size === 0) {
      FILTER_TYPES.forEach(ft => { if (ft.key !== "error") hiddenTypes.add(ft.key); });
    } else {
      hiddenTypes.clear();
    }
    buildFilterMenu();
    updateFilterLabel();
    rebuildView();
  }
  if (e.key === "g") { jumpToBottom(); }
  if (e.key === "1") { switchSession("all"); }
  if (e.key >= "2" && e.key <= "9") { const idx = parseInt(e.key) - 2; const ids = sessionOrder; if (idx < ids.length) switchSession(ids[idx]); }
});

function focusEntry(visible, idx) {
  visible.forEach(el => el.classList.remove("kb-focus"));
  if (visible[idx]) { visible[idx].classList.add("kb-focus"); visible[idx].scrollIntoView({ block: "nearest" }); }
}


// ===== Theme toggle =====
const themeBtn = document.getElementById("theme-toggle");
const themeBtnMini = document.getElementById("theme-toggle-mini");

function toggleTheme() {
  const current = document.documentElement.dataset.theme || "dark";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("loupe-theme", theme);
  // Update aria-labels
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  if (themeBtn) themeBtn.setAttribute("aria-label", label);
  if (themeBtnMini) themeBtnMini.setAttribute("aria-label", label);
  // Notify native macOS app to update window chrome
  if (window.webkit?.messageHandlers?.themeChange) {
    window.webkit.messageHandlers.themeChange.postMessage(theme);
  }
}

// Set initial state and bind click
if (themeBtn) {
  themeBtn.addEventListener("click", (e) => { e.preventDefault(); toggleTheme(); });
  const initialTheme = document.documentElement.dataset.theme || "dark";
  if (window.webkit?.messageHandlers?.themeChange) {
    window.webkit.messageHandlers.themeChange.postMessage(initialTheme);
  }
}

// ===== Font Size =====
function adjustFontSize(delta) {
  const current = parseFloat(localStorage.getItem("loupe-zoom") || "100");
  const step = delta * 10;
  const next = Math.min(150, Math.max(60, current + step));
  localStorage.setItem("loupe-zoom", next);
  applyZoom(next);
}

function applyZoom(pct) {
  document.querySelectorAll(".log-scroll").forEach(el => { el.style.zoom = (pct / 100).toString(); });
}

// ===== Mode switching (compact ↔ full) =====
window.toggleMode = () => {
  const mode = isMinimalMode() ? "window" : "menubar";
  if (window.webkit?.messageHandlers?.switchMode) {
    window.webkit.messageHandlers.switchMode.postMessage(mode);
  }
};

if (themeBtnMini) {
  themeBtnMini.addEventListener("click", (e) => { e.preventDefault(); toggleTheme(); });
}

// When mode changes, rebuild UI
function onModeChange() {
  rebuildTabs();
  rebuildView();
}

// Watch for body class changes (Swift toggles 'minimal')
new MutationObserver(() => onModeChange()).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// ===== Map Mode (Files / Flow) =====
let mapMode = "files"; // "files" | "flow"
let momentumInitialized = false;
const momentumCanvas = document.getElementById("momentum-canvas");

window.setMapMode = (mode) => {
  mapMode = mode;
  // Open the map section if not already open
  if (!gravityView) { toggleView(); return; } // toggleView will call setMapMode(mapMode) on open
  document.querySelectorAll(".mode-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === mode)
  );
  if (mode === "files") {
    gravityCanvas.style.display = "";
    momentumCanvas.style.display = "none";
    // Show gravity-specific UI
    document.getElementById("universe-filter-bar").style.display = "";
    document.querySelector(".recency-filter-bar").style.display = "";
    document.getElementById("gravity-sliders").style.display = "";
    document.getElementById("momentum-sliders").style.display = "none";
  } else {
    // Initialize momentum on first use
    if (!momentumInitialized) {
      Momentum.init(momentumCanvas);
      // Register all known sessions before processing entries
      for (const [id, info] of sessions) {
        Momentum.registerSession(id, info.label, info.color);
      }
      Momentum.addEntries(entries);
      momentumInitialized = true;
      Momentum.setOnSessionFilterChange((id) => { switchSession(id); });
      Momentum.setOnClickSpan((entryId) => { openModal(entryId); });
    }
    // Sync momentum session filter with current active session
    Momentum.setSessionFilter(activeSession === "all" ? "all" : activeSession);
    gravityCanvas.style.display = "none";
    momentumCanvas.style.display = "";
    // Hide gravity-specific UI, show momentum UI
    document.getElementById("universe-filter-bar").style.display = "none";
    document.querySelector(".recency-filter-bar").style.display = "none";
    document.getElementById("gravity-sliders").style.display = "none";
    document.getElementById("momentum-sliders").style.display = "";
  }
};

// ===== Universe Map View =====
let gravityView = false;
let gravityInitialized = false;
const gravityCanvas = document.getElementById("gravity-canvas");
const gravityContainer = document.getElementById("gravity-container");
const gravityTooltip = document.getElementById("gravity-tooltip");
const viewToggleBtn = document.getElementById("view-toggle-btn");

let mapPopoverOpen = false;
const mapDivider = document.getElementById("map-divider");

window.toggleView = () => {
  gravityView = !gravityView;
  document.querySelectorAll("#view-toggle-btn, #view-toggle-btn-mini").forEach(el => {
    el.classList.toggle("active", gravityView);
  });
  if (gravityView) {
    if (!gravityInitialized) {
      Gravity.init(gravityCanvas);
      Gravity.addEntries(entries);
      gravityInitialized = true;
      Gravity.setOnSessionFilterChange((filter) => {
        if (filter instanceof Set) {
          // Multi-select: sync momentum without switching app tabs
          if (momentumInitialized) Momentum.setSessionFilter(filter);
        } else {
          switchSession(filter);
        }
      });
    }
    gravityContainer.style.display = "";
    gravityContainer.style.flex = "0 0 35%";
    gravityContainer.style.minHeight = "120px";
    mapDivider.style.display = "";
    // Restore the mode the user was on before closing
    setMapMode(mapMode);
  } else {
    if (mapPopoverOpen) toggleMapPopover();
    gravityContainer.style.display = "none";
    mapDivider.style.display = "none";
    // Don't reset mapMode — remember it for when the map reopens
  }
};

// Map-session divider drag
mapDivider.addEventListener("mousedown", (e) => {
  e.preventDefault();
  document.body.style.userSelect = "none";
  document.body.style.cursor = "row-resize";
  const app = document.getElementById("app");
  const appRect = app.getBoundingClientRect();
  // Header height = top of gravityContainer relative to app
  const headerH = gravityContainer.getBoundingClientRect().top - appRect.top;

  function onMove(ev) {
    const mapH = Math.max(120, Math.min(ev.clientY - appRect.top - headerH, appRect.height - headerH - 100));
    gravityContainer.style.flex = `0 0 ${mapH}px`;
  }
  function onUp() {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

window.toggleMapPopover = () => {
  const overlay = document.getElementById("map-popover-overlay");
  const popover = document.getElementById("map-popover");
  mapPopoverOpen = !mapPopoverOpen;

  if (mapPopoverOpen) {
    // Move gravity container into popover
    popover.insertBefore(gravityContainer, popover.firstChild);
    gravityContainer.style.flex = "1";
    gravityContainer.style.minHeight = "";
    gravityContainer.style.display = "";
    overlay.style.display = "";
    mapDivider.style.display = "none";
  } else {
    // Move gravity container back to #app (before divider)
    const app = document.getElementById("app");
    app.insertBefore(gravityContainer, mapDivider);
    gravityContainer.style.flex = "0 0 35%";
    gravityContainer.style.minHeight = "120px";
    overlay.style.display = "none";
    mapDivider.style.display = "";
  }
};

// Old tooltip removed — canvas mini card in gravity.js replaces it

// ===== Init =====
connect();
