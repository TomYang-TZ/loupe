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
const STRIKE = `${ESC}[9m`;
const ITALIC = `${ESC}[3m`;
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ENABLE_MOUSE = `${ESC}[?1000h`;
const DISABLE_MOUSE = `${ESC}[?1000l`;
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;

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
let tokenIn = 0;
let tokenOut = 0;
let tokenCacheRead = 0;
let tokenCacheCreate = 0;
const fileSet = new Set();
const erroredFiles = new Set();
let activeFile = null;
let planningStrike = false; // briefly true when planning phase ends

// Query-grouped data model — per session, like window mode
const sessionQueries = new Map(); // sessionId → [query objects]
const sessionAgentStacks = new Map();  // sessionId → [{ agentEvent, children: [], resultEvent: null }]
const tuiAgentSessionMap = new Map();  // childSessionId → agent node
const tuiChildSessionMap = new Map();  // childSessionId → parentSessionId
const tuiPendingAgentSpawns = new Map(); // parentSessionId → { count, ts }
let queryIdCounter = 0;
const MAX_QUERIES_PER_SESSION = 100;

// Flat derived list for navigation (rebuilt each render)
let queries = [];
let focusIdx = -1;
let autoFollow = true;
let hasNewQueries = false;
let scrollOffset = 0;
const earliestTsBySid = new Map(); // per-session oldest event ts for "load more"
let loadingHistory = false;  // true while waiting for history_done
let historyStatus = null;    // brief status message after load
let historyBuffer = [];      // buffer history events before merging
let historyTargetSid = null; // session ID that was requested for history load

// Search state
let searchMode = false;
let searchQuery = "";

// Session picker state
let sessionPickerVisible = false;
let sessionPickerList = [];   // [{id, project, cwd, startTs, size, mtime}]
let sessionPickerIdx = 0;
let sessionPickerScroll = 0;
let sessionPickerLoadingId = null; // session ID being loaded, to switch tab on done

// Two-level navigation
let navLevel = "query";   // "query" | "event" | "detail"
let eventFocusIdx = -1;   // which event within the focused query (flat index including agent children)
let eventAutoFollow = true; // auto-advance to newest event when at tail
let detailScroll = 0;     // scroll offset within detail view

// Count total flat event rows for a query (respects collapsed agents)
function queryEventCount(q) {
  let count = 0;
  for (const ev of q.events) {
    if (ev.agentEvent) {
      count++; // agent header always visible
      if (!ev.collapsed) {
        count += ev.children.length;
        if (ev.resultEvent) count++;
      }
    } else {
      count++;
    }
  }
  return count;
}

// Get the flat event object at index N (respects collapsed agents)
// Returns the event object, or the agent container if idx points to the agent header
function queryEventAt(q, idx) {
  let i = 0;
  for (const ev of q.events) {
    if (ev.agentEvent) {
      if (i === idx) return ev.agentEvent;
      i++;
      if (!ev.collapsed) {
        for (const child of ev.children) {
          if (i === idx) return child;
          i++;
        }
        if (ev.resultEvent) {
          if (i === idx) return ev.resultEvent;
          i++;
        }
      }
    } else {
      if (i === idx) return ev;
      i++;
    }
  }
  return null;
}

// Get the agent container at flat index (or null if not an agent header)
function queryAgentAt(q, idx) {
  let i = 0;
  for (const ev of q.events) {
    if (ev.agentEvent) {
      if (i === idx) return ev;
      i++;
      if (!ev.collapsed) {
        i += ev.children.length;
        if (ev.resultEvent) i++;
      }
    } else {
      i++;
    }
  }
  return null;
}

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
let agentFocus = false;    // true = cursor is in agent panel
let agentFocusIdx = -1;    // which agent is focused
let agentDeletePending = false;
let agentDeleteTimer = null;
let topicStatus = null; // null | "classifying..." | "N topics found" | error
let topicAllPending = false; // double-press confirmation for classifying all sessions
let topicAllTimer = null;

// Mouse click mapping
let rowMap = [];
let windowBtnCol = -1; // column where "w:⧉ Window" starts in status line
// Navigation order — maps visual position to query index (rebuilt each render)
let navOrder = [];
// Queue of agent prompts from PreToolUse, consumed by SubagentStart in order
const pendingAgentPrompts = [];
let allCollapsed = false;
let isBacklog = true;
let clearPending = false;
let clearTimer = null;
let deletePending = false;
let deleteTimer = null;
let deleteTargetSession = null; // which session 'd' was armed for
const deletedSessionIds = new Set(); // persist across backlog replays
let stopPending = false;
let stopTimer = null;

