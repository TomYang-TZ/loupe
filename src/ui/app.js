"use strict";

  // ===== State =====
  const entries = [];
  let lineCounter = 0;
  let activeFilter = "all";
  let activeSession = "all";
  let searchQuery = "";
  let autoScroll = true;
  let linesThisSecond = 0;
  let selectedIdx = -1;
  let firstEventTs = null;
  const sessions = new Map(); // session_id -> { label, count }

  // DOM
  const paneContainer = document.getElementById("pane-container");
  const scrollFab = document.getElementById("scroll-fab");
  const searchInput = document.getElementById("search-input");
  const searchCount = document.getElementById("search-count");
  const lineCountEl = document.getElementById("line-count");
  const linesSecEl = document.getElementById("lines-sec");
  const connDot = document.getElementById("conn-dot");
  const connStatus = document.getElementById("conn-status");
  const tabBar = document.getElementById("tab-bar");
  const filterSelect = document.getElementById("filter-select");

  // Pane management
  // Each pane: { id, el, scrollEl, autoScroll }
  const panes = new Map();
  let mainContainer = null; // single-pane mode container

  const SESSION_COLORS = ["#58a6ff", "#d2a8ff", "#7ee787", "#ff7b72", "#e3b341", "#79c0ff", "#f0883e", "#a5d6ff"];
  let colorIdx = 0;
  function nextSessionColor() { return SESSION_COLORS[colorIdx++ % SESSION_COLORS.length]; }

  function makeEmptyState() {
    const div = document.createElement("div");
    div.className = "empty-state";
    div.innerHTML = '<div class="empty-icon">&gt;_</div><div class="empty-text">Waiting for log data...</div><div class="empty-hint">Events appear here as Claude calls tools</div>';
    return div;
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
    header.appendChild(document.createTextNode(label));
    pane.appendChild(header);

    const scroll = document.createElement("div");
    scroll.className = "log-scroll";
    scroll.appendChild(makeEmptyState());
    pane.appendChild(scroll);

    const paneObj = { id: sessionId, el: pane, scrollEl: scroll, autoScroll: true, color };

    scroll.addEventListener("scroll", () => {
      const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 50;
      paneObj.autoScroll = atBottom;
    });

    return paneObj;
  }

  // Build the pane layout based on current mode
  function rebuildPanes() {
    paneContainer.innerHTML = "";
    panes.clear();
    mainContainer = null;

    if (activeSession !== "all" || sessions.size <= 1) {
      // Single pane mode
      paneContainer.classList.remove("multi-pane");
      const p = createPane("main", "All", "var(--accent)");
      paneContainer.appendChild(p.el);
      panes.set("main", p);
      mainContainer = p.scrollEl;
    } else {
      // Multi-pane: one per session
      paneContainer.classList.add("multi-pane");
      for (const [id, info] of sessions) {
        if (!info.color) info.color = nextSessionColor();
        const p = createPane(id, info.label, info.color);
        paneContainer.appendChild(p.el);
        panes.set(id, p);
      }
    }
  }

  // Get the scroll container for an entry
  function getContainerFor(entry) {
    if (activeSession !== "all" || sessions.size <= 1) {
      return panes.get("main")?.scrollEl || null;
    }
    if (entry.sessionId && panes.has(entry.sessionId)) {
      return panes.get(entry.sessionId).scrollEl;
    }
    // Entry with no session — put in first pane
    const first = panes.values().next().value;
    return first?.scrollEl || null;
  }

  function shouldAutoScroll(entry) {
    if (activeSession !== "all" || sessions.size <= 1) {
      return panes.get("main")?.autoScroll ?? true;
    }
    if (entry.sessionId && panes.has(entry.sessionId)) {
      return panes.get(entry.sessionId).autoScroll;
    }
    return true;
  }

  function scrollPaneToBottom(entry) {
    const container = getContainerFor(entry);
    if (container) container.scrollTop = container.scrollHeight;
  }

  // Init default single pane
  rebuildPanes();

  // ===== WebSocket =====
  let ws;
  let reconnectDelay = 500;

  function connect() {
    const host = window.__LOGSTREAM_HOST || location.host;
    ws = new WebSocket(`ws://${host}/ws`);

    ws.onopen = () => {
      reconnectDelay = 500;
      setConnState("connected");
    };

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
    if (json && json._logstream_type && json.data) {
      return { hookType: json._logstream_type, ts: json._ts, inner: json.data };
    }
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
    if (hook && hook.inner) {
      return hook.inner.tool_name || hook.inner.name || null;
    }
    if (category === "tool_use") return json.name || json.tool_name || null;
    return null;
  }

  function extractSummary(msg, category) {
    const json = msg.json;
    if (!json) return msg.data?.slice(0, 120) || "";
    const hook = unwrapHook(json);
    const inner = hook?.inner || json;

    if (category === "tool_use") {
      const input = inner.tool_input || inner.input || {};
      if (input.file_path) return input.file_path;
      if (input.command) {
        const cmd = input.command.split("\n")[0];
        return cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd;
      }
      if (input.pattern) return `pattern: ${input.pattern}`;
      if (input.query) return input.query.slice(0, 100);
      if (input.description) return input.description;
      return Object.keys(input).slice(0, 3).join(", ");
    }

    if (category === "tool_result") {
      const resp = inner.tool_response || {};
      const out = resp.stdout || inner.tool_result || inner.output || inner.content;
      if (typeof out === "string") {
        const line = out.split("\n")[0];
        return line.length > 100 ? line.slice(0, 100) + "..." : line;
      }
      return "";
    }

    if (category === "error") {
      return inner.error || inner.tool_result || "Error";
    }

    if (category === "thinking") {
      const t = inner.thinking || inner.content || inner.text || "";
      return typeof t === "string" ? t.slice(0, 120) : "";
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
    const inner = hook?.inner || json;
    return inner.session_id || null;
  }

  function extractSessionLabel(msg) {
    const json = msg.json;
    if (!json) return null;
    const hook = unwrapHook(json);
    const inner = hook?.inner || json;
    const cwd = inner.cwd;
    if (cwd) {
      const parts = cwd.split("/");
      return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
    }
    return null;
  }

  // ===== Render =====
  function handleLine(msg) {
    lineCounter++;
    linesThisSecond++;

    const category = categorize(msg);
    const title = extractTitle(msg, category);
    const summary = extractSummary(msg, category);
    const body = extractBody(msg, category);
    const sessionId = extractSessionId(msg);
    const sessionLabel = extractSessionLabel(msg);
    if (!firstEventTs) firstEventTs = msg.ts;

    // Track sessions
    let newSession = false;
    if (sessionId && !sessions.has(sessionId)) {
      sessions.set(sessionId, { label: sessionLabel || sessionId.slice(0, 8), count: 0, color: nextSessionColor() });
      newSession = true;
      rebuildTabs();
    }
    if (sessionId && sessions.has(sessionId)) {
      sessions.get(sessionId).count++;
      if (activeSession !== "all" && activeSession !== sessionId) {
        const tab = tabBar.querySelector(`[data-session="${sessionId}"] .tab-dot`);
        if (tab) tab.classList.add("has-activity");
      }
    }

    const entry = { id: lineCounter, category, title, summary, body, raw: msg.data, json: msg.json, ts: msg.ts, sessionId };
    entries.push(entry);

    // If new session discovered while in "all" mode, rebuild panes
    if (newSession && activeSession === "all" && sessions.size > 1) {
      rebuildPanes();
      rebuildAllPaneContents();
    } else if (matchesAll(entry)) {
      const container = getContainerFor(entry);
      if (container) {
        // Remove empty state if present
        const empty = container.querySelector(".empty-state");
        if (empty) empty.remove();

        const el = renderEntry(entry);
        container.appendChild(el);
        entry.el = el;
        if (shouldAutoScroll(entry)) scrollPaneToBottom(entry);
      }
    }

    lineCountEl.textContent = lineCounter;
  }

  function relativeTime(ts) {
    if (!firstEventTs) return "";
    const diff = (ts - firstEventTs) / 1000;
    if (diff < 0.1) return "0s";
    if (diff < 60) return `+${diff.toFixed(1)}s`;
    return `+${Math.floor(diff / 60)}m${Math.floor(diff % 60)}s`;
  }

  function badgeLabel(cat) {
    const map = { tool_use: "USE", tool_result: "RESULT", error: "ERROR", thinking: "THINK", text: "TEXT", info: "INFO" };
    return map[cat] || cat.toUpperCase();
  }

  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function renderEntry(entry) {
    const div = document.createElement("div");
    div.className = "log-entry";
    div.dataset.id = entry.id;
    div.dataset.category = entry.category;
    if (entry.sessionId) div.dataset.session = entry.sessionId;

    const time = relativeTime(entry.ts);

    div.innerHTML = `
      <div class="entry-row">
        <span class="entry-badge cat-${entry.category}">${badgeLabel(entry.category)}</span>
        ${entry.title ? `<span class="entry-tool">${esc(entry.title)}</span>` : ""}
        <span class="entry-summary">${esc(entry.summary)}</span>
        <span class="entry-time">${time}</span>
      </div>
      <div class="entry-body" id="body-${entry.id}"></div>
    `;

    div.addEventListener("click", () => toggleEntry(entry.id));

    return div;
  }

  function toggleEntry(id) {
    const el = paneContainer.querySelector(`.log-entry[data-id="${id}"]`);
    if (!el) return;
    const wasExpanded = el.classList.contains("expanded");
    el.classList.toggle("expanded");

    // Lazy-render body on first expand
    const bodyEl = el.querySelector(".entry-body");
    if (!wasExpanded && bodyEl && !bodyEl.dataset.rendered) {
      const entry = entries.find(e => e.id === id);
      if (entry) {
        const content = entry.body;
        if (content && typeof content === "object") {
          bodyEl.appendChild(renderJsonTree(content));
        } else if (content) {
          bodyEl.innerHTML = applySearch(String(content));
        }
        bodyEl.dataset.rendered = "1";
      }
    }
  }

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
      const content = wrap.querySelector(".json-content");
      const ind = wrap.querySelector(".json-collapsed-indicator");
      if (content.style.display === "none") {
        content.style.display = ""; if (ind) ind.style.display = "none"; toggle.textContent = "\u25bc ";
      } else {
        content.style.display = "none"; if (ind) ind.style.display = ""; toggle.textContent = "\u25b6 ";
      }
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
      if (typeof val === "object" && val !== null) { line.appendChild(renderJsonTree(val, depth + 1)); }
      else { line.innerHTML += renderPrimitive(val); }
      if (i < keys.length - 1) line.appendChild(spanOf(",", "json-bracket"));
      content.appendChild(line);
    });

    wrap.appendChild(content);
    wrap.appendChild(spanOf(close, "json-bracket"));
    return wrap;
  }

  function renderPrimitive(val) {
    if (val === null) return `<span class="json-null">null</span>`;
    if (typeof val === "boolean") return `<span class="json-bool">${val}</span>`;
    if (typeof val === "number") return `<span class="json-number">${val}</span>`;
    const str = String(val);
    const display = str.length > 500 ? esc(str.slice(0, 500)) + "..." : esc(str);
    return `<span class="json-string">"${display}"</span>`;
  }

  function spanOf(text, cls) { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; }

  // ===== Filtering =====
  function matchesAll(entry) {
    return matchesFilter(entry) && matchesSession(entry) && matchesSearch(entry);
  }
  function matchesFilter(entry) { return activeFilter === "all" || entry.category === activeFilter; }
  function matchesSession(entry) { return activeSession === "all" || entry.sessionId === activeSession; }
  function matchesSearch(entry) {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (entry.raw || "").toLowerCase().includes(q)
      || (entry.title || "").toLowerCase().includes(q)
      || (entry.summary || "").toLowerCase().includes(q);
  }

  function applySearch(text) {
    if (!searchQuery) return esc(text);
    const escaped = esc(text);
    const q = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return escaped.replace(new RegExp(`(${q})`, "gi"), "<mark>$1</mark>");
  }

  window.setFilter = (type) => { activeFilter = type; rebuildView(); };

  searchInput.addEventListener("input", (e) => { searchQuery = e.target.value; rebuildView(); });

  function rebuildView() {
    rebuildPanes();
    rebuildAllPaneContents();
  }

  function rebuildAllPaneContents() {
    // Clear all pane contents
    for (const p of panes.values()) {
      p.scrollEl.innerHTML = "";
    }

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

    // Add empty states to empty panes
    for (const p of panes.values()) {
      if (p.scrollEl.children.length === 0) {
        p.scrollEl.appendChild(makeEmptyState());
      }
      // Scroll to bottom
      p.scrollEl.scrollTop = p.scrollEl.scrollHeight;
    }

    searchCount.textContent = searchQuery ? `${matchCount}` : "";
  }

  // ===== Session Tabs =====
  function rebuildTabs() {
    tabBar.innerHTML = "";
    const allTab = document.createElement("div");
    allTab.className = `session-tab ${activeSession === "all" ? "active" : ""}`;
    allTab.dataset.session = "all";
    allTab.textContent = "All";
    allTab.onclick = () => switchSession("all");
    tabBar.appendChild(allTab);

    for (const [id, info] of sessions) {
      const tab = document.createElement("div");
      tab.className = `session-tab ${activeSession === id ? "active" : ""}`;
      tab.dataset.session = id;
      tab.innerHTML = `${esc(info.label)} <span class="tab-dot"></span>`;
      tab.onclick = () => switchSession(id);
      tabBar.appendChild(tab);
    }
  }

  function switchSession(id) {
    activeSession = id;
    const dot = tabBar.querySelector(`[data-session="${id}"] .tab-dot`);
    if (dot) dot.classList.remove("has-activity");
    rebuildTabs();
    rebuildView();
  }

  // Scroll all panes to bottom
  function scrollAllToBottom() {
    for (const p of panes.values()) {
      p.scrollEl.scrollTop = p.scrollEl.scrollHeight;
    }
  }

  // ===== Collapse / Expand =====
  window.collapseAll = () => {
    paneContainer.querySelectorAll(".log-entry.expanded").forEach(el => el.classList.remove("expanded"));
  };
  window.expandAll = () => {
    paneContainer.querySelectorAll(".log-entry:not(.expanded)").forEach(el => {
      const id = parseInt(el.dataset.id);
      toggleEntry(id);
    });
  };

  // ===== Scroll =====
  function scrollToBottom() { scrollAllToBottom(); }

  window.jumpToBottom = () => {
    autoScroll = true;
    for (const p of panes.values()) { p.autoScroll = true; }
    scrollAllToBottom();
    scrollFab.classList.remove("visible");
  };

  // ===== Clear =====
  window.clearLogs = () => {
    entries.length = 0;
    lineCounter = 0;
    firstEventTs = null;
    sessions.clear();
    colorIdx = 0;
    rebuildTabs();
    rebuildPanes();
    lineCountEl.textContent = "0";
  };

  // ===== Keyboard =====
  document.addEventListener("keydown", (e) => {
    const inSearch = document.activeElement === searchInput;

    if (e.key === "/" && !inSearch) { e.preventDefault(); searchInput.focus(); return; }
    if (e.key === "Escape") { searchInput.blur(); searchInput.value = ""; searchQuery = ""; rebuildView(); return; }
    if (inSearch) return;

    const firstPane = panes.values().next().value;
    if (!firstPane) return;
    const visible = [...firstPane.scrollEl.querySelectorAll(".log-entry")];
    if (!visible.length) return;

    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, visible.length - 1);
      focusEntry(visible, selectedIdx);
    }
    if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      focusEntry(visible, selectedIdx);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIdx >= 0 && visible[selectedIdx]) {
        const id = parseInt(visible[selectedIdx].dataset.id);
        toggleEntry(id);
      }
    }
    if (e.key === "e") { filterSelect.value = activeFilter === "error" ? "all" : "error"; setFilter(filterSelect.value); }
    if (e.key === "g") { jumpToBottom(); }
  });

  function focusEntry(visible, idx) {
    visible.forEach(el => el.classList.remove("kb-focus"));
    if (visible[idx]) {
      visible[idx].classList.add("kb-focus");
      visible[idx].scrollIntoView({ block: "nearest" });
    }
  }

  // ===== Lines/sec =====
  setInterval(() => { linesSecEl.textContent = linesThisSecond; linesThisSecond = 0; }, 1000);

  // ===== Init =====
  connect();
