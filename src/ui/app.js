"use strict";

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

    // Drag reorder
    header.draggable = true;
    header.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", sessionId);
      e.dataTransfer.effectAllowed = "move";
      pane.classList.add("pane-dragging");
    });
    header.addEventListener("dragend", () => {
      pane.classList.remove("pane-dragging");
      paneContainer.querySelectorAll(".pane-drop-target").forEach(el => el.classList.remove("pane-drop-target"));
    });
    pane.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; pane.classList.add("pane-drop-target"); });
    pane.addEventListener("dragleave", () => pane.classList.remove("pane-drop-target"));
    pane.addEventListener("drop", (e) => {
      e.preventDefault();
      pane.classList.remove("pane-drop-target");
      const draggedId = e.dataTransfer.getData("text/plain");
      if (draggedId === sessionId || !draggedId) return;
      const fromIdx = sessionOrder.indexOf(draggedId);
      const toIdx = sessionOrder.indexOf(sessionId);
      if (fromIdx === -1 || toIdx === -1) return;
      sessionOrder.splice(fromIdx, 1);
      sessionOrder.splice(toIdx, 0, draggedId);
      rebuildTabs();
      rebuildView();
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

let gridCols = 4;

// ===== Pane resize (edge-detect on grid gaps) =====
const EDGE_ZONE = 5; // px from pane edge to trigger resize

function detectEdge(e) {
  const paneList = [...panes.values()];
  for (let i = 0; i < paneList.length; i++) {
    const rect = paneList[i].el.getBoundingClientRect();
    // Right edge → col resize (if there's a pane to the right)
    if (Math.abs(e.clientX - rect.right) < EDGE_ZONE && e.clientY >= rect.top && e.clientY <= rect.bottom) {
      const rightNeighbor = paneList.find(p => {
        const r = p.el.getBoundingClientRect();
        return r.left > rect.right - 10 && r.left < rect.right + 10 && r.top < rect.bottom && r.bottom > rect.top;
      });
      if (rightNeighbor) return { type: "col", left: paneList[i], right: rightNeighbor };
    }
    // Bottom edge → row resize (if there's a pane below)
    if (Math.abs(e.clientY - rect.bottom) < EDGE_ZONE && e.clientX >= rect.left && e.clientX <= rect.right) {
      const belowNeighbor = paneList.find(p => {
        const r = p.el.getBoundingClientRect();
        return r.top > rect.bottom - 10 && r.top < rect.bottom + 10 && r.left < rect.right && r.right > rect.left;
      });
      if (belowNeighbor) return { type: "row", above: paneList[i], below: belowNeighbor };
    }
  }
  return null;
}

paneContainer.addEventListener("mousemove", (e) => {
  if (paneContainer._resizing) return;
  const edge = detectEdge(e);
  paneContainer.style.cursor = edge ? (edge.type === "col" ? "col-resize" : "row-resize") : "";
});

paneContainer.addEventListener("mousedown", (e) => {
  const edge = detectEdge(e);
  if (!edge) return;
  e.preventDefault();
  paneContainer._resizing = true;
  document.body.style.userSelect = "none";

  if (edge.type === "col") {
    const colWidths = getComputedStyle(paneContainer).gridTemplateColumns.split(" ").map(parseFloat);
    const leftIdx = [...panes.values()].indexOf(edge.left);
    const rightIdx = [...panes.values()].indexOf(edge.right);
    const cols = Math.min(gridCols, panes.size);
    const leftCol = leftIdx % cols;
    const rightCol = rightIdx % cols;
    const startX = e.clientX;

    document.body.style.cursor = "col-resize";
    function onMove(ev) {
      const delta = ev.clientX - startX;
      const nw = [...colWidths];
      nw[leftCol] = Math.max(80, colWidths[leftCol] + delta);
      nw[rightCol] = Math.max(80, colWidths[rightCol] - delta);
      paneContainer.style.gridTemplateColumns = nw.map(w => w + "px").join(" ");
    }
    function onUp() {
      paneContainer._resizing = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  } else {
    const rowHeights = getComputedStyle(paneContainer).gridTemplateRows.split(" ").map(parseFloat);
    const aboveIdx = [...panes.values()].indexOf(edge.above);
    const belowIdx = [...panes.values()].indexOf(edge.below);
    const cols = Math.min(gridCols, panes.size);
    const aboveRow = Math.floor(aboveIdx / cols);
    const belowRow = Math.floor(belowIdx / cols);
    const startY = e.clientY;

    document.body.style.cursor = "row-resize";
    function onMove(ev) {
      const delta = ev.clientY - startY;
      const nh = [...rowHeights];
      nh[aboveRow] = Math.max(60, rowHeights[aboveRow] + delta);
      nh[belowRow] = Math.max(60, rowHeights[belowRow] - delta);
      paneContainer.style.gridTemplateRows = nh.map(h => h + "px").join(" ");
    }
    function onUp() {
      paneContainer._resizing = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
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
  } else {
    syncSessionOrder();
    paneContainer.classList.add("multi-pane");
    paneContainer.classList.add("grid-layout");
    paneContainer.style.removeProperty("flex-direction");
    paneContainer.style.removeProperty("flex-wrap");

    for (const id of sessionOrder) {
      const info = sessions.get(id);
      if (!info) continue;
      if (!info.color) info.color = nextSessionColor();
      const p = createPane(id, info.label, info.color);
      paneContainer.appendChild(p.el);
      panes.set(id, p);
    }

    const cols = Math.min(gridCols, sessionOrder.length);
    paneContainer.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    paneContainer.style.removeProperty("grid-template-rows");
  }

  // Apply saved zoom
  const z = localStorage.getItem("loupe-zoom");
  if (z) applyZoom(parseFloat(z));
}

window.setGridCols = (n) => {
  gridCols = Math.max(1, Math.min(8, n));
  if (gridLabel) gridLabel.textContent = `${gridCols} col`;
  if (activeSession === "all" && sessions.size > 1) rebuildView();
};

function updateGridControlsVisibility() {
  const show = activeSession === "all";
  if (gridControls) gridControls.style.display = show ? "" : "none";
  if (gridSep) gridSep.style.display = show ? "" : "none";
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
  colorIdx = 0;
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
      if (hook.hookType === "PreToolUse") return "tool_use";
      if (hook.hookType === "PostToolUse") {
        const inner = hook.inner;
        if (inner && (inner.is_error || inner.error)) return "error";
        return "tool_result";
      }
      if (hook.hookType === "thinking") return "thinking";
    }
    const t = json.type;
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
  if (hook && hook.inner) return hook.inner.tool_name || hook.inner.name || null;
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
    if (input.file_path) return input.file_path;
    if (input.command) return input.command.split("\n")[0];
    if (input.pattern) return `pattern: ${input.pattern}`;
    if (input.query) return input.query;
    if (input.description) return input.description;
    return Object.keys(input).slice(0, 3).join(", ");
  }
  if (category === "tool_result") {
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
  return "";
}

function extractBody(msg, category) {
  const json = msg.json;
  if (!json) return msg.data;
  const hook = unwrapHook(json);
  if (hook && hook.inner) {
    const inner = hook.inner;
    if (category === "tool_use") return inner.tool_input || inner.input || inner;
    if (category === "tool_result") return inner.tool_response || inner.tool_result || inner.output || inner.content || inner;
    if (category === "error") return inner.error || inner.tool_result || inner;
    return inner;
  }
  if (category === "thinking") return json.thinking || json.content || json.text || msg.data;
  if (category === "text") return json.text || json.content || json.data || msg.data;
  if (category === "tool_use") return json.input || json.parameters || json;
  if (category === "tool_result" || category === "error") return json.content || json.output || json.result || json.error || msg.data;
  return json;
}

function extractSessionId(msg) {
  const json = msg.json;
  if (!json) return null;
  const hook = unwrapHook(json);
  return (hook?.inner || json).session_id || null;
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
  const sessionId = extractSessionId(msg);
  const sessionLabel = extractSessionLabel(msg);
  if (!firstEventTs) firstEventTs = msg.ts;

  let newSession = false;
  if (sessionId && !sessions.has(sessionId)) {
    sessions.set(sessionId, { label: sessionLabel || sessionId.slice(0, 8), count: 0, color: nextSessionColor(), lastEventTs: msg.ts });
    newSession = true;
    rebuildTabs();
  }
  if (sessionId && sessions.has(sessionId)) {
    const sInfo = sessions.get(sessionId);
    sInfo.count++;
    sInfo.lastEventTs = msg.ts;
    if (activeSession !== "all" && activeSession !== sessionId) {
      const tab = tabBar.querySelector(`[data-session="${sessionId}"] .tab-dot`);
      if (tab) tab.classList.add("has-activity");
    }
  }

  const entry = { id: lineCounter, category, title, summary, body, raw: msg.data, json: msg.json, ts: msg.ts, sessionId };
  entries.push(entry);

  if (newSession && activeSession === "all" && sessions.size > 1) {
    rebuildPanes();
    rebuildAllPaneContents();
  } else if (matchesAll(entry)) {
    const container = getContainerFor(entry);
    if (container) {
      const empty = container.querySelector(".empty-state");
      if (empty) empty.remove();
      const el = renderEntry(entry);
      el.classList.add("flash");
      container.appendChild(el);
      entry.el = el;
      if (shouldAutoScroll(entry)) scrollPaneToBottom(entry);
    }
  }

  lineCountEl.textContent = lineCounter;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function badgeLabel(cat) {
  return { tool_use: "USE", tool_result: "RESULT", error: "ERROR", thinking: "THINK", text: "TEXT" }[cat] || cat.toUpperCase();
}

function esc(str) { const d = document.createElement("div"); d.textContent = str; return d.innerHTML; }

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

  modalBody.innerHTML = "";

  const content = entry.body;
  if (content && typeof content === "object") {
    // Structured: show input + response sections if available
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
  modalEntryId = null;
}

modalClose.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });

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
function matchesFilter(entry) { return !hiddenTypes.has(entry.category); }
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
  { key: "tool_result", label: "Result", color: "#4ade80" },
  { key: "error", label: "Error", color: "#ef4444" },
  { key: "thinking", label: "Thinking", color: "#8b5cf6" },
  { key: "text", label: "Text", color: "#8b8b96" },
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

  let matchCount = 0;
  for (const entry of entries) {
    if (matchesFilter(entry) && matchesSearch(entry)) {
      if (activeSession !== "all" && !matchesSession(entry)) continue;
      const container = getContainerFor(entry);
      if (container) {
        const el = renderEntry(entry);
        container.appendChild(el);
        entry.el = el;
        matchCount++;
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

  const allTab = document.createElement("div");
  allTab.className = `session-tab ${activeSession === "all" ? "active" : ""}`;
  allTab.dataset.session = "all";
  allTab.textContent = "All";
  allTab.onclick = () => switchSession("all");
  tabBar.appendChild(allTab);

  let tabIdx = 1;
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
    tab.innerHTML = `${esc(info.label)}${shortcut}${staleLabel}<span class="tab-dot"></span><button class="tab-close" title="Remove">&times;</button>`;
    tab.onclick = (e) => { if (!e.target.classList.contains("tab-close")) switchSession(id); };
    tab.querySelector(".tab-close").onclick = (e) => { e.stopPropagation(); removeSession(id); };

    // Drag
    tab.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", id); tab.classList.add("tab-dragging"); e.dataTransfer.effectAllowed = "move"; });
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
}

function switchSession(id) {
  activeSession = id;
  const dot = tabBar.querySelector(`[data-session="${id}"] .tab-dot`);
  if (dot) dot.classList.remove("has-activity");
  rebuildTabs();
  rebuildView();
  updateGridControlsVisibility();
}

function removeSession(id) {
  sessions.delete(id);
  sessionOrder = sessionOrder.filter(s => s !== id);
  for (let i = entries.length - 1; i >= 0; i--) { if (entries[i].sessionId === id) entries.splice(i, 1); }
  if (activeSession === id) activeSession = "all";
  rebuildTabs();
  rebuildView();
}

setInterval(rebuildTabs, 30000);

function scrollAllToBottom() { for (const p of panes.values()) p.scrollEl.scrollTop = p.scrollEl.scrollHeight; }

// ===== Actions =====
window.collapseAll = () => { /* no-op: entries don't expand inline anymore */ };

window.clearLogs = () => {
  if (activeSession === "all") {
    // Clear everything
    entries.length = 0;
    lineCounter = 0;
    firstEventTs = null;
    sessions.clear();
    colorIdx = 0;
    rebuildTabs();
    rebuildPanes();
    lineCountEl.textContent = "0";
  } else {
    // Clear only the active session
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].sessionId === activeSession) entries.splice(i, 1);
    }
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

  if (e.key === "?" && !inSearch) { toggleHelp(); return; }
  if (e.key === "t" && e.metaKey) { e.preventDefault(); toggleTheme(); return; }
  if ((e.key === "=" || e.key === "+") && e.metaKey && e.shiftKey) { e.preventDefault(); setGridCols(gridCols + 1); return; }
  if ((e.key === "-" || e.key === "_") && e.metaKey && e.shiftKey) { e.preventDefault(); setGridCols(gridCols - 1); return; }
  if ((e.key === "=" || e.key === "+") && e.metaKey) { e.preventDefault(); adjustFontSize(1); return; }
  if (e.key === "-" && e.metaKey) { e.preventDefault(); adjustFontSize(-1); return; }
  if (e.key === "Escape") {
    if (helpVisible) { toggleHelp(); return; }
    searchInput.blur(); searchInput.value = ""; searchQuery = ""; rebuildView(); return;
  }
  if (e.key === "/" && !inSearch) { e.preventDefault(); searchInput.focus(); return; }
  if (inSearch) return;

  const firstPane = panes.values().next().value;
  if (!firstPane) return;
  const visible = [...firstPane.scrollEl.querySelectorAll(".log-entry")];

  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); if (!visible.length) return; selectedIdx = Math.min(selectedIdx + 1, visible.length - 1); focusEntry(visible, selectedIdx); }
  if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); if (!visible.length) return; selectedIdx = Math.max(selectedIdx - 1, 0); focusEntry(visible, selectedIdx); }
  if (e.key === "Enter") { e.preventDefault(); if (selectedIdx >= 0 && visible[selectedIdx]) openModal(parseInt(visible[selectedIdx].dataset.id)); }
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
  if (e.key === "0") { switchSession("all"); }
  if (e.key >= "1" && e.key <= "9") { const idx = parseInt(e.key) - 1; const ids = [...sessions.keys()]; if (idx < ids.length) switchSession(ids[idx]); }
});

function focusEntry(visible, idx) {
  visible.forEach(el => el.classList.remove("kb-focus"));
  if (visible[idx]) { visible[idx].classList.add("kb-focus"); visible[idx].scrollIntoView({ block: "nearest" }); }
}


// ===== Theme toggle =====
const themeToggle = document.getElementById("theme-toggle");

function toggleTheme() {
  const current = document.documentElement.dataset.theme || "dark";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("loupe-theme", theme);
  // Sync checkbox state: checked = light mode
  if (themeToggle) themeToggle.checked = (theme === "light");
  // Notify native macOS app to update window chrome
  if (window.webkit?.messageHandlers?.themeChange) {
    window.webkit.messageHandlers.themeChange.postMessage(theme);
  }
}

// Set initial state and notify native app
if (themeToggle) {
  const initialTheme = document.documentElement.dataset.theme || "dark";
  themeToggle.checked = (initialTheme === "light");
  // Use click on the label instead of change on checkbox to avoid macOS click sound
  const themeLabel = themeToggle.closest(".theme-switch");
  if (themeLabel) {
    themeLabel.addEventListener("click", (e) => {
      e.preventDefault();
      toggleTheme();
    });
  }
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

// ===== Init =====
connect();
