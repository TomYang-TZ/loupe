#!/usr/bin/env node

// Loupe TUI — Interactive terminal companion for Ghostty splits
// Query-grouped event stream with keyboard/mouse navigation

const WebSocket = require("ws");
const { execSync } = require("child_process");
const path = require("path");
const { extractSessionId: _extractSessionId, extractUserQuery: _extractUserQuery } = require("../shared/session-extract");
const { extractToolDetail, detectPhaseFromTool } = require("../shared/tool-detail");

const PORT = process.env.LOUPE_PORT || 8390;
const WS_URL = `ws://localhost:${PORT}`;
const LOUPE_DIR = path.resolve(__dirname, "../..");

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

// Query-grouped data model — per session, like window mode
const sessionQueries = new Map(); // sessionId → [query objects]
let queryIdCounter = 0;
const MAX_QUERIES_PER_SESSION = 100;

// Flat derived list for navigation (rebuilt each render)
let queries = [];
let focusIdx = -1;
let autoFollow = true;
let hasNewQueries = false;
let scrollOffset = 0;

// Two-level navigation
let navLevel = "query";   // "query" | "event" | "detail"
let eventFocusIdx = -1;   // which event within the focused query
let detailScroll = 0;     // scroll offset within detail view

// Session tracking
const sessions = new Map();
let sessionFilter = "all";

// Status line state
const statusLine = {
  sessionState: "idle",
  waitingTool: null,
  approved: null,
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
let windowBtnCol = -1; // column where "w:⧉ Window" starts in status line
// Navigation order — maps visual position to query index (rebuilt each render)
let navOrder = [];
// Queue of agent prompts from PreToolUse, consumed by SubagentStart in order
const pendingAgentPrompts = [];
let allCollapsed = false;
let clearPending = false;
let clearTimer = null;

// ===== Actions =====
function openWindow() {
  try {
    // Write signal file, then activate app — it checks for the file on reopen
    const fs = require("fs");
    const signalPath = path.join(process.env.HOME, ".claude/logs/loupe-show-window");
    fs.writeFileSync(signalPath, "1");
    const appBundle = path.join(LOUPE_DIR, "Loupe.app");
    execSync(`open "${appBundle}"`, { stdio: "ignore" });
  } catch (e) { /* ignore */ }
}

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
    if (data.tool_name === "Agent") {
      pendingAgentPrompts.push(data.tool_input?.prompt || data.tool_input?.description || null);
      return null;
    }
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
  if (type === "tool_approved_with_message") return "tool_approved_msg";
  if (type === "Notification") return "Notification";
  if (type === "Stop") return "Stop";
  return type || "unknown";
}

function extractToolInfo(json) {
  if (!json || !json.data) return null;
  const d = json.data;
  const name = d.tool_name;
  if (!name) return null;
  const input = d.tool_input || {};
  const { detail, filePath } = extractToolDetail(input);
  if (filePath) fileSet.add(filePath);
  return { name, detail };
}

function getSessionQueries(sid) {
  const key = sid || "_default";
  if (!sessionQueries.has(key)) sessionQueries.set(key, []);
  return sessionQueries.get(key);
}