// ===== Actions =====
function stopServer() {
  // Hit /stop which kills app, TUI, and server
  const http = require("http");
  http.get(`http://localhost:${PORT}/stop`, () => {}).on("error", () => {});
  // Fallback: exit after 1s if server doesn't kill us
  setTimeout(() => { cleanup(); process.exit(0); }, 1000);
}

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
  tool_failure: FG.red, tool_error: FG.red, stop_failure: FG.red,
  task_created: FG.magenta, task_completed: FG.green,
  tool_rejected: FG.red,
  topic_shift: FG.magenta,
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
    if (data.is_error) return "tool_error";
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
  if (type === "topic_shift") return "topic_shift";
  if (type === "topic_clear") return "topic_clear";
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
      isBacklog = false;
      // Normalize transient states from backlog replay
      phase = "idle"; currentTool = null; thinkingActive = false;
      statusLine.sessionState = "idle"; statusLine.waitingTool = null;
      statusLine.approved = null;
      render();
    }
    if (msg.type === "reset") {
      eventCount = 0; errorCount = 0; tokenTotal = 0; tokenIn = 0; tokenOut = 0; tokenCacheRead = 0; tokenCacheCreate = 0;
      fileSet.clear(); erroredFiles.clear(); activeFile = null;
      sessionQueries.clear(); queries = []; queryIdCounter = 0; sessionAgentStacks.clear(); tuiAgentSessionMap.clear(); tuiChildSessionMap.clear(); tuiPendingAgentSpawns.clear(); eventAutoFollow = true;
      focusIdx = -1; autoFollow = true; hasNewQueries = false; earliestTsBySid.clear();
      sessions.clear(); sessionFilter = "all";
      phase = "idle"; currentTool = null;
      Object.assign(statusLine, { sessionState: "idle", waitingTool: null, errors: 0, apiError: null, agentsRunning: 0, agentsTotal: 0, tasksCreated: 0, tasksCompleted: 0, sessionStartTs: null });
      agentTree.length = 0; agentTreeVisible = false; agentFocus = false; agentFocusIdx = -1;
    }
    return;
  }
  if (msg.type === "classify_topics_result") {
    if (msg.status === "running") { topicStatus = "classifying..."; }
    else if (msg.status === "done") { topicStatus = `${msg.count} topic${msg.count !== 1 ? "s" : ""} found`; setTimeout(() => { topicStatus = null; render(); }, 3000); }
    else if (msg.error) { topicStatus = msg.error; setTimeout(() => { topicStatus = null; render(); }, 3000); }
    render(); return;
  }
  if (msg.type === "history") {
    // Buffer history events — merge on history_done
    historyBuffer.push({ ...msg, type: "line" });
    return;
  }
  if (msg.type === "history_done") {
    loadingHistory = false;
    const count = historyBuffer.length;
    if (count > 0) {
      // Use the session ID captured at request time (not current sessionFilter which may have changed)
      const targetSid = historyTargetSid;
      const stashedTarget = targetSid ? [...(sessionQueries.get(targetSid) || [])] : [];
      if (targetSid) sessionQueries.delete(targetSid);

      // Process history events chronologically as backlog
      const saved = isBacklog; isBacklog = true;
      historyBuffer.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      for (const hMsg of historyBuffer) {
        handleMessage(JSON.stringify(hMsg));
      }
      isBacklog = saved;

      // Merge: prepend history queries before stashed, dedup by startTs
      if (targetSid) {
        const historyQs = sessionQueries.get(targetSid) || [];
        const merged = [...historyQs];
        for (const sq of stashedTarget) {
          const isDup = merged.some(hq => hq.userQuery === sq.userQuery && Math.abs(hq.startTs - sq.startTs) < 5000);
          if (!isDup) merged.push(sq);
        }
        merged.sort((a, b) => a.startTs - b.startTs);
        sessionQueries.set(targetSid, merged);
      }
    }
    historyBuffer = [];
    historyTargetSid = null;
    historyStatus = count > 0 ? `Loaded ${count} events` : "No more events";
    setTimeout(() => { historyStatus = null; render(); }, 2000);
    render(); return;
  }
  if (msg.type === "sessions_list") {
    // Session picker data — handled in Part 2
    handleSessionsList(msg.sessions || []);
    return;
  }
  if (msg.type === "session_load") {
    // Buffer session load events — merge on session_load_done
    historyBuffer.push({ ...msg, type: "line" });
    return;
  }
  if (msg.type === "session_load_done") {
    loadingHistory = false;
    if (historyBuffer.length > 0) {
      // Process buffered events chronologically
      const saved = isBacklog; isBacklog = true;
      historyBuffer.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      for (const hMsg of historyBuffer) {
        handleMessage(JSON.stringify(hMsg));
      }
      isBacklog = saved;
      // Sort queries by time
      for (const [, sq] of sessionQueries) {
        sq.sort((a, b) => a.startTs - b.startTs);
      }
    }
    historyBuffer = [];
    historyStatus = `Session loaded (${msg.count} events)`;
    setTimeout(() => { historyStatus = null; render(); }, 3000);
    isBacklog = false;
    phase = "idle"; currentTool = null; thinkingActive = false;
    // Switch to the loaded session's tab
    if (sessionPickerLoadingId && sessions.has(sessionPickerLoadingId)) {
      sessionFilter = sessionPickerLoadingId;
      focusIdx = -1; autoFollow = true;
    }
    sessionPickerLoadingId = null;
    render(); return;
  }
  if (msg.type !== "line") return;

  eventCount++;
  const json = msg.json;
  const evtSid = extractSessionId(json);
  if (msg.ts && evtSid) {
    const prev = earliestTsBySid.get(evtSid) || Infinity;
    if (msg.ts < prev) earliestTsBySid.set(evtSid, msg.ts);
  }
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

  // Phase/status/agent tracking — skip during backlog replay
  if (!isBacklog) {
    if (cat === "thinking") { thinkingActive = true; phase = "thinking"; }
    if (cat === "pre_tool" && json?.data) {
      thinkingActive = false;
      const tool = extractToolInfo(json);
      if (tool) {
        currentTool = tool;
        // Strikethrough when exiting plan mode
        if (tool.name.includes("ExitPlanMode") && phase === "planning") {
          planningStrike = true;
          setTimeout(() => { planningStrike = false; render(); }, 1500);
        }
        const newPhase = detectPhaseFromTool(tool.name, json.data.tool_input?.command, phase);
        if (newPhase) phase = newPhase;
        // Track active file for debugging detection
        const filePath = json.data.tool_input?.file_path;
        if (filePath) activeFile = filePath;
        // Override to debugging if touching a previously-errored file
        if (erroredFiles.size > 0 && filePath && erroredFiles.has(filePath)) {
          phase = "debugging";
        }
      }
    }
    if (cat === "error" || cat === "tool_failure" || cat === "tool_error") {
      errorCount++;
      phase = "debugging";
      if (activeFile) erroredFiles.add(activeFile);
    }

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
    if (cat === "sub_agent") { statusLine.agentsRunning++; statusLine.agentsTotal++; phase = "orchestrating"; }
    if (cat === "sub_agent_result") { statusLine.agentsRunning = Math.max(0, statusLine.agentsRunning - 1); }
    if (cat === "task_created") { statusLine.tasksCreated++; phase = "planning"; }
    if (cat === "task_completed") {
      statusLine.tasksCompleted++;
      if (phase === "planning") {
        planningStrike = true;
        setTimeout(() => { planningStrike = false; render(); }, 1500);
      }
    }

    if (cat === "sub_agent") {
      agentTree.push({ id: json?.data?.agent_id || `agent-${agentTree.length}`, type: json?.data?.agent_type || "Agent", status: "running", startTs: Date.now(), endTs: null });
      agentTreeVisible = true;
    }
    if (cat === "sub_agent_result") {
      const id = json?.data?.agent_id;
      const agent = (id && agentTree.find(a => a.id === id && a.status === "running")) || agentTree.find(a => a.status === "running");
      if (agent) { agent.status = "done"; agent.endTs = Date.now(); }
      if (agentTree.length > 0 && agentTree.every(a => a.status === "done")) {
        setTimeout(() => { if (agentTree.every(a => a.status === "done")) { agentTreeVisible = false; agentTree.length = 0; agentFocus = false; agentFocusIdx = -1; render(); } }, 5000);
      }
    }
  }

  // Token accumulation — runs for both backlog and live events
  const usage = json?.data?.meta || json?.data?.message?.usage || json?.message?.usage;
  if (usage) {
    const inT = usage.input_tokens || 0;
    const outT = usage.output_tokens || 0;
    const cacheR = usage.cache_read || usage.cache_read_input_tokens || 0;
    const cacheC = usage.cache_create || usage.cache_creation_input_tokens || 0;
    tokenTotal += inT + outT;
    tokenIn += inT; tokenOut += outT;
    tokenCacheRead += cacheR; tokenCacheCreate += cacheC;
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
    tool_failure: "FLD", tool_error: "ERR", stop_failure: "API",
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
    let qText = json?.data?.user_query || json?.data?.prompt || "";
    // Clean up system notifications — extract readable content
    if (qText.includes("<task-notification>")) {
      const taskMatch = qText.match(/<task-id>[^<]*<\/task-id>\s*([\s\S]*)/);
      qText = taskMatch ? `[task] ${taskMatch[1].replace(/<[^>]+>/g, "").trim()}` : "[task notification]";
    } else if (qText.includes("<system-reminder>")) {
      qText = "[system reminder]";
    }
    // Strip any remaining XML tags
    qText = qText.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    line += `${FG.yellow}${qText.slice(0, 60)}${RESET}`;
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
  } else if (cat === "tool_failure" || cat === "tool_error") {
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
    // Attach stashed prompt from PreToolUse (live hook events)
    if (pendingAgentPrompts.length > 0) {
      json.data._agentPrompt = pendingAgentPrompts.shift();
    }
    const agentPrompt = json?.data?._agentPrompt || json?.data?.description || json?.data?.prompt || "";
    const promptPreview = agentPrompt ? `${DIM}${agentPrompt.slice(0, 50)}${RESET}` : "";
    line += `${FG.cyan}${BOLD}▶ ${json?.data?.agent_type || "Agent"}${RESET} ${promptPreview}`;
  } else if (cat === "sub_agent_result") {
    line += `${FG.cyan}◀ ${json?.data?.agent_type || "Agent"}${RESET} ${DIM}${String(json?.data?.last_assistant_message || "").split("\n")[0].slice(0, 40)}${RESET}`;
  } else {
    line += `${DIM}${String(json?.data?.text || json?.data?.thinking || "").replace(/\n/g, " ").slice(0, 50)}${RESET}`;
  }

  // Session tracking
  let sessionId = extractSessionId(json);
  if (sessionId && deletedSessionIds.has(sessionId)) { render(); return; }
  if (sessionId && !sessions.has(sessionId)) {
    sessions.set(sessionId, { id: sessionId, label: json?.data?.cwd?.split("/").pop() || sessionId.slice(0, 8), eventCount: 0, active: true, lastEventTs: msg.ts });
  }
  if (sessionId && sessions.has(sessionId)) {
    const sInfo = sessions.get(sessionId);
    sInfo.eventCount++;
    sInfo.lastEventTs = msg.ts;
    if (cat === "session_end") sInfo.active = false;
    else if (cat !== "sub_agent_result") sInfo.active = true;
  }

  // Status-only events — don't add to query groups
  if (cat === "Stop" || cat === "Notification") { render(); return; }

  // Session start/end — render as separator between queries, not inside them
  if (cat === "session_start" || cat === "session_end") {
    const sq2 = getSessionQueries(sessionId);
    if (sq2.length > 0) sq2[sq2.length - 1].collapsed = true;
    const label = cat === "session_start" ? `Session ${json?.data?.source || "started"}` : "Session ended";
    sq2.push({ id: ++queryIdCounter, userQuery: null, sessionId, startTs: msg.ts, endTs: msg.ts, events: [], collapsed: true, _separator: true, _separatorLabel: label, _separatorCat: cat });
    render(); return;
  }

  // Topic shift — render as separator
  if (cat === "topic_clear") {
    // Remove all topic separators from this session
    const sq2 = getSessionQueries(sessionId);
    for (let i = sq2.length - 1; i >= 0; i--) {
      if (sq2[i]._separator && sq2[i]._separatorCat === "topic_shift") sq2.splice(i, 1);
    }
    render(); return;
  }
  if (cat === "topic_shift") {
    const sq2 = getSessionQueries(sessionId);
    // Skip topics for sessions with no actual queries (e.g., outside backlog window)
    const hasQueries = sq2.some(q => q.userQuery && !q._preamble && !q._separator);
    if (!hasQueries) { render(); return; }
    const title = json?.data?.title || "New topic";
    const lastQueryTs = json?.data?.last_query_ts || 0;
    const sep = { id: ++queryIdCounter, userQuery: null, sessionId, startTs: msg.ts, endTs: msg.ts, events: [], collapsed: true, _separator: true, _separatorLabel: title, _separatorCat: "topic_shift", _lastQueryTs: lastQueryTs };
    // Insert at correct position based on timestamp
    let insertIdx = sq2.length;
    for (let i = 0; i < sq2.length; i++) {
      if (sq2[i].startTs >= msg.ts) { insertIdx = i; break; }
    }
    sq2.splice(insertIdx, 0, sep);
    render(); return;
  }

  // Track agent spawns for child session remapping
  if (cat === "sub_agent") {
    const pending = tuiPendingAgentSpawns.get(sessionId) || { count: 0, ts: 0 };
    pending.count++; pending.ts = msg.ts;
    tuiPendingAgentSpawns.set(sessionId, pending);
  }
  if (cat === "sub_agent_result") {
    const pending = tuiPendingAgentSpawns.get(sessionId);
    if (pending) { pending.count = Math.max(0, pending.count - 1); if (pending.count === 0) tuiPendingAgentSpawns.delete(sessionId); }
  }

  // Remap child sessions to parent (like window UI's childSessionMap)
  const originalSessionId = sessionId;
  if (tuiChildSessionMap.has(sessionId)) {
    sessionId = tuiChildSessionMap.get(sessionId);
  } else if (!sessionQueries.has(sessionId) && sessionId !== "_default") {
    // Remap child sessions: first try pending agent spawns, then name heuristic
    let remapped = false;
    for (const [parentSid, info] of tuiPendingAgentSpawns) {
      if (parentSid !== sessionId && info.count > 0 && msg.ts - info.ts < 60000) {
        tuiChildSessionMap.set(sessionId, parentSid);
        sessionId = parentSid;
        remapped = true;
        break;
      }
    }
    if (!remapped) {
      const sid = (sessionId || "").toLowerCase();
      const sInfo = sessions.get(sessionId);
      const slbl = sInfo ? (sInfo.label || "").toLowerCase() : "";
      const looksLikeAgent = sid.startsWith("agent-") || sid.startsWith("agent_") ||
                             slbl.startsWith("agent-") || slbl.startsWith("agent_");
      if (looksLikeAgent) {
        let bestParent = null, bestTs = 0;
        for (const [parentSid, pInfo] of sessions) {
          if (parentSid !== sessionId && (pInfo.lastEventTs || 0) > bestTs) { bestTs = pInfo.lastEventTs || 0; bestParent = parentSid; }
        }
        if (bestParent) { tuiChildSessionMap.set(sessionId, bestParent); sessionId = bestParent; }
      }
    }
  }
  const isChildSession = originalSessionId !== sessionId;

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
    // Auto-collapse previous query/preamble in this session
    if (sq.length > 0) sq[sq.length - 1].collapsed = true;
    const q = { id: ++queryIdCounter, userQuery, sessionId, startTs: msg.ts, endTs: msg.ts, events: [], collapsed: !autoFollow, tokens: 0, tokIn: 0, tokOut: 0, tokCacheRead: 0 };
    sq.push(q);
    if (sq.length > MAX_QUERIES_PER_SESSION) sq.shift();
    hasNewQueries = true;
    // Clear agent stacks and associated session map entries on query boundary
    const oldStack = sessionAgentStacks.get(sessionId) || [];
    for (const [sid, ag] of tuiAgentSessionMap) {
      if (oldStack.includes(ag)) tuiAgentSessionMap.delete(sid);
    }
    sessionAgentStacks.set(sessionId, []);
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
      sq.push({ id: ++queryIdCounter, userQuery: null, sessionId, startTs: msg.ts, endTs: msg.ts, events: [], collapsed: true, _preamble: true, tokens: 0, tokIn: 0, tokOut: 0, tokCacheRead: 0 });
    }
    const target = sq[sq.length - 1];

    if (cat === "sub_agent") {
      // Create agent container node
      const ag = { agentEvent: eventObj, children: [], resultEvent: null, collapsed: false };
      const stack = sessionAgentStacks.get(sessionId) || [];
      stack.push(ag);
      sessionAgentStacks.set(sessionId, stack);
      // Don't map session_id here — SubagentStart fires in the parent session context.
      // Child session mapping happens lazily when child events arrive (see routing below).
      target.events.push(ag);
    } else if (cat === "sub_agent_result") {
      // Match first unresolved agent in this query's events
      let matched = false;
      for (const evt of target.events) {
        if (evt.agentEvent && !evt.resultEvent) {
          evt.resultEvent = eventObj;
          // Remove from stack
          const stack = sessionAgentStacks.get(sessionId) || [];
          const idx = stack.indexOf(evt);
          if (idx !== -1) stack.splice(idx, 1);
          // Remove from session map
          for (const [sid, ag] of tuiAgentSessionMap) {
            if (ag === evt) { tuiAgentSessionMap.delete(sid); break; }
          }
          matched = true;
          break;
        }
      }
      if (!matched) target.events.push(eventObj);
    } else {
      // Route to matching agent: by child session_id, lazy map, stack fallback, then query-level
      const matchedAgent = isChildSession ? tuiAgentSessionMap.get(originalSessionId) : null;
      if (matchedAgent && !matchedAgent.resultEvent) {
        matchedAgent.children.push(eventObj);
      } else if (isChildSession && !matchedAgent) {
        // Lazy mapping: first event from child session → first unmapped agent on parent stack
        const stack = sessionAgentStacks.get(sessionId) || [];
        if (stack.length > 0) {
          const mappedAgents = new Set(tuiAgentSessionMap.values());
          let targetAg = null;
          for (const ag of stack) {
            if (!mappedAgents.has(ag) && !ag.resultEvent) { targetAg = ag; break; }
          }
          if (!targetAg) targetAg = stack[stack.length - 1];
          tuiAgentSessionMap.set(originalSessionId, targetAg);
          targetAg.children.push(eventObj);
        } else {
          target.events.push(eventObj);
        }
      } else {
        // Parent session event — use stack if agents are active
        const stack = sessionAgentStacks.get(sessionId) || [];
        if (stack.length > 0) {
          stack[stack.length - 1].children.push(eventObj);
        } else {
          target.events.push(eventObj);
        }
      }
    }
    target.endTs = msg.ts;
  }

  // Accumulate tokens on the current query regardless of branch
  const currentQ = sq.length > 0 ? sq[sq.length - 1] : null;
  const qUsage = json?.data?.meta || json?.data?.message?.usage;
  if (currentQ && qUsage) {
    const qIn = qUsage.input_tokens || 0;
    const qOut = qUsage.output_tokens || 0;
    const qCR = qUsage.cache_read || qUsage.cache_read_input_tokens || 0;
    const qCC = qUsage.cache_create || qUsage.cache_creation_input_tokens || 0;
    currentQ.tokens = (currentQ.tokens || 0) + qIn + qOut;
    currentQ.tokIn = (currentQ.tokIn || 0) + qIn;
    currentQ.tokOut = (currentQ.tokOut || 0) + qOut;
    currentQ.tokCacheRead = (currentQ.tokCacheRead || 0) + qCR;
    currentQ.tokCacheCreate = (currentQ.tokCacheCreate || 0) + qCC;
  }

  render();
}

