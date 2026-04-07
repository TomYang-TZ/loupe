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
const entriesById = new Map(); // O(1) lookup for modal
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

// ===== Status Bar State =====
const statusBar = {
  sessionState: "idle",     // "active" | "waiting" | "idle" | "compacting"
  sessionStartTs: null,
  waitingTool: null,
  errors: 0,                // per-turn error count
  apiError: null,           // from StopFailure
  agentsRunning: 0,
  agentsTotal: 0,
  agentsFadeTimer: null,
  tasksCreated: 0,
  tasksCompleted: 0,
};
let statusBarTimer = null;

function updateStatusBar() {
  const sessionSeg = document.getElementById("status-session");
  const sessionDot = document.getElementById("status-session-dot");
  const sessionText = document.getElementById("status-session-text");
  const healthSeg = document.getElementById("status-health");
  const healthText = document.getElementById("status-health-text");
  const agentsSeg = document.getElementById("status-agents");
  const agentsText = document.getElementById("status-agents-text");
  const tasksSeg = document.getElementById("status-tasks");
  const tasksText = document.getElementById("status-tasks-text");

  if (!sessionSeg) return;

  // 1. Session state
  sessionDot.className = "status-dot";
  if (statusBar.sessionState === "active") {
    sessionDot.classList.add("green");
    let label = "Active";
    if (statusBar.sessionStartTs) {
      const secs = Math.floor((Date.now() - statusBar.sessionStartTs) / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      label += " \u00b7 " + m + "m" + String(s).padStart(2, "0") + "s";
    }
    sessionText.textContent = label;
  } else if (statusBar.sessionState === "done") {
    sessionDot.classList.add("green");
    sessionText.textContent = "Done";
  } else if (statusBar.sessionState === "waiting") {
    sessionDot.classList.add("amber", "pulse");
    sessionText.textContent = "Waiting: " + (statusBar.waitingTool || "approval");
  } else if (statusBar.sessionState === "compacting") {
    sessionDot.classList.add("amber", "pulse");
    sessionText.textContent = "Compacting\u2026";
  } else {
    sessionText.textContent = "Idle";
  }

  // 2. Health
  if (statusBar.errors > 0 || statusBar.apiError) {
    healthSeg.style.display = "";
    healthText.textContent = statusBar.apiError || ("Errors: " + statusBar.errors);
  } else {
    healthSeg.style.display = "none";
  }

  // 3. Agents
  if (statusBar.agentsRunning > 0 || statusBar.agentsTotal > 0) {
    agentsSeg.style.display = "";
    if (statusBar.agentsRunning > 0) {
      const done = statusBar.agentsTotal - statusBar.agentsRunning;
      agentsText.textContent = done > 0
        ? "Agents: " + done + "/" + statusBar.agentsTotal + " done"
        : "Agents: " + statusBar.agentsRunning + " running";
    } else {
      agentsText.textContent = "Agents: " + statusBar.agentsTotal + "/" + statusBar.agentsTotal + " done";
    }
  } else {
    agentsSeg.style.display = "none";
  }

  // 4. Tasks
  if (statusBar.tasksCreated > 0) {
    tasksSeg.style.display = "";
    const allDone = statusBar.tasksCompleted >= statusBar.tasksCreated;
    tasksText.textContent = "Tasks: " + statusBar.tasksCompleted + "/" + statusBar.tasksCreated + (allDone ? " \u2713" : "");
  } else {
    tasksSeg.style.display = "none";
  }
}

function updateStatusBarFromEntry(entry) {
  const cat = entry.category;

  if (cat === "session_start") {
    statusBar.sessionState = "active";
    statusBar.sessionStartTs = entry.ts;
    if (statusBarTimer) clearInterval(statusBarTimer);
    statusBarTimer = setInterval(updateStatusBar, 1000);
  }
  if (cat === "session_end") {
    statusBar.sessionState = "idle";
    if (statusBarTimer) { clearInterval(statusBarTimer); statusBarTimer = null; }
  }
  if (cat === "compact") {
    const hook = LoupeParse.unwrapHook(entry.json);
    if (hook?.hookType === "PreCompact") statusBar.sessionState = "compacting";
    if (hook?.hookType === "PostCompact") statusBar.sessionState = "active";
  }
  if (cat === "permission_request") {
    statusBar.sessionState = "waiting";
    statusBar.waitingTool = entry.title || "approval";
  }
  if (statusBar.sessionState === "waiting" && (cat === "tool_use" || cat === "post_tool" || cat === "sub_agent" || cat === "thinking" || cat === "user_query" || cat === "tool_rejected")) {
    statusBar.sessionState = "active";
    statusBar.waitingTool = null;
  }
  if (cat === "user_query") {
    statusBar.errors = 0;
    statusBar.apiError = null;
    statusBar.sessionState = "active";
    statusBar.sessionStartTs = statusBar.sessionStartTs || entry.ts;
    if (!statusBarTimer) statusBarTimer = setInterval(updateStatusBar, 1000);
  }
  if (cat === "tool_failure") statusBar.errors++;
  if (cat === "stop_failure") {
    const hook = LoupeParse.unwrapHook(entry.json);
    const inner = hook?.inner || {};
    statusBar.apiError = inner.reason || inner.error_type || "API error";
  }
  if (cat === "sub_agent") {
    statusBar.agentsRunning++;
    statusBar.agentsTotal++;
    if (statusBar.agentsFadeTimer) { clearTimeout(statusBar.agentsFadeTimer); statusBar.agentsFadeTimer = null; }
  }
  if (cat === "sub_agent_result") {
    statusBar.agentsRunning = Math.max(0, statusBar.agentsRunning - 1);
    if (statusBar.agentsRunning === 0) {
      statusBar.agentsFadeTimer = setTimeout(() => {
        statusBar.agentsTotal = 0;
        updateStatusBar();
      }, 5000);
    }
  }
  if (cat === "task_created") statusBar.tasksCreated++;
  if (cat === "task_completed") statusBar.tasksCompleted++;
  if (cat === "Notification" && statusBar.sessionState !== "waiting") {
    statusBar.sessionState = "waiting";
  }
  if (cat === "Stop") {
    statusBar.sessionState = "done"; statusBar.waitingTool = null;
    setTimeout(() => { if (statusBar.sessionState === "done") { statusBar.sessionState = "idle"; updateStatusBar(); } }, 10000);
  }

  updateStatusBar();
}

// ===== Sub-agent Session Mapping =====
// When Agent tool fires, parent session spawns a sub-agent with its own session_id.
// Map child session_ids back to parent so they nest correctly.
const childSessionMap = new Map();   // childSessionId -> parentSessionId
const pendingAgentSpawns = new Map(); // parentSessionId -> { ts, count }

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
  // Number sessions: 2:xxx, 3:xxx (1=All)
  const sessionIds = [...sessions.keys()];
  const sNum = sessionIds.indexOf(sessionId) + 2;
  const p = createPane(sessionId, `${sNum}:${info.label}`, info.color);
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
    // Single session or single-session All: one pane
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
    // Multi-session All: use Tiling with vertical splits (stacked)
    syncSessionOrder();
    paneContainer.classList.remove("grid-layout");

    const tilingIds = Tiling.getSessionIds();
    const currentIds = new Set(sessionOrder.filter(id => sessions.has(id)));
    const tilingSet = new Set(tilingIds);

    for (const id of currentIds) {
      if (!tilingSet.has(id)) Tiling.addSession(id, false, "v");
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
let isBacklog = true; // true until backlog_done received
let reconnectDelay = 500;

function connect() {
  const host = window.__LOGSTREAM_HOST || location.host;
  ws = new WebSocket(`ws://${host}/ws`);

  ws.onopen = () => { reconnectDelay = 500; isBacklog = true; setConnState("connected"); };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "reset") { resetAll(); return; }
    if (msg.type === "backlog_done") {
      isBacklog = false;
      // Finalize topic splits and rebuild panes
      LoupeGrouping.finalizeTopics();
      rebuildAllPaneContents();
      scrollToBottom();
      // Clear stale states from backlog replay
      LoupeIsland.normalizeBacklogState();
      // Normalize status bar after backlog
      if (["waiting", "done", "compacting"].includes(statusBar.sessionState)) statusBar.sessionState = "idle";
      statusBar.waitingTool = null;
      updateStatusBar();
      return;
    }
    if (msg.type === "show_window") {
      if (window.webkit?.messageHandlers?.showWindow) {
        window.webkit.messageHandlers.showWindow.postMessage(true);
      }
      return;
    }
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
  const wrap = document.getElementById("conn-status-wrap");
  if (state === "connected") {
    if (wrap) wrap.style.display = "none";
  } else {
    if (wrap) wrap.style.display = "";
    connDot.className = `conn-dot ${state}`;
    connStatus.textContent = state;
  }
}

function resetAll() {
  entries.length = 0;
  entriesById.clear();
  lineCounter = 0;
  firstEventTs = null;
  sessions.clear();
  LoupeGrouping.reset();
  colorIdx = 0;
  if (momentumInitialized) Momentum.reset();
  rebuildTabs();
  rebuildPanes();
}

// ===== Render =====
function handleLine(msg) {
  lineCounter++;
  signalActivity();

  const category = LoupeParse.categorize(msg);
  if (category === null) return; // dedup: filtered out
  const title = LoupeParse.extractTitle(msg, category);
  const summary = LoupeParse.extractSummary(msg, category);
  const body = LoupeParse.extractBody(msg, category);
  let sessionId = LoupeParse.extractSessionId(msg);
  const sessionLabel = LoupeParse.extractSessionLabel(msg);
  const userQuery = LoupeParse.extractUserQuery(msg);
  const meta = LoupeParse.extractMeta(msg);
  const userImages = LoupeParse.extractUserImages(msg);
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

  // If this session_id isn't yet mapped, try to map it to a parent
  if (sessionId && !childSessionMap.has(sessionId)) {
    const lbl = (sessionLabel || "").toLowerCase();
    const sid = (sessionId || "").toLowerCase();
    const looksLikeAgent = lbl.startsWith("agent-") || lbl.startsWith("agent_") ||
                           sid.startsWith("agent-") || sid.startsWith("agent_");

    if (!sessions.has(sessionId)) {
      // Heuristic 1: match against pending agent spawns (within 60s)
      for (const [parentSid, info] of pendingAgentSpawns) {
        if (parentSid !== sessionId && msg.ts - info.ts < 60000) {
          childSessionMap.set(sessionId, parentSid);
          break;
        }
      }
    }
    // Heuristic 2: if session ID or label looks like a sub-agent (e.g., "agent-a1"),
    // map to the most recently active parent session (works during backlog too)
    if (!childSessionMap.has(sessionId) && looksLikeAgent) {
      let bestParent = null, bestTs = 0;
      for (const [parentId, info] of sessions) {
        if (parentId !== sessionId && info.lastEventTs > bestTs) { bestTs = info.lastEventTs; bestParent = parentId; }
      }
      if (bestParent) childSessionMap.set(sessionId, bestParent);
    }
  }

  // Remap child session to parent (preserve original for agent grouping)
  const originalSessionId = sessionId;
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

  const entry = { id: lineCounter, category, title, summary, body, raw: msg.data, json: msg.json, ts: msg.ts, sessionId, _originalSessionId: originalSessionId, userQuery, userImages, meta };
  entries.push(entry);
  entriesById.set(entry.id, entry);

  // Assign to task/query group
  LoupeGrouping.assignToGroup(entry);

  // Feed to universe renderer if initialized
  if (gravityInitialized) Gravity.addEntry(entry);
  if (momentumInitialized) Momentum.addEntry(entry);

  // Update Dynamic Island + status bar (skip during backlog to avoid rapid cycling)
  const wasWaiting = statusBar.sessionState === "waiting";
  if (!isBacklog) {
    LoupeIsland.updateIslandFromEntry(entry);
    updateStatusBarFromEntry(entry);
  }

  // Strikethrough the last tool_use entry if it was rejected
  // Only user_query and thinking are reliable rejection signals
  // (user_query fires as "[Request interrupted by user for tool use]" on reject)
  if (wasWaiting && (category === "user_query" || category === "thinking" || category === "tool_rejected")) {
    // Find the most recent tool_use entry and mark it rejected
    const rejectMsg = (category === "tool_rejected") ? (entry.json?.data?.message || null) : null;
    for (let i = entries.length - 1; i >= Math.max(0, entries.length - 20); i--) {
      if (entries[i].category === "tool_use" && entries[i].el) {
        entries[i].el.classList.add("rejected");
        if (rejectMsg) {
          const msgEl = document.createElement("span");
          msgEl.className = "reject-msg";
          msgEl.textContent = ` "${rejectMsg.slice(0, 50)}"`;
          entries[i].el.querySelector(".entry-row")?.appendChild(msgEl);
        }
        break;
      }
    }
  }

  // Approval with message — append to last tool_use entry
  if (category === "tool_approved_msg") {
    const approveMsg = entry.json?.data?.message || null;
    if (approveMsg) {
      for (let i = entries.length - 1; i >= Math.max(0, entries.length - 20); i--) {
        if (entries[i].category === "tool_use" && entries[i].el) {
          const msgEl = document.createElement("span");
          msgEl.className = "approve-msg";
          msgEl.textContent = ` "${approveMsg.slice(0, 50)}"`;
          entries[i].el.querySelector(".entry-row")?.appendChild(msgEl);
          break;
        }
      }
    }
  }

  const streamHidden = LoupeGrouping.streamHiddenCategories.has(entry.category) || LoupeGrouping.streamNoRenderCategories.has(entry.category);

  if (newSession && activeSession === "all" && sessions.size > 1) {
    rebuildPanes();
    rebuildAllPaneContents();
  } else if (entry.category === "topic_clear" || entry.category === "topic_shift") {
    // Topic events retroactively modify task groups — rebuild all panes
    if (!isBacklog) {
      LoupeGrouping.finalizeTopics();
      rebuildAllPaneContents();
    }
  } else if (!streamHidden && matchesAll(entry)) {
    LoupeRender.appendEntryGrouped(entry);
  }

  lineCountEl.textContent = lineCounter;
}

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
  if (!searchQuery) return LoupeUtils.esc(text);
  const escaped = LoupeUtils.esc(text);
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

// Debounced integrity rebuild — recovers from stale DOM references
let integrityRebuildTimer = null;
function scheduleIntegrityRebuild() {
  if (integrityRebuildTimer) return;
  integrityRebuildTimer = setTimeout(() => {
    integrityRebuildTimer = null;
    rebuildAllPaneContents();
  }, 200);
}

function rebuildAllPaneContents() {
  for (const p of panes.values()) p.scrollEl.innerHTML = "";

  // Clear DOM references in group state so they get re-created
  for (const gs of LoupeGrouping.sessionGroups.values()) {
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
      const r = LoupeRender.renderGroupedEntries(container, activeSession, 0);
      matchCount = r.matchCount;
    }
  } else if (sessions.size <= 1) {
    // Single session in "all" mode
    const sid = sessions.keys().next().value || "default";
    const container = panes.get("main")?.scrollEl;
    if (container) {
      const r = LoupeRender.renderGroupedEntries(container, sid, 0);
      matchCount = r.matchCount;
    }
  } else {
    // Multi-session "All": render per pane (Tiling handles layout)
    let topicOffset = 0;
    for (const [sid] of sessions) {
      const pane = panes.get(sid);
      if (pane) {
        const r = LoupeRender.renderGroupedEntries(pane.scrollEl, sid, topicOffset);
        matchCount += r.matchCount;
        topicOffset += r.topicCount;
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
      tab.innerHTML = `<span class="tab-label">${LoupeUtils.esc(info.label)}</span>`;
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
    tab.innerHTML = `<span class="tab-label">${LoupeUtils.esc(info.label)}</span>${shortcut}${staleLabel}<span class="tab-dot"></span><button class="tab-close" title="Remove">&times;</button>`;
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
  // Add missing sessions from server (skip agent sub-sessions)
  for (const s of serverList) {
    if (sessions.has(s.id) || childSessionMap.has(s.id)) continue;
    const sid = (s.id || "").toLowerCase();
    const slbl = (s.label || "").toLowerCase();
    if (sid.startsWith("agent-") || sid.startsWith("agent_") || slbl.startsWith("agent-") || slbl.startsWith("agent_")) {
      // Map agent session to most recent parent
      let bestParent = null, bestTs = 0;
      for (const [parentId, info] of sessions) {
        if (parentId !== s.id && (info.lastEventTs || 0) > bestTs) { bestTs = info.lastEventTs || 0; bestParent = parentId; }
      }
      if (bestParent) { childSessionMap.set(s.id, bestParent); continue; }
    }
    const sColor = nextSessionColor();
    sessions.set(s.id, { label: s.label, count: 0, color: sColor, lastEventTs: null });
    if (Gravity.registerSession) Gravity.registerSession(s.id, s.label, sColor);
    changed = true;
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

  // Update collapsed state in data model and rebuild to ensure DOM is consistent
  for (const gs of LoupeGrouping.sessionGroups.values()) {
    for (const task of gs.tasks) {
      task.collapsed = !allExpanded;
      for (const query of task.queries) {
        query.collapsed = !allExpanded;
      }
    }
  }
  rebuildAllPaneContents();
};

window.clearLogs = () => {
  if (activeSession === "all") {
    // Clear everything
    entries.length = 0;
    entriesById.clear();
    lineCounter = 0;
    firstEventTs = null;
    sessions.clear();
    LoupeGrouping.reset();
    childSessionMap.clear();
    pendingAgentSpawns.clear();
    colorIdx = 0;
    rebuildTabs();
    rebuildPanes();
    lineCountEl.textContent = "0";
  } else {
    // Clear only the active session
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].sessionId === activeSession) entries.splice(i, 1);
    }
    LoupeGrouping.sessionGroups.delete(activeSession);
    rebuildView();
  }
};

function scrollToBottom() { scrollAllToBottom(); }

window.stopServer = (() => {
  let armed = false;
  let timer = null;
  return () => {
    const btn = document.getElementById("stop-btn");
    if (armed) {
      armed = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (btn) { btn.textContent = "⏻"; btn.style.background = ""; }
      const host = window.__LOGSTREAM_HOST || location.host;
      fetch(`http://${host}/stop`).catch(() => {});
    } else {
      armed = true;
      if (btn) { btn.textContent = "Stop?"; btn.style.background = "#e55"; btn.style.color = "#fff"; }
      timer = setTimeout(() => {
        armed = false;
        if (btn) { btn.textContent = "⏻"; btn.style.background = ""; btn.style.color = "#e55"; }
      }, 2000);
    }
  };
})();


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
      LoupeRender.copyToClipboard(sel.toString());
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
    if (e.key === "Escape") { LoupeModal.closeModal(); return; }
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
  if (e.key === "Enter") { if (selectedIdx < 0 || !visible[selectedIdx]) return; e.preventDefault(); LoupeModal.openModal(parseInt(visible[selectedIdx].dataset.id)); }
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

// ===== Mode switching (compact <-> full) =====
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
    const filterBar = document.getElementById("universe-filter-bar");
    const recencyBar = document.querySelector(".recency-filter-bar");
    const gravSliders = document.getElementById("gravity-sliders");
    const momSliders = document.getElementById("momentum-sliders");
    if (filterBar) filterBar.style.display = "";
    if (recencyBar) recencyBar.style.display = "";
    if (gravSliders) gravSliders.style.display = "";
    if (momSliders) momSliders.style.display = "none";
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
      Momentum.setOnClickSpan((entryId) => { LoupeModal.openModal(entryId); });
    }
    // Sync momentum session filter with current active session
    Momentum.setSessionFilter(activeSession === "all" ? "all" : activeSession);
    gravityCanvas.style.display = "none";
    momentumCanvas.style.display = "";
    // Hide gravity-specific UI, show momentum UI
    const filterBar2 = document.getElementById("universe-filter-bar");
    const recencyBar2 = document.querySelector(".recency-filter-bar");
    const gravSliders2 = document.getElementById("gravity-sliders");
    const momSliders2 = document.getElementById("momentum-sliders");
    if (filterBar2) filterBar2.style.display = "none";
    if (recencyBar2) recencyBar2.style.display = "none";
    if (gravSliders2) gravSliders2.style.display = "none";
    if (momSliders2) momSliders2.style.display = "";
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

// ===== Module Init =====
LoupeIsland.init({ sessions });
LoupeModal.init({
  getEntry: (id) => entriesById.get(id),
  elements: { modalOverlay, modalPanel, modalBadge, modalTool, modalTime, modalBody, modalClose },
});
LoupeRender.init({
  openModal: LoupeModal.openModal,
  getContainerFor,
  shouldAutoScroll,
  scrollPaneToBottom,
  matchesFilter,
  matchesSearch,
  scheduleIntegrityRebuild,
});
LoupeReplay.init({
  sessions,
  getActiveSession: () => activeSession,
});

// ===== Init =====
connect();