function extractSessionId(json) { return _extractSessionId(json); }
function extractUserQuery(json) { return _extractUserQuery(json); }

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
    if (msg.type === "backlog_done") {
      // Normalize transient states from backlog replay
      phase = "idle"; currentTool = null; thinkingActive = false;
      statusLine.sessionState = "idle"; statusLine.waitingTool = null;
      statusLine.approved = null;
      render();
    }
    if (msg.type === "reset") {
      eventCount = 0; errorCount = 0; tokenTotal = 0;
      fileSet.clear();
      sessionQueries.clear(); queries = []; queryIdCounter = 0;
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

  // Approval with message — append to last completed USE line
  if (cat === "tool_approved_msg") {
    const approveMsg = json?.data?.message || "";
    const approveSid = extractSessionId(json);
    if (approveMsg) {
      const aq = getSessionQueries(approveSid);
      for (let qi = aq.length - 1; qi >= 0; qi--) {
        for (let ei = aq[qi].events.length - 1; ei >= 0; ei--) {
          if (aq[qi].events[ei].cat === "pre_tool" && aq[qi].events[ei]._completed) {
            aq[qi].events[ei].line += `  ${FG.yellow}"${approveMsg.slice(0, 40)}"${RESET}`;
            render(); return;
          }
        }
      }
    }
    render(); return;
  }

  // Hidden categories — tracked for state but not rendered as events
  const tuiHidden = cat === "permission_request" || cat === "permission_denied" || cat === "unknown";

  // Phase tracking
  if (cat === "thinking") { thinkingActive = true; phase = "exploring"; }
  if (cat === "pre_tool" && json?.data) {
    thinkingActive = false;
    const tool = extractToolInfo(json);
    if (tool) {
      currentTool = tool;
      const newPhase = detectPhaseFromTool(tool.name, json.data.tool_input?.command, phase);
      if (newPhase) phase = newPhase;
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
  if (statusLine.sessionState === "waiting" && (cat === "pre_tool" || cat === "post_tool" || cat === "thinking" || cat === "user_query")) {
    statusLine.approved = statusLine.waitingTool || "tool";
    statusLine.sessionState = "active"; statusLine.waitingTool = null;
    setTimeout(() => { statusLine.approved = null; render(); }, 1500);
  }
  if (statusLine.sessionState === "waiting" && cat === "tool_rejected") {
    statusLine.sessionState = "active"; statusLine.waitingTool = null;
  }
  if (cat === "user_query") {
    statusLine.errors = 0; statusLine.apiError = null;
    statusLine.sessionState = "active"; statusLine.sessionStartTs = statusLine.sessionStartTs || Date.now();
    phase = "active";
  }
  if (cat === "tool_failure" || cat === "tool_rejected") statusLine.errors++;
  if (cat === "stop_failure") statusLine.apiError = json?.data?.reason || "API error";
  if (cat === "Notification" && statusLine.sessionState !== "waiting") { statusLine.sessionState = "waiting"; }
  if (cat === "Stop") {
    statusLine.sessionState = "done"; statusLine.waitingTool = null;
    phase = "idle"; currentTool = null; thinkingActive = false;
    setTimeout(() => { if (statusLine.sessionState === "done") { statusLine.sessionState = "idle"; render(); } }, 10000);
  }
  if (cat === "Notification") { phase = "idle"; currentTool = null; thinkingActive = false; }
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

  // Skip hidden categories from rendering (state tracking above still runs)
  if (tuiHidden) { render(); return; }

  // Collapse post_tool into the matching USE line — append ✓ instead of a separate OK line
  if (cat === "post_tool") {
    const postSq = getSessionQueries(extractSessionId(json));
    for (let qi = postSq.length - 1; qi >= 0; qi--) {
      const q = postSq[qi];
      for (let ei = q.events.length - 1; ei >= 0; ei--) {
        if (q.events[ei].cat === "pre_tool" && !q.events[ei]._completed) {
          q.events[ei].line += ` ${FG.green}✓${RESET}`;
          q.events[ei]._completed = true;
          render(); return;
        }
      }
    }
    // No matching USE found — fall through to render as OK
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
    // Attach stashed prompt from PreToolUse
    if (pendingAgentPrompts.length > 0) {
      json.data._agentPrompt = pendingAgentPrompts.shift();
    }
    const agentPrompt = json?.data?._agentPrompt || "";
    const promptPreview = agentPrompt ? `${DIM}${agentPrompt.slice(0, 50)}${RESET}` : "";
    line += `${FG.cyan}${BOLD}▶ ${json?.data?.agent_type || "Agent"}${RESET} ${promptPreview}`;
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

  // Status-only events — don't add to query groups
  if (cat === "Stop" || cat === "Notification") { render(); return; }

  // Per-session query grouping (same architecture as window mode)
  const userQuery = extractUserQuery(json);
  const isSystemPrompt = userQuery && (userQuery.includes("<task-notification>") || userQuery.includes("<system-reminder>"));
  const isQueryBoundary = cat === "user_query" && userQuery && !isSystemPrompt;
  const eventObj = { line, cat, sessionId, ts: msg.ts, json };
  const sq = getSessionQueries(sessionId);

  if (isQueryBoundary) {
    // Dedup: skip if same query text within 5s in this session (backlog/live overlap)
    const lastQ = sq.length > 0 ? sq[sq.length - 1] : null;
    if (lastQ && lastQ.userQuery === userQuery && (msg.ts - lastQ.startTs < 5000)) {
      render(); return;
    }
    // Absorb preamble events into this query
    let preambleEvents = [];
    if (sq.length > 0 && sq[sq.length - 1]._preamble) {
      preambleEvents = sq.pop().events;
    }
    // Auto-collapse previous query in this session
    if (sq.length > 0) sq[sq.length - 1].collapsed = true;
    const q = { id: ++queryIdCounter, userQuery, sessionId, startTs: msg.ts, endTs: msg.ts, events: preambleEvents, collapsed: !autoFollow };
    sq.push(q);
    if (sq.length > MAX_QUERIES_PER_SESSION) sq.shift();
    hasNewQueries = true;
  } else if (cat === "tool_rejected") {
    // Rejection: search this session's queries for the last pre_tool
    const rejectMsg = json?.data?.message || null;
    const msgSuffix = rejectMsg ? `  ${FG.red}"${rejectMsg.slice(0, 40)}"${RESET}` : "";
    outer: for (let qi = sq.length - 1; qi >= 0; qi--) {
      for (let ei = sq[qi].events.length - 1; ei >= 0; ei--) {
        if (sq[qi].events[ei].cat === "pre_tool") {
          const orig = sq[qi].events[ei].line;
          sq[qi].events[ei].line = `${DIM}${FG.red}✗${RESET} ${DIM}${stripAnsi(orig)}${RESET}${msgSuffix}`;
          break outer;
        }
      }
    }
  } else {
    // Append to last query in this session, or create preamble
    if (sq.length === 0) {
      sq.push({ id: ++queryIdCounter, userQuery: null, sessionId, startTs: msg.ts, endTs: msg.ts, events: [], collapsed: true, _preamble: true });
    }
    const target = sq[sq.length - 1];
    target.events.push(eventObj);
    target.endTs = msg.ts;
  }

  render();
}

// ===== Rendering =====
function renderStatusLine(cols) {
  const parts = [];
  if (statusLine.approved) {
    parts.push(`${FG.green}●${RESET} Approved: ${statusLine.approved}`);
  } else if (statusLine.sessionState === "active") {
    let label = `${FG.green}●${RESET} Active`;
    if (statusLine.sessionStartTs) {
      const secs = Math.floor((Date.now() - statusLine.sessionStartTs) / 1000);
      label += ` ${DIM}${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s${RESET}`;
    }
    parts.push(label);
  } else if (statusLine.sessionState === "done") {
    parts.push(`${FG.green}●${RESET} Done`);
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
  parts.push(`${FG.gray}c${RESET}${DIM}:${RESET}${FG.cyan}${allCollapsed ? "▶ Expand" : "▼ Collapse"}${RESET}`);
  parts.push(clearPending ? `${FG.red}x${RESET}${DIM}:${RESET}${FG.red}Press x again to clear${RESET}` : `${FG.gray}x${RESET}${DIM}:${RESET}${FG.cyan}Clear${RESET}`);
  // Calculate visible length before adding window button
  const sep = `${DIM}  │  ${RESET}`;
  const beforeBtn = parts.join(sep);
  const visLen = beforeBtn.replace(/\x1b\[[0-9;]*m/g, "").length;
  windowBtnCol = visLen + 5 + 1; // +5 for " │ " separator, +1 for 1-based
  parts.push(`${FG.gray}w${RESET}${DIM}:${RESET}${FG.cyan}⧉ Window${RESET}`);
  return padLine(parts.join(sep), cols);
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

function buildDetailLines(ev, cols) {
  const lines = [];
  const w = cols - 2;
  const d = ev.json?.data || {};
  const cat = ev.cat;

  // Header: category + tool name + timestamp
  const ts = new Date(ev.ts).toLocaleTimeString("en-US", { hour12: false });
  lines.push(`${BOLD}${catColors[cat] || FG.white}${cat.toUpperCase()}${RESET}  ${DIM}${ts}${RESET}`);
  if (d.tool_name) lines.push(`${FG.white}Tool: ${d.tool_name}${RESET}`);
  lines.push("");

  // Full content based on category
  if (cat === "thinking") {
    lines.push(`${BOLD}Thinking:${RESET}`);
    const text = d.thinking || "";
    wrapText(text, w).forEach(l => lines.push(` ${FG.magenta}${l}${RESET}`));
  } else if (cat === "pre_tool") {
    const input = d.tool_input || {};
    if (input.prompt) {
      lines.push(`${BOLD}Prompt:${RESET}`);
      wrapText(input.prompt, w).forEach(l => lines.push(` ${l}`));
    } else if (input.command) {
      lines.push(`${BOLD}Command:${RESET}`);
      wrapText(input.command, w).forEach(l => lines.push(` ${FG.yellow}${l}${RESET}`));
    } else if (input.file_path) {
      lines.push(`${BOLD}File:${RESET} ${input.file_path}`);
      if (input.old_string) { lines.push(`${BOLD}Old:${RESET}`); wrapText(input.old_string, w).forEach(l => lines.push(` ${FG.red}${l}${RESET}`)); }
      if (input.new_string) { lines.push(`${BOLD}New:${RESET}`); wrapText(input.new_string, w).forEach(l => lines.push(` ${FG.green}${l}${RESET}`)); }
      if (input.content) { lines.push(`${BOLD}Content:${RESET}`); wrapText(input.content.slice(0, 2000), w).forEach(l => lines.push(` ${l}`)); }
    } else if (input.pattern) {
      lines.push(`${BOLD}Pattern:${RESET} ${input.pattern}`);
      if (input.path) lines.push(`${BOLD}Path:${RESET} ${input.path}`);
    } else if (input.description) {
      lines.push(`${BOLD}Description:${RESET}`);
      wrapText(input.description, w).forEach(l => lines.push(` ${l}`));
    } else {
      lines.push(`${BOLD}Input:${RESET}`);
      wrapText(JSON.stringify(input, null, 2), w).forEach(l => lines.push(` ${DIM}${l}${RESET}`));
    }
  } else if (cat === "post_tool") {
    const resp = d.tool_response || {};
    const text = resp.stdout || resp.content || d.tool_result || "";
    if (typeof text === "string" && text) {
      lines.push(`${BOLD}Output:${RESET}`);
      wrapText(text.slice(0, 3000), w).forEach(l => lines.push(` ${FG.green}${l}${RESET}`));
    } else if (typeof text === "object") {
      lines.push(`${BOLD}Response:${RESET}`);
      wrapText(JSON.stringify(text, null, 2).slice(0, 3000), w).forEach(l => lines.push(` ${DIM}${l}${RESET}`));
    }
  } else if (cat === "sub_agent") {
    lines.push(`${BOLD}Agent Type:${RESET} ${d.agent_type || "Agent"}`);
    lines.push(`${BOLD}Agent ID:${RESET} ${d.agent_id || "unknown"}`);
    // Try to get the prompt from the stored _agentPrompt or description
    const prompt = d._agentPrompt || d.prompt || d.description || "";
    if (prompt) {
      lines.push("");
      lines.push(`${BOLD}Prompt:${RESET}`);
      wrapText(prompt, w).forEach(l => lines.push(` ${l}`));
    }
  } else if (cat === "sub_agent_result") {
    lines.push(`${BOLD}Agent Type:${RESET} ${d.agent_type || "Agent"}`);
    const msg = d.last_assistant_message || "";
    if (msg) {
      lines.push("");
      lines.push(`${BOLD}Result:${RESET}`);
      wrapText(msg, w).forEach(l => lines.push(` ${l}`));
    }
  } else if (cat === "tool_failure") {
    lines.push(`${BOLD}Error:${RESET}`);
    wrapText(String(d.error || "unknown error"), w).forEach(l => lines.push(` ${FG.red}${l}${RESET}`));
  } else if (cat === "error") {
    lines.push(`${BOLD}Error:${RESET}`);
    wrapText(String(d.tool_result || d.error || "error"), w).forEach(l => lines.push(` ${FG.red}${l}${RESET}`));
  } else {
    // Generic: dump JSON
    lines.push(`${BOLD}Data:${RESET}`);
    wrapText(JSON.stringify(d, null, 2).slice(0, 3000), w).forEach(l => lines.push(` ${DIM}${l}${RESET}`));
  }

  return lines;
}

function wrapText(text, width) {
  const lines = [];
  for (const raw of String(text).split("\n")) {
    if (raw.length <= width) {
      lines.push(raw);
    } else {
      for (let i = 0; i < raw.length; i += width) {
        lines.push(raw.slice(i, i + width));
      }
    }
  }
  return lines;
}

function render() {
  // Rebuild flat queries list from per-session data
  queries = [];
  for (const [, sq] of sessionQueries) {
    for (const q of sq) queries.push(q);
  }

  // Auto-follow: focus on latest query
  if (autoFollow && queries.length > 0) {
    // Find the most recent query across all sessions
    let latestIdx = 0, latestTs = 0;
    for (let i = 0; i < queries.length; i++) {
      if (queries[i].endTs >= latestTs) { latestTs = queries[i].endTs; latestIdx = i; }
    }
    focusIdx = latestIdx;
  }

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Header
  const connStr = connected ? `${FG.green}●${RESET}` : `${FG.red}●${RESET}`;
  const phaseColor = { active: FG.green, exploring: FG.magenta, implementing: FG.blue, debugging: FG.red, testing: FG.green, planning: FG.yellow, idle: FG.gray }[phase] || FG.gray;
  let header = `${BOLD} LOUPE ${RESET} ${connStr} ${phaseColor}${BOLD}${thinkingActive ? "thinking" : phase}${RESET}`;
  if (currentTool) header += `  ${DIM}▸ ${currentTool.name}${RESET}`;

  let stats = ` ${DIM}events:${RESET}${eventCount}  ${DIM}files:${RESET}${fileSet.size}  ${DIM}tokens:${RESET}${formatTokens(tokenTotal)}`;
  if (errorCount > 0) stats += `  ${FG.red}errors:${errorCount}${RESET}`;
  if (sessions.size > 1) stats += `  ${DIM}sessions:${RESET}${sessions.size}`;

  const sep = DIM + "─".repeat(cols) + RESET;
  const showTabs = true;
  const logRows = rows - 6;

  let output = `${ESC}[H`;
  output += padLine(header, cols) + "\n";
  output += padLine(stats, cols) + "\n";

  // Session tabs
  if (showTabs) {
    let tabLine = " ";
    tabLine += sessionFilter === "all" ? `${BOLD}${FG.cyan}[1:All]${RESET}` : `${DIM}[1:All]${RESET}`;
    let idx = 2;
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

  // Detail view mode — show full content for selected event
  if (navLevel === "detail" && focusIdx >= 0 && focusIdx < queries.length) {
    const q = queries[focusIdx];
    const ev = (eventFocusIdx >= 0 && eventFocusIdx < q.events.length) ? q.events[eventFocusIdx] : null;
    const detailLines = ev ? buildDetailLines(ev, cols) : [`${DIM}No event selected${RESET}`];
    const titleLine = `${FG.cyan}${BOLD}Detail${RESET}  ${DIM}Esc to close  ↑↓ scroll${RESET}`;
    output += padLine(titleLine, cols) + "\n";
    const detailRows = logRows - 1;
    detailScroll = Math.max(0, Math.min(detailScroll, Math.max(0, detailLines.length - detailRows)));
    const visible = detailLines.slice(detailScroll, detailScroll + detailRows);
    for (let i = 0; i < detailRows; i++) {
      output += padLine(visible[i] || "", cols) + "\n";
    }
    output += sep + "\n";
    const showTreeDetail = agentTreeVisible && cols >= 80 && (sessionFilter === "all" || agentTree.some(a => true));
    const detailStatusWidth = showTreeDetail ? Math.max(40, cols - TREE_WIDTH - 1) : cols;
    output += renderStatusLine(detailStatusWidth);
    process.stdout.write(output);
    return;
  }

  // Build flat row list from queries
  const rowData = [];

  navOrder = []; // rebuild navigation order

  function addQueryRows(q) {
    if (q._preamble) return; // skip preamble queries
    const realIdx = queries.indexOf(q);
    navOrder.push(realIdx);
    const isFocused = realIdx === focusIdx;
    const chevron = q.collapsed ? "▶" : "▼";
    const fc = isFocused && navLevel === "query" ? `${BOLD}${FG.cyan}` : (isFocused ? `${BOLD}${FG.white}` : DIM);
    const queryText = q.userQuery ? q.userQuery.slice(0, 40) : "(preamble)";
    const count = q.events.length;
    const time = new Date(q.startTs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
    const cursor = isFocused && navLevel === "query" ? `${FG.cyan}▸${RESET}` : " ";
    const headerLine = `${cursor}${fc}${chevron}${RESET} ${fc}${queryText}${RESET}  ${DIM}${count}${RESET}  ${DIM}${time}${RESET}`;
    rowData.push({ text: headerLine, isHeader: true, queryIdx: realIdx, eventIdx: -1 });

    if (!q.collapsed) {
      let evIdx = 0;
      for (const ev of q.events) {
        const isEventFocused = navLevel === "event" && realIdx === focusIdx && evIdx === eventFocusIdx;
        const prefix = isEventFocused ? `${FG.cyan}▸${RESET} ` : "  ";
        rowData.push({ text: `${prefix}${ev.line}`, isHeader: false, queryIdx: realIdx, eventIdx: evIdx });
        evIdx++;
      }
    }
  }

  if (sessionFilter === "all" && sessions.size > 0) {
    // Iterate per-session query lists directly (no filtering needed)
    const sessionIds = [...sessions.keys()];
    for (let si = 0; si < sessionIds.length; si++) {
      const sid = sessionIds[si];
      const sInfo = sessions.get(sid);
      const sq = sessionQueries.get(sid) || [];
      const visible = sq.filter(q => !q._preamble);
      if (visible.length === 0) continue;

      const sLabel = sInfo.label || sid.slice(0, 8);
      const sCount = sInfo.eventCount || 0;
      const sNum = si + 2;
      rowData.push({ text: `${BOLD}${FG.cyan}── ${sNum}:${sLabel}${RESET} ${DIM}(${sCount} events)${RESET}`, isHeader: false, queryIdx: -1, eventIdx: -1, isSessionHeader: true });

      for (const q of visible) addQueryRows(q);
    }
  } else if (sessionFilter !== "all") {
    // Single session filter
    const sq = sessionQueries.get(sessionFilter) || [];
    for (const q of sq) { if (!q._preamble) addQueryRows(q); }
  } else {
    // No sessions yet — show all queries
    for (const q of queries) { if (!q._preamble) addQueryRows(q); }
  }

  // Empty state
  if (rowData.length === 0) {
    const emptyMsg = connected ? `${DIM}Waiting for events...${RESET}` : `${FG.red}Disconnected${RESET}`;
    const mid = Math.floor(logRows / 2);
    for (let i = 0; i < logRows; i++) {
      output += padLine(i === mid ? emptyMsg : "", cols) + "\n";
    }
    output += sep + "\n";
    output += renderStatusLine(cols);
    process.stdout.write(output);
    return;
  }

  // Scroll to keep focused row visible
  let focusRow = -1;
  if (navLevel === "event" && focusIdx >= 0) {
    focusRow = rowData.findIndex(r => !r.isHeader && r.queryIdx === focusIdx && r.eventIdx === eventFocusIdx);
  }
  if (focusRow < 0 && focusIdx >= 0) {
    focusRow = rowData.findIndex(r => r.isHeader && r.queryIdx === focusIdx);
  }
  if (focusRow >= 0) {
    if (focusRow < scrollOffset) scrollOffset = focusRow;
    if (focusRow >= scrollOffset + logRows) scrollOffset = focusRow - logRows + 1;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, rowData.length - logRows)));

  const visibleRows = rowData.slice(scrollOffset, scrollOffset + logRows);
  rowMap = visibleRows.map(r => r ? { type: r.isHeader ? "header" : "event", queryIdx: r.queryIdx, eventIdx: r.eventIdx } : null);

  // Render rows with optional agent tree pane (hide tree if terminal too narrow)
  const showTree = agentTreeVisible && cols >= 80 && (sessionFilter === "all" || agentTree.some(a => true));
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
  output += renderStatusLine(showTree ? logWidth : cols);

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

  // Esc — go back one level
  if (s === "\x1b" && buf.length === 1) {
    if (navLevel === "detail") { navLevel = "event"; detailScroll = 0; }
    else if (navLevel === "event") { navLevel = "query"; eventFocusIdx = -1; }
    render(); return;
  }

  if (s === "\x03") { cleanup(); process.exit(0); }
  // q quits at query level, goes back at event/detail level
  if (s === "q") {
    if (navLevel === "detail") { navLevel = "event"; detailScroll = 0; render(); return; }
    if (navLevel === "event") { navLevel = "query"; eventFocusIdx = -1; render(); return; }
    cleanup(); process.exit(0);
  }

  // Global keys — work at any level
  if (s === "1") { sessionFilter = "all"; render(); return; }
  if (s >= "2" && s <= "9") {
    const idx = parseInt(s) - 2;
    const sessionIds = [...sessions.keys()];
    if (idx < sessionIds.length) sessionFilter = sessionIds[idx];
    render(); return;
  }
  if (s === "c") {
    allCollapsed = !allCollapsed;
    for (const [, sq] of sessionQueries) {
      for (const q of sq) q.collapsed = allCollapsed;
    }
    render(); return;
  }
  if (s === "w") { openWindow(); render(); return; }
  if (s === "x") {
    if (clearPending) {
      // Second press — clear all
      clearPending = false;
      if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
      eventCount = 0; errorCount = 0; tokenTotal = 0;
      fileSet.clear();
      sessionQueries.clear(); queries = []; queryIdCounter = 0;
      focusIdx = -1; autoFollow = true; hasNewQueries = false; scrollOffset = 0;
      sessions.clear(); sessionFilter = "all";
      phase = "idle"; currentTool = null; thinkingActive = false;
      Object.assign(statusLine, { sessionState: "idle", waitingTool: null, errors: 0, apiError: null, agentsRunning: 0, agentsTotal: 0, tasksCreated: 0, tasksCompleted: 0, sessionStartTs: null });
      agentTree.length = 0; agentTreeVisible = false;
    } else {
      // First press — arm confirmation
      clearPending = true;
      clearTimer = setTimeout(() => { clearPending = false; render(); }, 2000);
    }
    render(); return;
  }

  // ← / h = back one level
  const isLeft = s === "h" || s === "\x1b[D";
  // → / l = forward one level
  const isRight = s === "l" || s === "\x1b[C";
  // ↑ / k = up within level
  const isUp = s === "k" || s === "\x1b[A";
  // ↓ / j = down within level
  const isDown = s === "j" || s === "\x1b[B";
  const isEnter = s === "\r" || s === " ";

  // === Detail level ===
  if (navLevel === "detail") {
    if (isDown) { detailScroll++; render(); return; }
    if (isUp) { detailScroll = Math.max(0, detailScroll - 1); render(); return; }
    if (isLeft || isEnter) { navLevel = "event"; detailScroll = 0; render(); return; }
    if (s === "g") { detailScroll = 0; render(); return; }
    if (s === "G") { detailScroll = 99999; render(); return; }
    return;
  }

  // === Event level ===
  if (navLevel === "event") {
    const q = queries[focusIdx];
    if (!q) { navLevel = "query"; render(); return; }

    if (isDown) { if (eventFocusIdx < q.events.length - 1) eventFocusIdx++; render(); return; }
    if (isUp) { if (eventFocusIdx > 0) eventFocusIdx--; render(); return; }
    if (isLeft) { navLevel = "query"; eventFocusIdx = -1; render(); return; }
    if (isRight || isEnter) {
      if (eventFocusIdx >= 0 && eventFocusIdx < q.events.length) {
        navLevel = "detail"; detailScroll = 0;
      }
      render(); return;
    }
    if (s === "g") { eventFocusIdx = 0; render(); return; }
    if (s === "G") { eventFocusIdx = q.events.length - 1; render(); return; }
    return;
  }

  // === Query level ===
  // Navigate using visual order (navOrder), not raw query index
  if (isDown) {
    const curPos = navOrder.indexOf(focusIdx);
    if (curPos < navOrder.length - 1) {
      focusIdx = navOrder[curPos + 1];
      autoFollow = curPos + 1 === navOrder.length - 1;
      if (autoFollow) hasNewQueries = false;
    }
    render(); return;
  }

  if (isUp) {
    const curPos = navOrder.indexOf(focusIdx);
    if (curPos > 0) {
      focusIdx = navOrder[curPos - 1];
      autoFollow = false;
    }
    render(); return;
  }

  // Enter = toggle expand/collapse
  if (isEnter) {
    if (focusIdx >= 0 && focusIdx < queries.length) {
      queries[focusIdx].collapsed = !queries[focusIdx].collapsed;
    }
    render(); return;
  }

  // → = enter event level (expand first if collapsed)
  if (isRight) {
    if (focusIdx >= 0 && focusIdx < queries.length) {
      queries[focusIdx].collapsed = false;
      navLevel = "event";
      eventFocusIdx = 0;
    }
    render(); return;
  }

  // ← = collapse query
  if (isLeft) {
    if (focusIdx >= 0 && focusIdx < queries.length) {
      queries[focusIdx].collapsed = true;
    }
    render(); return;
  }

  if (s === "g") {
    focusIdx = navOrder.length > 0 ? navOrder[0] : 0;
    autoFollow = false; render(); return;
  }

  if (s === "G") {
    focusIdx = navOrder.length > 0 ? navOrder[navOrder.length - 1] : queries.length - 1;
    autoFollow = true; hasNewQueries = false;
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
    const rows = process.stdout.rows || 24;
    // Click on "w:⧉ Window" in status line (last row)
    if (row === rows && windowBtnCol > 0 && col >= windowBtnCol) {
      openWindow();
      return;
    }

    const showTabs = true;
    const contentStartRow = 5; // header(2) + tabs(1) + sep(1) + 1-indexed
    const contentRow = row - contentStartRow;
    if (contentRow >= 0 && contentRow < rowMap.length) {
      const mapped = rowMap[contentRow];
      if (mapped && mapped.type === "header") {
        const q = queries[mapped.queryIdx];
        if (q) { q.collapsed = !q.collapsed; focusIdx = mapped.queryIdx; navLevel = "query"; }
        render();
      } else if (mapped && mapped.type === "event" && mapped.eventIdx >= 0) {
        focusIdx = mapped.queryIdx;
        eventFocusIdx = mapped.eventIdx;
        navLevel = "detail";
        detailScroll = 0;
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