// ===== Rendering =====
function renderStatusLine(cols) {
  // Helper: cyan bold key + dim rest
  const k = (key, label) => `${FG.cyan}${BOLD}${key}${RESET}${DIM}${label}${RESET}`;
  const parts = [];
  const sep = `${DIM} · ${RESET}`;

  // Search
  if (searchQuery) {
    parts.push(`${FG.cyan}/${RESET}${DIM}${searchQuery.slice(0, 12)}${RESET}`);
  } else {
    parts.push(k("/", "search"));
  }

  // Collapse/expand
  parts.push(k("c", allCollapsed ? "expand" : "ollapse"));

  // Clear/delete (context-dependent)
  if (sessionFilter === "all") {
    parts.push(clearPending ? `${FG.red}${BOLD}x${RESET}${FG.red}clear!${RESET}` : k("x", "clear"));
  } else {
    parts.push(deletePending ? `${FG.red}${BOLD}d${RESET}${FG.red}elete!${RESET}` : k("d", "elete"));
  }

  // Agents (conditional)
  if (agentTreeVisible && agentTree.length > 0) {
    parts.push(k("tab", " agents"));
  }

  // Topics
  if (topicStatus) {
    parts.push(`${FG.yellow}${topicStatus}${RESET}`);
  } else {
    parts.push(topicAllPending ? `${FG.red}${BOLD}t${RESET}${FG.red}opics!${RESET}` : k("t", "opics"));
  }

  // Island
  parts.push(k("i", "sland"));

  // Load more (session-filtered only)
  if (sessionFilter !== "all") {
    parts.push(loadingHistory ? `${FG.yellow}${BOLD}L${RESET}${FG.yellow}oading…${RESET}` : k("L", "oad more"));
  }

  // Resume
  parts.push(k("R", "esume"));

  // Window
  parts.push(k("w", "indow"));

  // Stop
  parts.push(stopPending ? `${FG.red}${BOLD}S${RESET}${FG.red}top!${RESET}` : k("S", "top"));

  const joined = parts.join(sep);
  const visLen = joined.replace(/\x1b\[[0-9;]*m/g, "").length;
  windowBtnCol = visLen - 5;
  return padLine(` ${joined}`, cols);
}

function renderAgentTree(rows) {
  const lines = [];
  const hint = agentDeletePending ? ` ${FG.red}d again${RESET}` : (agentFocus ? ` ${DIM}d:dismiss${RESET}` : "");
  lines.push(`${BOLD}${FG.cyan} AGENTS${RESET}${hint}`);
  lines.push(`${DIM}${"─".repeat(TREE_WIDTH - 1)}${RESET}`);
  const running = agentTree.filter(a => a.status === "running").length;
  lines.push(` ${FG.cyan}${agentTree.length - running}/${agentTree.length} done${RESET}`);
  lines.push("");
  for (let ai = 0; ai < agentTree.length; ai++) {
    const agent = agentTree[ai];
    const isFocused = agentFocus && ai === agentFocusIdx;
    const icon = agent.status === "done" ? `${FG.green}✓${RESET}` : `${FG.yellow}●${RESET}`;
    const secs = Math.floor(((agent.endTs || Date.now()) - agent.startTs) / 1000);
    const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;
    const cursor = isFocused ? `${FG.cyan}▸${RESET}` : " ";
    const fc = isFocused ? `${BOLD}${FG.white}` : "";
    const fcEnd = isFocused ? RESET : "";
    lines.push(`${cursor}${icon} ${fc}${agent.type}${fcEnd}`);
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
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Full-screen loading page during backlog or disconnected state
  if (isBacklog || !connected) {
    const mid = Math.floor(rows / 2);
    const midCol = Math.floor(cols / 2);
    let output = `${ESC}[2J${ESC}[H`; // clear screen + cursor home
    if (!connected) {
      const dots = ".".repeat(Math.floor(Date.now() / 500) % 4);
      const msg = `● Connecting${dots}`;
      const sub = `Waiting for loupe server on port ${PORT}`;
      output += `${ESC}[${mid};${midCol - Math.floor(msg.length / 2)}H${FG.red}${msg}${RESET}`;
      output += `${ESC}[${mid + 1};${midCol - Math.floor(sub.length / 2)}H${DIM}${sub}${RESET}`;
    } else {
      const frame = Math.floor(Date.now() / 150) % 4;
      const spinner = ["◐", "◓", "◑", "◒"][frame];
      const evtStr = eventCount > 0 ? `  ${eventCount} events` : "";
      const msg = `${spinner} Loading sessions...${evtStr}`;
      output += `${ESC}[${mid};${midCol - Math.floor(msg.length / 2)}H${FG.cyan}${msg}${RESET}`;
    }
    process.stdout.write(output);
    return;
  }

  // Rebuild flat queries list from per-session data
  queries = [];
  for (const [, sq] of sessionQueries) {
    for (const q of sq) queries.push(q);
  }

  // Auto-follow: focus on latest query (respects session filter)
  if (autoFollow && queries.length > 0) {
    let latestIdx = 0, latestTs = 0;
    for (let i = 0; i < queries.length; i++) {
      if (sessionFilter !== "all" && queries[i].sessionId !== sessionFilter) continue;
      if (queries[i].endTs >= latestTs) { latestTs = queries[i].endTs; latestIdx = i; }
    }
    focusIdx = latestIdx;
  }

  // Event-level auto-follow: snap to newest event in focused query
  if (eventAutoFollow && navLevel === "event" && focusIdx >= 0 && focusIdx < queries.length) {
    const total = queryEventCount(queries[focusIdx]);
    if (total > 0) eventFocusIdx = total - 1;
  }

  // Header
  const connStr = connected ? `${FG.green}●${RESET}` : `${FG.red}●${RESET}`;
  const phaseColor = { active: FG.green, exploring: FG.magenta, implementing: FG.blue, debugging: FG.red, testing: FG.green, thinking: FG.yellow, planning: FG.yellow, orchestrating: FG.cyan, idle: FG.gray }[phase] || FG.gray;
  const planStrikeStr = planningStrike ? ` ${DIM}${STRIKE}planning${RESET}` : "";
  const headerLabel = sessionFilter !== "all" && sessions.has(sessionFilter)
    ? (sessions.get(sessionFilter).label || sessionFilter.slice(0, 12)).toUpperCase()
    : "LOUPE";
  let header = `${BOLD} ${headerLabel} ${RESET} ${connStr} ${phaseColor}${BOLD}${phase}${RESET}${planStrikeStr}`;
  if (statusLine.sessionStartTs && statusLine.sessionState === "active") {
    const secs = Math.floor((Date.now() - statusLine.sessionStartTs) / 1000);
    header += ` ${DIM}${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s${RESET}`;
  }
  if (currentTool) header += `  ${DIM}▸ ${currentTool.name}${RESET}`;

  let stats = ` ${DIM}events:${RESET}${eventCount}  ${DIM}files:${RESET}${fileSet.size}`;
  if (errorCount > 0) stats += `  ${FG.red}errors:${errorCount}${RESET}`;
  if (sessions.size > 1) stats += `  ${DIM}sessions:${RESET}${sessions.size}`;

  const sep = DIM + "─".repeat(cols) + RESET;
  const showTabs = sessions.size > 1;
  const logRows = Math.max(1, rows - (showTabs ? 6 : 5));

  let output = `${ESC}[H`;
  output += padLine(header, cols) + "\n";
  if (searchMode) {
    const searchLine = ` ${FG.cyan}/${RESET} ${searchQuery}${FG.cyan}▎${RESET}`;
    output += padLine(searchLine, cols) + "\n";
  } else {
    output += padLine(stats, cols) + "\n";
  }

  // Session tabs
  if (showTabs) {
    // Sort and filter tabs: only sessions with content
    const sortedSessionIds = [...sessions.keys()].sort((a, b) => {
      const aTs = sessions.get(a)?.lastEventTs || 0;
      const bTs = sessions.get(b)?.lastEventTs || 0;
      return aTs - bTs;
    });
    const tabSessionIds = sortedSessionIds.filter(sid => {
      const sInfo = sessions.get(sid);
      return sInfo && sInfo.eventCount >= 1 && !tuiChildSessionMap.has(sid);
    });
    let tabLine = " ";
    tabLine += sessionFilter === "all" ? `${BOLD}${FG.cyan}[1:All]${RESET}` : `${DIM}[1:All]${RESET}`;
    const total = tabSessionIds.length;
    // Tabs: most recent first (left = 2), numbered 2, 3, 4...
    for (let si = total - 1; si >= 0; si--) {
      const sid = tabSessionIds[si];
      const sInfo = sessions.get(sid);
      if (!sInfo) continue;
      const num = total - si + 1;
      if (num > 9) continue;
      const selected = sessionFilter === sid;
      const dot = sInfo.active ? `${FG.green}●${RESET} ` : "";
      const label = `${num}:${sInfo.label}`;
      tabLine += selected ? ` ${BOLD}${FG.cyan}[${dot}${label}]${RESET}` : ` ${DIM}[${dot}${label}]${RESET}`;
    }
    output += padLine(tabLine, cols) + "\n";
  }

  output += sep + "\n";

  // Detail view mode — show full content for selected event
  if (navLevel === "detail" && focusIdx >= 0 && focusIdx < queries.length) {
    const q = queries[focusIdx];
    const ev = (eventFocusIdx >= 0) ? queryEventAt(q, eventFocusIdx) : null;
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

  function addQueryRow(q, indent) {
    const pfx = indent ? "  " : "";
    const realIdx = queries.indexOf(q);
    navOrder.push(realIdx);
    const isFocused = realIdx === focusIdx;
    const chevron = q.collapsed ? "▶" : "▼";
    const fc = isFocused && navLevel === "query" ? `${BOLD}${FG.cyan}` : (isFocused ? `${BOLD}${FG.white}` : DIM);
    const queryText = q.userQuery ? q.userQuery.replace(/\n/g, " ").slice(0, 40 - pfx.length) : "(preamble)";
    const count = queryEventCount(q);
    const time = new Date(q.startTs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
    const cursor = isFocused && navLevel === "query" ? `${FG.cyan}▸${RESET}` : " ";
    const headerLine = `${pfx}${cursor} ${fc}${chevron}${RESET} ${fc}${queryText}${RESET}  ${DIM}${count}${RESET}  ${DIM}${time}${RESET}`;
    rowData.push({ text: headerLine, isHeader: true, queryIdx: realIdx, eventIdx: -1 });

    if (!q.collapsed) {
      let evIdx = 0;
      for (const ev of q.events) {
        if (ev.agentEvent) {
          // Agent container: collapsible header + indented children + result
          const isEventFocused = navLevel === "event" && realIdx === focusIdx && evIdx === eventFocusIdx;
          const prefix = isEventFocused ? `${pfx}  ${FG.cyan}▸${RESET} ` : `${pfx}    `;
          const chevron = ev.collapsed ? "▶" : "▼";
          const status = ev.resultEvent ? `${FG.green}✓${RESET}` : `${FG.cyan}…${RESET}`;
          const childCount = ev.children.length + (ev.resultEvent ? 1 : 0);
          const countStr = ev.collapsed && childCount > 0 ? ` ${DIM}(${childCount})${RESET}` : "";
          rowData.push({ text: `${prefix}${FG.cyan}${chevron}${RESET} ${ev.agentEvent.line} ${status}${countStr}`, isHeader: false, queryIdx: realIdx, eventIdx: evIdx, isAgentHeader: true });
          evIdx++;
          if (!ev.collapsed) {
            for (const child of ev.children) {
              const isCFocused = navLevel === "event" && realIdx === focusIdx && evIdx === eventFocusIdx;
              const cPrefix = isCFocused ? `${pfx}    ${FG.cyan}▸${RESET} ` : `${pfx}      `;
              rowData.push({ text: `${cPrefix}${child.line}`, isHeader: false, queryIdx: realIdx, eventIdx: evIdx });
              evIdx++;
            }
            if (ev.resultEvent) {
              const isRFocused = navLevel === "event" && realIdx === focusIdx && evIdx === eventFocusIdx;
              const rPrefix = isRFocused ? `${pfx}    ${FG.cyan}▸${RESET} ` : `${pfx}      `;
              rowData.push({ text: `${rPrefix}${ev.resultEvent.line}`, isHeader: false, queryIdx: realIdx, eventIdx: evIdx });
              evIdx++;
            }
          }
        } else {
          const isEventFocused = navLevel === "event" && realIdx === focusIdx && evIdx === eventFocusIdx;
          const prefix = isEventFocused ? `${pfx}  ${FG.cyan}▸${RESET} ` : `${pfx}    `;
          rowData.push({ text: `${prefix}${ev.line}`, isHeader: false, queryIdx: realIdx, eventIdx: evIdx });
          evIdx++;
        }
      }
    }
  }

  function queryMatchesSearch(q) {
    if (!searchQuery) return true;
    const sq = searchQuery.toLowerCase();
    if (q.userQuery && q.userQuery.toLowerCase().includes(sq)) return true;
    for (const ev of q.events) {
      if (ev.cat === "thinking") continue;
      if (ev.line && stripAnsi(ev.line).toLowerCase().includes(sq)) return true;
      if (ev.agentEvent && ev.agentEvent.line && stripAnsi(ev.agentEvent.line).toLowerCase().includes(sq)) return true;
      if (ev.children) {
        for (const c of ev.children) {
          if (c.cat === "thinking") continue;
          if (c.line && stripAnsi(c.line).toLowerCase().includes(sq)) return true;
        }
      }
    }
    return false;
  }

  function addSessionQueries(sqList) {
    const visible = sqList.filter(q => !q._preamble && (q._separator || queryMatchesSearch(q)));
    // Group queries between topic separators
    let currentTopic = null;
    let topicQueries = [];

    function flushTopic() {
      if (!currentTopic) {
        // No topic — render queries flat
        for (const q of topicQueries) addQueryRow(q, false);
      } else {
        // Render topic header, then indented queries
        const realIdx = queries.indexOf(currentTopic);
        navOrder.push(realIdx);
        const isFocused = realIdx === focusIdx;
        const chevron = currentTopic.collapsed ? "▶" : "▼";
        const qCount = topicQueries.length;
        const fc = isFocused && navLevel === "query" ? `${BOLD}${FG.cyan}` : (isFocused ? `${BOLD}${FG.magenta}` : "");
        const fcEnd = fc ? RESET : "";
        const cursor = isFocused && navLevel === "query" ? `${FG.cyan}▸${RESET}` : " ";
        const ts = new Date(currentTopic.startTs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
        const headerLine = `${cursor} ${fc}${chevron} ${FG.magenta}TOP:${RESET} ${fc}${ESC}[4m${currentTopic._separatorLabel}${ESC}[24m${fcEnd}  ${DIM}${qCount} queries  ${ts}${RESET}`;
        rowData.push({ text: headerLine, isHeader: true, queryIdx: realIdx, eventIdx: -1 });

        if (!currentTopic.collapsed) {
          for (const q of topicQueries) addQueryRow(q, true);
        }
      }
      topicQueries = [];
    }

    // Find the last_query_ts across all topic separators — queries after this are truly new (post-classification)
    const classifiedUpTo = visible.filter(q => q._separator && q._separatorCat === "topic_shift" && q._lastQueryTs).reduce((max, q) => Math.max(max, q._lastQueryTs), 0);

    for (const q of visible) {
      if (q._separator && q._separatorCat === "topic_shift") {
        flushTopic();
        currentTopic = q;
      } else if (q._separator) {
        // Session separators rendered inline
        flushTopic();
        currentTopic = null;
        const color = q._separatorCat === "session_start" ? FG.green : FG.gray;
        const ts = new Date(q.startTs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
        rowData.push({ text: `  ${color}${BOLD}SESSION${RESET} ${color}${q._separatorLabel}${RESET}  ${DIM}${ts}${RESET}`, isHeader: false, queryIdx: -1, eventIdx: -1 });
      } else if (currentTopic && classifiedUpTo && q.startTs > classifiedUpTo) {
        // Query arrived after classification — render flat, not inside last topic
        flushTopic();
        currentTopic = null;
        addQueryRow(q, false);
      } else {
        topicQueries.push(q);
      }
    }
    flushTopic();
  }

  if (sessionFilter === "all" && sessions.size > 0) {
    // Sort: most idle first (top), most recent last (bottom)
    const sessionIds = [...sessions.keys()].sort((a, b) => {
      const aTs = sessions.get(a)?.lastEventTs || 0;
      const bTs = sessions.get(b)?.lastEventTs || 0;
      return aTs - bTs;
    });
    const contentIds = sessionIds.filter(sid => {
      const sInfo = sessions.get(sid);
      return sInfo && sInfo.eventCount >= 1 && !tuiChildSessionMap.has(sid);
    });
    for (let si = 0; si < contentIds.length; si++) {
      const sid = contentIds[si];
      const sInfo = sessions.get(sid);
      const sq = sessionQueries.get(sid) || [];

      const sLabel = sInfo.label || sid.slice(0, 8);
      const sCount = sInfo.eventCount || 0;
      const sNum = contentIds.length - si + 1; // most recent (last) = 2
      rowData.push({ text: `${sNum}:${sLabel}`, meta: `${sCount} events`, isHeader: false, queryIdx: -1, eventIdx: -1, isSessionHeader: true });

      addSessionQueries(sq);
    }
  } else if (sessionFilter !== "all") {
    const sInfo = sessions.get(sessionFilter);
    if (sInfo) {
      const sLabel = sInfo.label || sessionFilter.slice(0, 8);
      const sCount = sInfo.eventCount || 0;
      rowData.push({ text: `${sLabel}`, meta: `${sCount} events`, isHeader: false, queryIdx: -1, eventIdx: -1, isSessionHeader: true });
    }
    addSessionQueries(sessionQueries.get(sessionFilter) || []);
  } else {
    addSessionQueries(queries);
  }

  // Empty state (connected, not loading, but no data)
  if (rowData.length === 0) {
    const mid = Math.floor(logRows / 2);
    for (let i = 0; i < logRows; i++) {
      if (i === mid) output += padLine(`  ${DIM}Waiting for events...${RESET}`, cols) + "\n";
      else output += padLine("", cols) + "\n";
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
    let truncated;
    if (row && row.isSessionHeader) {
      // ── 2:loupe (85 events) ──────────────────
      const label = stripAnsi(rowText);
      const meta = row.meta || "";
      const prefix = `── `;
      const suffix = ` (${meta}) `;
      const contentLen = prefix.length + label.length + suffix.length;
      const fillLen = Math.max(4, logWidth - contentLen);
      truncated = `${DIM}${prefix}${RESET}${ESC}[4m${FG.yellow}${BOLD}${rowText}${RESET}${DIM}${suffix}${"─".repeat(fillLen)}${RESET}`;
    } else {
      truncated = padLine(rowText, logWidth);
    }

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
  // History loading status
  if (historyStatus) {
    const hLen = historyStatus.length;
    output += `${ESC}[${rows - 2};${cols - hLen - 1}H${DIM}${historyStatus}${RESET}`;
  }
  // Session picker overlay
  if (sessionPickerVisible) {
    output += renderSessionPicker(cols, rows);
  }

  process.stdout.write(output);
}

// ===== Input handling =====
function handleInput(buf) {
  const s = buf.toString();

  // Session picker — intercept all input when visible
  if (sessionPickerVisible) {
    if (s === "\x1b" || s === "q") { sessionPickerVisible = false; render(); return; }
    if (s === "j" || s === "\x1b[B") { if (sessionPickerIdx < sessionPickerList.length - 1) sessionPickerIdx++; render(); return; }
    if (s === "k" || s === "\x1b[A") { if (sessionPickerIdx > 0) sessionPickerIdx--; render(); return; }
    if (s === "\r" || s === "\n") {
      const selected = sessionPickerList[sessionPickerIdx];
      if (selected && ws && ws.readyState === 1) {
        sessionPickerVisible = false;
        // Load session as a new tab — don't clear existing state
        isBacklog = true;
        loadingHistory = true;
        historyStatus = "Loading session...";
        // Remember which session we're loading so we can switch to it on done
        sessionPickerLoadingId = selected.id;
        ws.send(JSON.stringify({ type: "load_session", sessionId: selected.id }));
      }
      render(); return;
    }
    return; // swallow all other input
  }

  // Search mode — intercept all input
  if (searchMode) {
    if (s === "\x1b" || s === "\r" || s === "\n") {
      searchMode = false;
      render(); return;
    }
    if (s === "\x7f" || s === "\b") { // backspace
      if (searchQuery.length > 0) searchQuery = searchQuery.slice(0, -1);
      else { searchMode = false; }
      render(); return;
    }
    if (s === "\x15") { searchQuery = ""; render(); return; } // ctrl-u clear
    if (s.length === 1 && s.charCodeAt(0) >= 32) {
      searchQuery += s;
      render(); return;
    }
    return; // swallow other control sequences
  }

  // X10 mouse: ESC [ M <button> <col> <row>
  if (buf.length >= 6 && buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x4d) {
    const button = buf[3];
    const col = buf[4] - 32;
    const row = buf[5] - 32;
    handleMouse(button, col, row);
    return;
  }

  // Esc — exit agent panel first, clear search, then go back one nav level
  if (s === "\x1b" && buf.length === 1) {
    if (agentFocus) { agentFocus = false; agentFocusIdx = -1; agentDeletePending = false; render(); return; }
    if (searchQuery) { searchQuery = ""; render(); return; }
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
  if (s === "1") { sessionFilter = "all"; navLevel = "query"; focusIdx = 0; eventFocusIdx = -1; autoFollow = true; eventAutoFollow = true; render(); return; }
  if (s >= "2" && s <= "9") {
    const num = parseInt(s);
    const sorted = [...sessions.keys()].sort((a, b) => (sessions.get(a)?.lastEventTs || 0) - (sessions.get(b)?.lastEventTs || 0));
    const filtered = sorted.filter(sid => {
      const sInfo = sessions.get(sid);
      return sInfo && sInfo.eventCount >= 1 && !tuiChildSessionMap.has(sid);
    });
    const idx = filtered.length - (num - 1);
    if (idx >= 0 && idx < filtered.length) sessionFilter = filtered[idx];
    navLevel = "query"; focusIdx = 0; eventFocusIdx = -1; autoFollow = true; eventAutoFollow = true;
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
  if (s === "/") { searchMode = true; searchQuery = ""; render(); return; }
  if (s === "L" && !loadingHistory && sessionFilter !== "all") {
    // Load more history — only for a specific session
    loadingHistory = true;
    historyTargetSid = sessionFilter; // capture before user switches tabs
    historyStatus = "Loading...";
    const sidTs = earliestTsBySid.get(sessionFilter) || Infinity;
    const before = sidTs < Infinity ? sidTs : Date.now();
    const payload = { type: "fetch_history", before, count: 200, sessionId: sessionFilter };
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
    render(); return;
  }
  if (s === "R") {
    // Show picker immediately, request session list
    sessionPickerVisible = true;
    sessionPickerList = [];
    sessionPickerIdx = 0;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "list_sessions" }));
    render(); return;
  }
  if (s === "i") { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "toggle_island" })); return; }
  if (s === "t") {
    if (sessionFilter !== "all") {
      // Single session — classify immediately
      const sq = sessionQueries.get(sessionFilter) || [];
      const queryData = sq.filter(q => q.userQuery && !q._preamble && !q._separator).map(q => ({ userQuery: q.userQuery, ts: q.startTs }));
      topicStatus = `classifying ${queryData.length} queries...`;
      if (queryData.length < 3) {
        topicStatus = `only ${queryData.length} queries — need 3+`;
        setTimeout(() => { topicStatus = null; render(); }, 3000);
      } else if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "classify_topics", sessionId: sessionFilter, queries: queryData }));
      } else {
        topicStatus = "not connected";
        setTimeout(() => { topicStatus = null; render(); }, 3000);
      }
    } else if (topicAllPending) {
      // Second press on "All" — classify all sessions
      topicAllPending = false;
      if (topicAllTimer) { clearTimeout(topicAllTimer); topicAllTimer = null; }
      for (const sid of sessions.keys()) {
        const sq = sessionQueries.get(sid) || [];
        const queryData = sq.filter(q => q.userQuery && !q._preamble && !q._separator).map(q => ({ userQuery: q.userQuery, ts: q.startTs }));
        if (queryData.length >= 3 && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "classify_topics", sessionId: sid, queries: queryData }));
        }
      }
    } else {
      // First press on "All" — arm confirmation
      topicAllPending = true;
      topicAllTimer = setTimeout(() => { topicAllPending = false; render(); }, 2000);
    }
    render(); return;
  }
  if (s === "x" && sessionFilter === "all") {
    if (clearPending) {
      // Second press — clear all
      clearPending = false;
      if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
      eventCount = 0; errorCount = 0; tokenTotal = 0; tokenIn = 0; tokenOut = 0; tokenCacheRead = 0; tokenCacheCreate = 0;
      fileSet.clear(); erroredFiles.clear(); activeFile = null;
      sessionQueries.clear(); queries = []; queryIdCounter = 0; sessionAgentStacks.clear(); tuiAgentSessionMap.clear(); tuiChildSessionMap.clear(); tuiPendingAgentSpawns.clear(); eventAutoFollow = true;
      focusIdx = -1; autoFollow = true; hasNewQueries = false; scrollOffset = 0; earliestTsBySid.clear();
      sessions.clear(); sessionFilter = "all";
      phase = "idle"; currentTool = null; thinkingActive = false;
      Object.assign(statusLine, { sessionState: "idle", waitingTool: null, errors: 0, apiError: null, agentsRunning: 0, agentsTotal: 0, tasksCreated: 0, tasksCompleted: 0, sessionStartTs: null });
      agentTree.length = 0; agentTreeVisible = false; agentFocus = false; agentFocusIdx = -1;
    } else {
      // First press — arm confirmation
      clearPending = true;
      clearTimer = setTimeout(() => { clearPending = false; render(); }, 2000);
    }
    render(); return;
  }
  if (s === "d" && sessionFilter !== "all" && !agentFocus) {
    if (deletePending && deleteTargetSession === sessionFilter) {
      // Second press — delete this session (only if still on the same session)
      deletePending = false; deleteTargetSession = null;
      if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = null; }
      const sid = sessionFilter;
      deletedSessionIds.add(sid);
      sessionQueries.delete(sid);
      sessions.delete(sid);
      sessionFilter = "all";
      focusIdx = -1; autoFollow = true; scrollOffset = 0;
    } else {
      deletePending = true;
      deleteTargetSession = sessionFilter;
      deleteTimer = setTimeout(() => { deletePending = false; deleteTargetSession = null; render(); }, 2000);
    }
    render(); return;
  }
  if (s === "S") {
    if (stopPending) {
      stopPending = false;
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      stopServer();
    } else {
      stopPending = true;
      stopTimer = setTimeout(() => { stopPending = false; render(); }, 2000);
    }
    render(); return;
  }

  // Tab — toggle focus between query list and agent panel
  if (s === "\t" && agentTreeVisible && agentTree.length > 0) {
    agentFocus = !agentFocus;
    if (agentFocus) { agentFocusIdx = Math.max(0, agentFocusIdx); }
    else { agentFocusIdx = -1; agentDeletePending = false; }
    render(); return;
  }
  // Agent panel navigation
  if (agentFocus) {
    const isAgentDown = s === "j" || s === "\x1b[B";
    const isAgentUp = s === "k" || s === "\x1b[A";
    if (isAgentDown) { agentFocusIdx = Math.min(agentTree.length - 1, agentFocusIdx + 1); render(); return; }
    if (isAgentUp) { agentFocusIdx = Math.max(0, agentFocusIdx - 1); render(); return; }
    if (s === "d" && agentFocusIdx >= 0 && agentFocusIdx < agentTree.length) {
      if (agentDeletePending) {
        agentDeletePending = false;
        if (agentDeleteTimer) { clearTimeout(agentDeleteTimer); agentDeleteTimer = null; }
        const removed = agentTree.splice(agentFocusIdx, 1)[0];
        if (removed.status === "running") statusLine.agentsRunning = Math.max(0, statusLine.agentsRunning - 1);
        statusLine.agentsTotal = Math.max(0, statusLine.agentsTotal - 1);
        if (agentTree.length === 0) { agentFocus = false; agentFocusIdx = -1; agentTreeVisible = false; }
        else { agentFocusIdx = Math.min(agentFocusIdx, agentTree.length - 1); }
      } else {
        agentDeletePending = true;
        agentDeleteTimer = setTimeout(() => { agentDeletePending = false; render(); }, 2000);
      }
      render(); return;
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

    const totalEvents = queryEventCount(q);
    if (isDown) {
      if (eventFocusIdx < totalEvents - 1) eventFocusIdx++;
      eventAutoFollow = (eventFocusIdx === totalEvents - 1);
      render(); return;
    }
    if (isUp) {
      if (eventFocusIdx > 0) eventFocusIdx--;
      eventAutoFollow = false;
      render(); return;
    }
    if (isLeft) {
      const ag = queryAgentAt(q, eventFocusIdx);
      if (ag && !ag.collapsed) {
        ag.collapsed = true;
      } else {
        navLevel = "query"; eventFocusIdx = -1; eventAutoFollow = true;
      }
      render(); return;
    }
    if (isRight || isEnter) {
      if (eventFocusIdx >= 0 && eventFocusIdx < totalEvents) {
        const ag = queryAgentAt(q, eventFocusIdx);
        if (ag) {
          if (ag.collapsed) {
            // First right: expand agent children
            ag.collapsed = false;
          } else {
            // Already expanded: enter detail view for agent
            navLevel = "detail"; detailScroll = 0;
          }
        } else {
          navLevel = "detail"; detailScroll = 0;
        }
      }
      render(); return;
    }
    if (s === "g") { eventFocusIdx = 0; eventAutoFollow = false; render(); return; }
    if (s === "G") { eventFocusIdx = totalEvents - 1; eventAutoFollow = true; render(); return; }
    return;
  }

  // === Query level ===
  // Navigate using visual order (navOrder), not raw query index
  if (isDown) {
    let curPos = navOrder.indexOf(focusIdx);
    if (curPos < 0 && navOrder.length > 0) {
      // focusIdx not in navOrder (e.g., hidden by collapsed topic) — find nearest
      curPos = navOrder.findIndex(i => i > focusIdx) - 1;
      if (curPos < 0) curPos = 0;
    }
    if (curPos < navOrder.length - 1) {
      focusIdx = navOrder[curPos + 1];
      autoFollow = false;
    }
    render(); return;
  }

  if (isUp) {
    let curPos = navOrder.indexOf(focusIdx);
    if (curPos < 0 && navOrder.length > 0) {
      curPos = navOrder.findIndex(i => i >= focusIdx);
      if (curPos < 0) curPos = navOrder.length - 1;
    }
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

  // → = for topics: expand; for queries: enter event level
  if (isRight) {
    if (focusIdx >= 0 && focusIdx < queries.length) {
      const q = queries[focusIdx];
      if (q._separator) {
        if (q.collapsed) {
          // First right: expand topic
          q.collapsed = false;
        } else {
          // Already expanded: move focus to first child query
          const curPos = navOrder.indexOf(focusIdx);
          if (curPos >= 0 && curPos < navOrder.length - 1) {
            focusIdx = navOrder[curPos + 1];
          }
        }
      } else {
        if (q.collapsed) {
          // First right: expand query
          q.collapsed = false;
        } else {
          // Already expanded: enter event level
          navLevel = "event";
          eventFocusIdx = 0;
          eventAutoFollow = false;
        }
      }
    }
    render(); return;
  }

  // ← = collapse if expanded; if already collapsed, jump to parent topic
  if (isLeft) {
    if (focusIdx >= 0 && focusIdx < queries.length) {
      const q = queries[focusIdx];
      if (!q.collapsed) {
        // First left: collapse in place
        q.collapsed = true;
      } else if (!q._separator) {
        // Already collapsed query — jump to parent topic
        const curPos = navOrder.indexOf(focusIdx);
        if (curPos > 0) {
          for (let i = curPos - 1; i >= 0; i--) {
            const candidate = queries[navOrder[i]];
            if (candidate && candidate._separator && candidate._separatorCat === "topic_shift") {
              focusIdx = navOrder[i];
              break;
            }
          }
        }
      }
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
    let curPos = navOrder.indexOf(focusIdx);
    if (curPos < 0 && navOrder.length > 0) curPos = 0;
    if (scrollUp) {
      if (curPos > 0) { focusIdx = navOrder[curPos - 1]; autoFollow = false; }
    } else {
      if (curPos < navOrder.length - 1) { focusIdx = navOrder[curPos + 1]; autoFollow = false; }
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

    const contentStartRow = sessions.size > 1 ? 5 : 4; // header + stats [+ tabs] + sep + 1-indexed
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

// ===== Session Picker =====
function handleSessionsList(list) {
  sessionPickerList = list;
  sessionPickerIdx = 0;
  sessionPickerScroll = 0;
  sessionPickerVisible = true;
  render();
}

function formatTimeAgo(isoStr) {
  if (!isoStr) return "";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins > 1 ? "s" : ""} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

function formatSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function renderSessionPicker(cols, rows) {
  let out = `${ESC}[H`; // cursor home — full screen takeover

  // Clear entire screen
  for (let r = 1; r <= rows; r++) {
    out += `${ESC}[${r};1H${" ".repeat(cols)}`;
  }

  // Title bar
  const count = sessionPickerList.length;
  const countStr = count > 0 ? ` (${sessionPickerIdx + 1} of ${count})` : "";
  out += `${ESC}[1;1H`;
  out += padLine(`${BOLD}${FG.cyan} Resume Session${RESET}${DIM}${countStr}${RESET}`, cols);
  out += `${ESC}[2;1H${DIM}${"─".repeat(cols)}${RESET}`;

  if (count === 0) {
    out += `${ESC}[4;3H${DIM}Loading sessions...${RESET}`;
    // Footer
    out += `${ESC}[${rows};1H${DIM}Esc to cancel${RESET}`;
    return out;
  }

  // Each entry takes 3 rows: title, metadata, blank separator
  const entryH = 3;
  const listStart = 3;
  const listRows = rows - 4; // leave room for footer
  const visibleEntries = Math.floor(listRows / entryH);

  if (sessionPickerIdx < sessionPickerScroll) sessionPickerScroll = sessionPickerIdx;
  if (sessionPickerIdx >= sessionPickerScroll + visibleEntries) sessionPickerScroll = sessionPickerIdx - visibleEntries + 1;

  for (let i = 0; i < visibleEntries && (i + sessionPickerScroll) < count; i++) {
    const s = sessionPickerList[i + sessionPickerScroll];
    const isFocused = (i + sessionPickerScroll) === sessionPickerIdx;
    const row = listStart + i * entryH;
    const cursor = isFocused ? `${FG.cyan})${RESET}` : " ";

    // Line 1: cursor + first query or project name (title)
    const title = s.firstQuery || (s.cwd || "").split("/").pop() || s.id.slice(0, 8);
    const titleColor = isFocused ? `${BOLD}${FG.white}` : FG.white;
    const titleText = title.replace(/\n/g, " ").slice(0, cols - 4);
    out += `${ESC}[${row};1H${cursor} ${titleColor}${titleText}${RESET}`;

    // Line 2: time ago · branch · size · project
    const timeAgo = formatTimeAgo(s.mtime);
    const branch = s.gitBranch || "HEAD";
    const size = formatSize(s.size || 0);
    const project = (s.cwd || s.project || "").split("/").slice(-2).join("/");
    const metaParts = [timeAgo, branch, size];
    if (project) metaParts.push(project);
    const metaColor = isFocused ? DIM : `${ESC}[2m`;
    out += `${ESC}[${row + 1};3H${metaColor}${metaParts.join(" · ")}${RESET}`;
  }

  // Footer
  out += `${ESC}[${rows};1H${DIM}j/k navigate · Enter to load · Esc to cancel${RESET}`;

  return out;
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
const fs = require("fs");
const TUI_PID_FILE = path.join(process.env.HOME, ".claude/logs/loupe-tui.pid");
fs.writeFileSync(TUI_PID_FILE, String(process.pid));
process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR_SCREEN + ENABLE_MOUSE);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleInput);
}

function cleanup() {
  process.stdout.write(DISABLE_MOUSE + SHOW_CURSOR + ALT_SCREEN_OFF);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  try { fs.unlinkSync(TUI_PID_FILE); } catch {}
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.stdout.on("resize", () => render());

connect();
setInterval(() => { if (connected) render(); }, 1000);
