#!/usr/bin/env node

// Loupe TUI — Interactive terminal companion for Ghostty splits
// Query-grouped event stream with keyboard/mouse navigation

const WebSocket = require("ws");

const PORT = process.env.LOUPE_PORT || 8390;
const WS_URL = `ws://localhost:${PORT}`;

// ===== ANSI helpers =====
const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const ITALIC = `${ESC}[3m`;
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ENABLE_MOUSE = `${ESC}[?1000h`;
const DISABLE_MOUSE = `${ESC}[?1000l`;

const FG = {
  black: `${ESC}[30m`, red: `${ESC}[31m`, green: `${ESC}[32m`,
  yellow: `${ESC}[33m`, blue: `${ESC}[34m`, magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`, white: `${ESC}[37m`, gray: `${ESC}[90m`,
};

// ===== State =====
let connected = false;
let phase = "idle";
let currentTool = null;
let thinkingActive = false;
let eventCount = 0;
let errorCount = 0;
let tokenTotal = 0;
const fileSet = new Set();

// Query-grouped data model
const queries = [];
let queryIdCounter = 0;
const MAX_QUERIES = 200;
let focusIdx = -1;
let autoFollow = true;
let hasNewQueries = false;
let scrollOffset = 0;

// Session tracking
const sessions = new Map();
let sessionFilter = "all";

// Status line state
const statusLine = {
  sessionState: "idle",
  waitingTool: null,
  errors: 0,
  apiError: null,
  agentsRunning: 0,
  agentsTotal: 0,
  tasksCreated: 0,
  tasksCompleted: 0,
  sessionStartTs: null,
};

// Agent tree state
const agentTree = [];
let agentTreeVisible = false;
const TREE_WIDTH = 28;

// Mouse click mapping
let rowMap = [];

// ===== Category colors =====
const catColors = {
  tool_use: FG.blue, tool_result: FG.green, post_tool: FG.green,
  error: FG.red, thinking: FG.magenta, text: FG.white,
  sub_agent: FG.cyan, sub_agent_result: FG.cyan,
  user_query: FG.yellow, pre_tool: FG.blue,
  session_start: FG.green, session_end: FG.gray, compact: FG.gray,
  permission_request: FG.yellow, permission_denied: FG.yellow,
  tool_failure: FG.red, stop_failure: FG.red,
  task_created: FG.magenta, task_completed: FG.green,
  tool_rejected: FG.red,
};

// ===== Categorize =====
function categorize(json) {
  if (!json) return "unknown";
  const type = json._logstream_type;
  const data = json.data || {};
  if (type === "PreToolUse") {
    if (data.tool_name === "Agent") return null;
    return "pre_tool";
  }
  if (type === "PostToolUse") {
    if (data.tool_name === "Agent") return null;
    if (data.is_error) return null;
    return "post_tool";
  }
  if (type === "thinking") return "thinking";
  if (type === "user_query") return "user_query";
  if (type === "UserPromptSubmit") return "user_query";
  if (type === "SubagentStart") return "sub_agent";
  if (type === "SubagentStop") return "sub_agent_result";
  if (type === "PostToolUseFailure") return "tool_failure";
  if (type === "StopFailure") return "stop_failure";
  if (type === "SessionStart") return "session_start";
  if (type === "SessionEnd") return "session_end";
  if (type === "PreCompact") return "compact";
  if (type === "PostCompact") return "compact";
  if (type === "PermissionRequest") return "permission_request";
  if (type === "PermissionDenied") return "permission_denied";
  if (type === "TaskCreated") return "task_created";
  if (type === "TaskCompleted") return "task_completed";
  if (type === "tool_rejected") return "tool_rejected";
  if (type === "Notification") return null;
  if (type === "Stop") return null;
  return type || "unknown";
}

function extractToolInfo(json) {
  if (!json || !json.data) return null;
  const d = json.data;
  const name = d.tool_name;
  if (!name) return null;
  const input = d.tool_input || {};
  let detail = "";
  if (input.file_path) {
    detail = input.file_path.split("/").slice(-2).join("/");
    fileSet.add(input.file_path);
  } else if (input.command) {
    detail = input.command.split("\n")[0].slice(0, 60);
  } else if (input.pattern) {
    detail = `pattern: ${input.pattern}`;
  } else if (input.description) {
    detail = input.description.slice(0, 60);
  }
  return { name, detail };
}

function extractSessionId(json) {
  return json?.data?.session_id || null;
}

function extractUserQuery(json) {
  return json?.data?.user_query || json?.data?.prompt || null;
}

// ===== ANSI utilities =====
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function truncateAnsi(str, maxWidth) {
  let visibleLen = 0;
  let i = 0;
  while (i < str.length && visibleLen < maxWidth) {
    if (str[i] === "\x1b" && i + 1 < str.length && str[i + 1] === "[") {
      let j = i + 2;
      while (j < str.length && !/[a-zA-Z]/.test(str[j])) j++;
      i = j + 1;
    } else {
      visibleLen++;
      i++;
    }
  }
  return str.slice(0, i) + RESET;
}

function padLine(text, width) {
  const len = stripAnsi(text).length;
  if (len >= width) return truncateAnsi(text, width);
  return text + " ".repeat(width - len);
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

// ===== Handle WebSocket messages =====
function handleMessage(data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  if (msg.type === "backlog_done" || msg.type === "sessions" || msg.type === "session_remove" || msg.type === "reset") {
    if (msg.type === "reset") {
      eventCount = 0; errorCount = 0; tokenTotal = 0;
      fileSet.clear();
      queries.length = 0; queryIdCounter = 0;
      focusIdx = -1; autoFollow = true; hasNewQueries = false;
      sessions.clear(); sessionFilter = "all";
      phase = "idle"; currentTool = null;
      Object.assign(statusLine, { sessionState: "idle", waitingTool: null, errors: 0, apiError: null, agentsRunning: 0, agentsTotal: 0, tasksCreated: 0, tasksCompleted: 0, sessionStartTs: null });
      agentTree.length = 0; agentTreeVisible = false;
    }
    return;
  }
  if (msg.type !== "line") return;

  eventCount++;
  const json = msg.json;
  const cat = categorize(json);
  if (cat === null) return;

  // Phase tracking
  if (cat === "thinking") { thinkingActive = true; phase = "exploring"; }
  if (cat === "pre_tool" && json?.data) {
    thinkingActive = false;
    const tool = extractToolInfo(json);
    if (tool) {
      currentTool = tool;
      if (["Read", "Glob", "Grep", "LSP"].some(t => tool.name.includes(t))) phase = "exploring";
      else if (["Edit", "Write"].some(t => tool.name.includes(t))) phase = "implementing";
      else if (tool.name.includes("Bash")) {
        const cmd = json.data.tool_input?.command || "";
        if (/test|jest|pytest|cargo test|npm test/.test(cmd)) phase = "testing";
        else if (phase === "idle") phase = "implementing";
      }
    }
  }
  if (cat === "error" || cat === "tool_failure") errorCount++;

  // Token tracking
  const usage = json?.data?.message?.usage || json?.message?.usage;
  if (usage) tokenTotal += (usage.input_tokens || 0) + (usage.output_tokens || 0);

  // Status line tracking
  if (cat === "session_start") { statusLine.sessionState = "active"; statusLine.sessionStartTs = Date.now(); }
  if (cat === "session_end") { statusLine.sessionState = "idle"; statusLine.sessionStartTs = null; }
  if (cat === "compact") { statusLine.sessionState = json?._logstream_type === "PreCompact" ? "compacting" : "active"; }
  if (cat === "permission_request") { statusLine.sessionState = "waiting"; statusLine.waitingTool = json?.data?.tool_name || "tool"; }
  if (statusLine.sessionState === "waiting" && (cat === "pre_tool" || cat === "post_tool" || cat === "thinking" || cat === "user_query" || cat === "tool_rejected")) {
    statusLine.sessionState = "active"; statusLine.waitingTool = null;
  }
  if (cat === "user_query") {
    statusLine.errors = 0; statusLine.apiError = null;
    if (statusLine.sessionState === "idle") { statusLine.sessionState = "active"; statusLine.sessionStartTs = statusLine.sessionStartTs || Date.now(); }
  }
  if (cat === "tool_failure" || cat === "tool_rejected") statusLine.errors++;
  if (cat === "stop_failure") statusLine.apiError = json?.data?.reason || "API error";
  if (cat === "sub_agent") { statusLine.agentsRunning++; statusLine.agentsTotal++; }
  if (cat === "sub_agent_result") { statusLine.agentsRunning = Math.max(0, statusLine.agentsRunning - 1); }
  if (cat === "task_created") statusLine.tasksCreated++;
  if (cat === "task_completed") statusLine.tasksCompleted++;

  // Agent tree tracking
  if (cat === "sub_agent") {
    agentTree.push({ id: json?.data?.agent_id || `agent-${agentTree.length}`, type: json?.data?.agent_type || "Agent", status: "running", startTs: Date.now(), endTs: null });
    agentTreeVisible = true;
  }
  if (cat === "sub_agent_result") {
    const id = json?.data?.agent_id;
    const agent = (id && agentTree.find(a => a.id === id && a.status === "running")) || agentTree.find(a => a.status === "running");
    if (agent) { agent.status = "done"; agent.endTs = Date.now(); }
    if (agentTree.length > 0 && agentTree.every(a => a.status === "done")) {
      setTimeout(() => { if (agentTree.every(a => a.status === "done")) { agentTreeVisible = false; agentTree.length = 0; render(); } }, 5000);
    }
  }

  // Build event ANSI line
  const ts = new Date(msg.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let line = `${DIM}${ts}${RESET} `;
  const color = catColors[cat] || FG.gray;
  const badge = {
    pre_tool: "USE", post_tool: " OK", tool_use: "USE", tool_result: "RES",
    error: "ERR", thinking: "THK", text: "TXT", sub_agent: "AGT",
    sub_agent_result: "AGT", user_query: "QRY",
    session_start: "SSN", session_end: "SSN", compact: "CMP",
    permission_request: "APR", permission_denied: "DEN",
    tool_failure: "FLD", stop_failure: "API",
    task_created: "TSK", task_completed: "TSK",
    tool_rejected: "REJ",
  }[cat] || cat.slice(0, 3).toUpperCase();

  line += `${color}${BOLD}${badge}${RESET} `;

  if (cat === "pre_tool") {
    const tool = extractToolInfo(json);
    if (tool) line += `${FG.white}${tool.name}${RESET} ${DIM}${tool.detail}${RESET}`;
  } else if (cat === "thinking") {
    line += `${FG.magenta}${ITALIC}${(json?.data?.thinking || "").replace(/\n/g, " ").slice(0, 50)}${RESET}`;
  } else if (cat === "error") {
    line += `${FG.red}${String(json?.data?.tool_result || json?.data?.error || "error").split("\n")[0].slice(0, 60)}${RESET}`;
  } else if (cat === "user_query") {
    line += `${FG.yellow}${(json?.data?.user_query || json?.data?.prompt || "").slice(0, 60)}${RESET}`;
  } else if (cat === "post_tool") {
    line += `${FG.green}${json?.data?.tool_name || ""} ✓${RESET}`;
  } else if (cat === "session_start") {
    line += `${FG.green}Session ${json?.data?.source || "started"}${RESET}`;
  } else if (cat === "session_end") {
    line += `${FG.gray}Session ended${RESET}`;
  } else if (cat === "compact") {
    line += `${DIM}${json?._logstream_type === "PreCompact" ? "Compacting..." : "Compaction done"}${RESET}`;
  } else if (cat === "permission_request") {
    line += `${FG.yellow}Waiting: ${json?.data?.tool_name || "tool"}${RESET}`;
  } else if (cat === "permission_denied") {
    line += `${FG.yellow}Denied: ${json?.data?.tool_name || "tool"}${RESET}`;
  } else if (cat === "tool_failure") {
    line += `${FG.red}${json?.data?.tool_name || ""} failed — ${String(json?.data?.error || "").split("\n")[0].slice(0, 50)}${RESET}`;
  } else if (cat === "stop_failure") {
    line += `${FG.red}${json?.data?.reason || json?.data?.error_type || "API error"}${RESET}`;
  } else if (cat === "task_created") {
    line += `${FG.magenta}${json?.data?.task_subject || "New task"}${RESET}`;
  } else if (cat === "task_completed") {
    line += `${FG.green}${json?.data?.task_subject || "Task"} ✓${RESET}`;
  } else if (cat === "tool_rejected") {
    line += `${FG.red}Tool rejected by user${RESET}`;
  } else if (cat === "sub_agent") {
    line += `${FG.cyan}${BOLD}▶ ${json?.data?.agent_type || "Agent"}${RESET}`;
  } else if (cat === "sub_agent_result") {
    line += `${FG.cyan}◀ ${json?.data?.agent_type || "Agent"}${RESET} ${DIM}${String(json?.data?.last_assistant_message || "").split("\n")[0].slice(0, 40)}${RESET}`;
  } else {
    line += `${DIM}${String(json?.data?.text || json?.data?.thinking || "").replace(/\n/g, " ").slice(0, 50)}${RESET}`;
  }

  // Session tracking
  const sessionId = extractSessionId(json);
  if (sessionId && !sessions.has(sessionId)) {
    sessions.set(sessionId, { id: sessionId, label: json?.data?.cwd?.split("/").pop() || sessionId.slice(0, 8), eventCount: 0 });
  }
  if (sessionId && sessions.has(sessionId)) sessions.get(sessionId).eventCount++;

  // Query grouping
  const userQuery = extractUserQuery(json);
  const isQueryBoundary = cat === "user_query" && userQuery;
  const eventObj = { line, cat, sessionId, ts: msg.ts };

  if (isQueryBoundary) {
    // Auto-collapse previous, expand new when following
    if (autoFollow && queries.length > 0) {
      queries[queries.length - 1].collapsed = true;
    }
    const q = { id: ++queryIdCounter, userQuery, sessionId, startTs: msg.ts, endTs: msg.ts, events: [], collapsed: !autoFollow };
    queries.push(q);
    if (queries.length > MAX_QUERIES) queries.shift();
    if (autoFollow) {
      focusIdx = queries.length - 1;
    } else {
      hasNewQueries = true;
    }
  } else {
    if (queries.length === 0) {
      queries.push({ id: ++queryIdCounter, userQuery: null, sessionId, startTs: msg.ts, endTs: msg.ts, events: [], collapsed: false });
      focusIdx = 0;
    }
    const current = queries[queries.length - 1];
    current.events.push(eventObj);
    current.endTs = msg.ts;

    // Rejection strikethrough
    if (cat === "tool_rejected") {
      for (let i = current.events.length - 1; i >= 0; i--) {
        if (current.events[i].cat === "pre_tool") {
          const orig = current.events[i].line;
          current.events[i].line = `${DIM}${FG.red}✗${RESET} ${DIM}${stripAnsi(orig)}${RESET}`;
          break;
        }
      }
    }
  }

  render();
}

// ===== Rendering =====
function renderStatusLine(cols) {
  const parts = [];
  if (statusLine.sessionState === "active") {
    let label = `${FG.green}●${RESET} Active`;
    if (statusLine.sessionStartTs) {
      const secs = Math.floor((Date.now() - statusLine.sessionStartTs) / 1000);
      label += ` ${DIM}${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s${RESET}`;
    }
    parts.push(label);
  } else if (statusLine.sessionState === "waiting") {
    parts.push(`${FG.yellow}●${RESET} Waiting: ${statusLine.waitingTool || "approval"}`);
  } else if (statusLine.sessionState === "compacting") {
    parts.push(`${FG.yellow}●${RESET} Compacting…`);
  } else {
    parts.push(`${FG.gray}●${RESET} Idle`);
  }
  if (statusLine.errors > 0) parts.push(`${FG.red}Errors: ${statusLine.errors}${RESET}`);
  if (statusLine.apiError) parts.push(`${FG.red}${statusLine.apiError}${RESET}`);
  if (statusLine.agentsRunning > 0) {
    const done = statusLine.agentsTotal - statusLine.agentsRunning;
    parts.push(`${FG.cyan}Agents: ${done > 0 ? done + "/" + statusLine.agentsTotal + " done" : statusLine.agentsRunning + " running"}${RESET}`);
  } else if (statusLine.agentsTotal > 0) {
    parts.push(`${FG.cyan}Agents: ${statusLine.agentsTotal}/${statusLine.agentsTotal} done${RESET}`);
  }
  if (statusLine.tasksCreated > 0) {
    const allDone = statusLine.tasksCompleted >= statusLine.tasksCreated;
    parts.push(`${FG.magenta}Tasks: ${statusLine.tasksCompleted}/${statusLine.tasksCreated}${allDone ? " ✓" : ""}${RESET}`);
  }
  return padLine(parts.join(`${DIM}  │  ${RESET}`), cols);
}

function renderAgentTree(rows) {
  const lines = [];
  lines.push(`${BOLD}${FG.cyan} AGENTS${RESET}`);
  lines.push(`${DIM}${"─".repeat(TREE_WIDTH - 1)}${RESET}`);
  const running = agentTree.filter(a => a.status === "running").length;
  lines.push(` ${FG.cyan}${agentTree.length - running}/${agentTree.length} done${RESET}`);
  lines.push("");
  for (const agent of agentTree) {
    const icon = agent.status === "done" ? `${FG.green}✓${RESET}` : `${FG.yellow}●${RESET}`;
    const secs = Math.floor(((agent.endTs || Date.now()) - agent.startTs) / 1000);
    const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;
    lines.push(` ${icon} ${agent.type}`);
    lines.push(`   ${DIM}${elapsed}${RESET}`);
  }
  while (lines.length < rows) lines.push("");
  if (lines.length > rows) lines.length = rows;
  return lines.map(l => padLine(l, TREE_WIDTH));
}

function render() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Header
  const connStr = connected ? `${FG.green}●${RESET}` : `${FG.red}●${RESET}`;
  const phaseColor = { exploring: FG.magenta, implementing: FG.blue, debugging: FG.red, testing: FG.green, planning: FG.yellow, idle: FG.gray }[phase] || FG.gray;
  let header = `${BOLD} LOUPE ${RESET} ${connStr} ${phaseColor}${BOLD}${thinkingActive ? "thinking" : phase}${RESET}`;
  if (currentTool) header += `  ${DIM}▸ ${currentTool.name}${RESET}`;

  let stats = ` ${DIM}events:${RESET}${eventCount}  ${DIM}files:${RESET}${fileSet.size}  ${DIM}tokens:${RESET}${formatTokens(tokenTotal)}`;
  if (errorCount > 0) stats += `  ${FG.red}errors:${errorCount}${RESET}`;
  if (sessions.size > 1) stats += `  ${DIM}sessions:${RESET}${sessions.size}`;

  const sep = DIM + "─".repeat(cols) + RESET;
  const showTabs = sessions.size > 1;
  const logRows = rows - (showTabs ? 6 : 5);

  let output = `${ESC}[H`;
  output += padLine(header, cols) + "\n";
  output += padLine(stats, cols) + "\n";

  // Session tabs
  if (showTabs) {
    let tabLine = " ";
    tabLine += sessionFilter === "all" ? `${BOLD}${FG.cyan}[All]${RESET}` : `${DIM}[All]${RESET}`;
    let idx = 1;
    for (const [sid, sInfo] of sessions) {
      const active = sessionFilter === sid;
      const label = `${idx}:${sInfo.label}`;
      tabLine += active ? ` ${BOLD}${FG.cyan}[${label}]${RESET}` : ` ${DIM}[${label}]${RESET}`;
      idx++;
      if (idx > 9) break;
    }
    output += padLine(tabLine, cols) + "\n";
  }

  output += sep + "\n";

  // Build flat row list from queries
  const filteredQueries = sessionFilter === "all"
    ? queries
    : queries.filter(q => q.sessionId === sessionFilter || q.events.some(e => e.sessionId === sessionFilter));

  const rowData = [];
  for (const q of filteredQueries) {
    const realIdx = queries.indexOf(q);
    const isFocused = realIdx === focusIdx;
    const chevron = q.collapsed ? "▶" : "▼";
    const fc = isFocused ? FG.cyan : DIM;
    const queryText = q.userQuery ? q.userQuery.slice(0, 40) : "(preamble)";
    const count = q.events.length;
    const time = new Date(q.startTs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
    const headerLine = `${fc}${chevron}${RESET} ${fc}${queryText}${RESET}  ${DIM}${count}${RESET}  ${DIM}${time}${RESET}`;
    rowData.push({ text: headerLine, isHeader: true, queryIdx: realIdx });

    if (!q.collapsed) {
      for (const ev of q.events) {
        if (sessionFilter !== "all" && ev.sessionId && ev.sessionId !== sessionFilter) continue;
        rowData.push({ text: `  ${ev.line}`, isHeader: false, queryIdx: realIdx });
      }
    }
  }

  // Empty state
  if (rowData.length === 0) {
    const emptyMsg = connected ? `${DIM}Waiting for events...${RESET}` : `${FG.red}Disconnected${RESET}`;
    const mid = Math.floor(logRows / 2);
    for (let i = 0; i < logRows; i++) {
      output += padLine(i === mid ? emptyMsg : "", cols) + "\n";
    }
    output += sep + "\n";
    output += renderStatusLine(cols) + "\n";
    process.stdout.write(output);
    return;
  }

  // Scroll to keep focused query visible
  if (focusIdx >= 0) {
    const focusRow = rowData.findIndex(r => r.isHeader && r.queryIdx === focusIdx);
    if (focusRow >= 0) {
      if (focusRow < scrollOffset) scrollOffset = focusRow;
      if (focusRow >= scrollOffset + logRows) scrollOffset = focusRow - logRows + 1;
    }
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, rowData.length - logRows)));

  const visibleRows = rowData.slice(scrollOffset, scrollOffset + logRows);
  rowMap = visibleRows.map(r => r ? { type: r.isHeader ? "header" : "event", queryIdx: r.queryIdx } : null);

  // Render rows with optional agent tree pane
  const showTree = agentTreeVisible && (sessionFilter === "all" || agentTree.some(a => true));
  const logWidth = showTree ? Math.max(40, cols - TREE_WIDTH - 1) : cols;
  const treeLines = showTree ? renderAgentTree(logRows) : null;

  for (let i = 0; i < logRows; i++) {
    const row = visibleRows[i];
    const rowText = row ? row.text : "";
    const truncated = padLine(rowText, logWidth);

    if (showTree && treeLines) {
      output += truncated + `${DIM}│${RESET}` + treeLines[i] + "\n";
    } else {
      output += truncated + "\n";
    }
  }

  output += sep + "\n";
  output += renderStatusLine(cols) + "\n";

  // "↓ new" indicator
  if (hasNewQueries && !autoFollow) {
    output += `${ESC}[${rows - 2};${cols - 6}H${FG.yellow}↓ new${RESET}`;
  }

  process.stdout.write(output);
}

// ===== Input handling =====
function handleInput(buf) {
  const s = buf.toString();

  // X10 mouse: ESC [ M <button> <col> <row>
  if (buf.length >= 6 && buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x4d) {
    const button = buf[3];
    const col = buf[4] - 32;
    const row = buf[5] - 32;
    handleMouse(button, col, row);
    return;
  }

  if (s === "\x03" || s === "q") { cleanup(); process.exit(0); }

  if (s === "j" || s === "\x1b[B") {
    if (focusIdx < queries.length - 1) {
      focusIdx++;
      autoFollow = focusIdx === queries.length - 1;
      if (autoFollow) hasNewQueries = false;
    }
    render(); return;
  }

  if (s === "k" || s === "\x1b[A") {
    if (focusIdx > 0) { focusIdx--; autoFollow = false; }
    render(); return;
  }

  if (s === "\r" || s === " ") {
    if (focusIdx >= 0 && focusIdx < queries.length) {
      queries[focusIdx].collapsed = !queries[focusIdx].collapsed;
    }
    render(); return;
  }

  if (s === "g") { focusIdx = 0; autoFollow = false; render(); return; }

  if (s === "G") {
    focusIdx = queries.length - 1;
    autoFollow = true; hasNewQueries = false;
    render(); return;
  }

  if (s === "1") { sessionFilter = "all"; render(); return; }

  if (s >= "2" && s <= "9") {
    const idx = parseInt(s) - 2;
    const sessionIds = [...sessions.keys()];
    if (idx < sessionIds.length) sessionFilter = sessionIds[idx];
    render(); return;
  }
}

function handleMouse(button, col, row) {
  const isScroll = (button & 0x40) !== 0;

  if (isScroll) {
    const scrollUp = (button & 0x01) === 0;
    if (scrollUp) {
      if (focusIdx > 0) { focusIdx--; autoFollow = false; }
    } else {
      if (focusIdx < queries.length - 1) { focusIdx++; autoFollow = focusIdx === queries.length - 1; if (autoFollow) hasNewQueries = false; }
    }
    render(); return;
  }

  if ((button & 0x03) === 0) {
    const showTabs = sessions.size > 1;
    const contentStartRow = showTabs ? 5 : 4;
    const contentRow = row - contentStartRow;
    if (contentRow >= 0 && contentRow < rowMap.length) {
      const mapped = rowMap[contentRow];
      if (mapped && mapped.type === "header") {
        const q = queries[mapped.queryIdx];
        if (q) { q.collapsed = !q.collapsed; focusIdx = mapped.queryIdx; }
        render();
      }
    }
  }
}

// ===== Connection =====
let ws = null;
let reconnectTimer = null;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.on("open", () => { connected = true; render(); });
  ws.on("message", (data) => handleMessage(data.toString()));
  ws.on("close", () => { connected = false; render(); scheduleReconnect(); });
  ws.on("error", () => { connected = false; });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 2000);
}

// ===== Startup =====
process.stdout.write(HIDE_CURSOR + CLEAR_SCREEN + ENABLE_MOUSE);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleInput);
}

function cleanup() {
  process.stdout.write(DISABLE_MOUSE + SHOW_CURSOR);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.stdout.on("resize", () => render());

connect();
setInterval(() => { if (connected) render(); }, 1000);
