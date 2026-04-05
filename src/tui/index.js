#!/usr/bin/env node

// Loupe TUI — Terminal companion for Ghostty splits
// Connects to the Loupe WebSocket server and renders a live dashboard

const WebSocket = require("ws");

const PORT = process.env.LOUPE_PORT || 8390;
const WS_URL = `ws://localhost:${PORT}`;

// ANSI helpers
const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const ITALIC = `${ESC}[3m`;
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

const FG = {
  black: `${ESC}[30m`, red: `${ESC}[31m`, green: `${ESC}[32m`,
  yellow: `${ESC}[33m`, blue: `${ESC}[34m`, magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`, white: `${ESC}[37m`, gray: `${ESC}[90m`,
};
const BG = {
  black: `${ESC}[40m`, red: `${ESC}[41m`, green: `${ESC}[42m`,
  yellow: `${ESC}[43m`, blue: `${ESC}[44m`, magenta: `${ESC}[45m`,
  cyan: `${ESC}[46m`, white: `${ESC}[47m`,
};

// State
let connected = false;
let phase = "idle";
let currentTool = null;
let thinkingActive = false;
let sessionCount = 0;
let eventCount = 0;
let errorCount = 0;
let tokenTotal = 0;
const recentEvents = [];
const MAX_EVENTS = 100;
const fileSet = new Set();

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

// Rejection tracking
let lastToolEventIdx = -1;

// Category colors
const catColors = {
  tool_use: FG.blue,
  tool_result: FG.green,
  post_tool: FG.green,
  error: FG.red,
  thinking: FG.magenta,
  text: FG.white,
  sub_agent: FG.cyan,
  sub_agent_result: FG.cyan,
  user_query: FG.yellow,
  pre_tool: FG.blue,
  session_start: FG.green,
  session_end: FG.gray,
  compact: FG.gray,
  permission_request: FG.yellow,
  permission_denied: FG.yellow,
  tool_failure: FG.red,
  stop_failure: FG.red,
  task_created: FG.magenta,
  task_completed: FG.green,
  tool_rejected: FG.red,
};

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

function handleMessage(data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.type === "backlog_done" || msg.type === "sessions" || msg.type === "session_remove" || msg.type === "reset") {
    if (msg.type === "reset") {
      eventCount = 0;
      errorCount = 0;
      tokenTotal = 0;
      fileSet.clear();
      recentEvents.length = 0;
      phase = "idle";
      currentTool = null;
      statusLine.sessionState = "idle";
      statusLine.errors = 0;
      statusLine.apiError = null;
      statusLine.agentsRunning = 0;
      statusLine.agentsTotal = 0;
      statusLine.tasksCreated = 0;
      statusLine.tasksCompleted = 0;
      agentTree.length = 0;
      agentTreeVisible = false;
    }
    if (msg.type === "sessions" && msg.list) {
      sessionCount = msg.list.length;
    }
    return;
  }
  if (msg.type !== "line") return;

  eventCount++;
  const json = msg.json;
  const cat = categorize(json);
  if (cat === null) return;

  // Track state
  if (cat === "thinking") {
    thinkingActive = true;
    phase = "exploring";
  }
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
  if (cat === "session_start") {
    statusLine.sessionState = "active";
    statusLine.sessionStartTs = Date.now();
  }
  if (cat === "session_end") {
    statusLine.sessionState = "idle";
    statusLine.sessionStartTs = null;
  }
  if (cat === "compact") {
    statusLine.sessionState = json?._logstream_type === "PreCompact" ? "compacting" : "active";
  }
  if (cat === "permission_request") {
    statusLine.sessionState = "waiting";
    statusLine.waitingTool = json?.data?.tool_name || "tool";
  }
  if (statusLine.sessionState === "waiting" && (cat === "pre_tool" || cat === "post_tool" || cat === "thinking" || cat === "user_query" || cat === "tool_rejected")) {
    statusLine.sessionState = "active";
    statusLine.waitingTool = null;
  }
  if (cat === "user_query") {
    statusLine.errors = 0;
    statusLine.apiError = null;
    if (statusLine.sessionState === "idle") {
      statusLine.sessionState = "active";
      statusLine.sessionStartTs = statusLine.sessionStartTs || Date.now();
    }
  }
  if (cat === "tool_failure" || cat === "tool_rejected") statusLine.errors++;
  if (cat === "stop_failure") statusLine.apiError = json?.data?.reason || "API error";
  if (cat === "sub_agent") { statusLine.agentsRunning++; statusLine.agentsTotal++; }
  if (cat === "sub_agent_result") { statusLine.agentsRunning = Math.max(0, statusLine.agentsRunning - 1); }
  if (cat === "task_created") statusLine.tasksCreated++;
  if (cat === "task_completed") statusLine.tasksCompleted++;

  // Agent tree tracking
  if (cat === "sub_agent") {
    const id = json?.data?.agent_id || `agent-${agentTree.length}`;
    const type = json?.data?.agent_type || "Agent";
    agentTree.push({ id, type, status: "running", startTs: Date.now(), endTs: null });
    agentTreeVisible = true;
  }
  if (cat === "sub_agent_result") {
    const id = json?.data?.agent_id;
    const agent = (id && agentTree.find(a => a.id === id && a.status === "running"))
      || agentTree.find(a => a.status === "running");
    if (agent) {
      agent.status = "done";
      agent.endTs = Date.now();
    }
    if (agentTree.length > 0 && agentTree.every(a => a.status === "done")) {
      setTimeout(() => {
        if (agentTree.every(a => a.status === "done")) {
          agentTreeVisible = false;
          agentTree.length = 0;
          render();
        }
      }, 5000);
    }
  }

  // Build event line
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
    const text = (json?.data?.thinking || "").replace(/\n/g, " ").slice(0, 50);
    line += `${FG.magenta}${ITALIC}${text}${RESET}`;
  } else if (cat === "error") {
    const errMsg = json?.data?.tool_result || json?.data?.error || "error";
    line += `${FG.red}${String(errMsg).split("\n")[0].slice(0, 60)}${RESET}`;
  } else if (cat === "user_query") {
    const q = json?.data?.user_query || json?.data?.prompt || "";
    line += `${FG.yellow}${q.slice(0, 60)}${RESET}`;
  } else if (cat === "post_tool") {
    const toolName = json?.data?.tool_name || "";
    line += `${FG.green}${toolName} ✓${RESET}`;
  } else if (cat === "session_start") {
    const source = json?.data?.source || "started";
    line += `${FG.green}Session ${source}${RESET}`;
  } else if (cat === "session_end") {
    line += `${FG.gray}Session ended${RESET}`;
  } else if (cat === "compact") {
    line += `${DIM}${json?._logstream_type === "PreCompact" ? "Compacting..." : "Compaction done"}${RESET}`;
  } else if (cat === "permission_request") {
    const tool = json?.data?.tool_name || "tool";
    line += `${FG.yellow}Waiting: ${tool}${RESET}`;
  } else if (cat === "permission_denied") {
    const tool = json?.data?.tool_name || "tool";
    line += `${FG.yellow}Denied: ${tool}${RESET}`;
  } else if (cat === "tool_failure") {
    const tool = json?.data?.tool_name || "";
    const err = json?.data?.error || "failed";
    line += `${FG.red}${tool} failed — ${String(err).split("\n")[0].slice(0, 50)}${RESET}`;
  } else if (cat === "stop_failure") {
    const reason = json?.data?.reason || json?.data?.error_type || "API error";
    line += `${FG.red}${reason}${RESET}`;
  } else if (cat === "task_created") {
    const subj = json?.data?.task_subject || "New task";
    line += `${FG.magenta}${subj}${RESET}`;
  } else if (cat === "task_completed") {
    const subj = json?.data?.task_subject || "Task";
    line += `${FG.green}${subj} ✓${RESET}`;
  } else if (cat === "tool_rejected") {
    line += `${FG.red}Tool rejected by user${RESET}`;
  } else if (cat === "sub_agent") {
    const agentType = json?.data?.agent_type || "Agent";
    line += `${FG.cyan}${BOLD}▶ ${agentType}${RESET}`;
  } else if (cat === "sub_agent_result") {
    const agentType = json?.data?.agent_type || "Agent";
    const resultMsg = json?.data?.last_assistant_message || "";
    line += `${FG.cyan}◀ ${agentType}${RESET} ${DIM}${String(resultMsg).split("\n")[0].slice(0, 40)}${RESET}`;
  } else {
    const text = json?.data?.text || json?.data?.thinking || "";
    line += `${DIM}${String(text).replace(/\n/g, " ").slice(0, 50)}${RESET}`;
  }

  recentEvents.push(line);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();

  // Track for rejection strikethrough
  if (cat === "pre_tool") lastToolEventIdx = recentEvents.length - 1;

  // Rejection: strikethrough the last USE event
  if (cat === "tool_rejected" && lastToolEventIdx >= 0 && lastToolEventIdx < recentEvents.length) {
    const original = recentEvents[lastToolEventIdx];
    recentEvents[lastToolEventIdx] = `${DIM}${FG.red}✗${RESET} ${DIM}${stripAnsi(original)}${RESET}`;
  }

  render();
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function renderStatusLine(cols) {
  let parts = [];

  if (statusLine.sessionState === "active") {
    let label = `${FG.green}●${RESET} Active`;
    if (statusLine.sessionStartTs) {
      const secs = Math.floor((Date.now() - statusLine.sessionStartTs) / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      label += ` ${DIM}${m}m${String(s).padStart(2, "0")}s${RESET}`;
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

  const line = parts.join(`${DIM}  │  ${RESET}`);
  const pad = Math.max(0, cols - stripAnsi(line).length);
  return line + " ".repeat(pad);
}

function renderAgentTree(rows) {
  const lines = [];
  lines.push(`${BOLD}${FG.cyan} AGENTS${RESET}`);
  lines.push(`${DIM}${"─".repeat(TREE_WIDTH - 1)}${RESET}`);

  const running = agentTree.filter(a => a.status === "running").length;
  const total = agentTree.length;
  lines.push(` ${FG.cyan}${total - running}/${total} done${RESET}`);
  lines.push("");

  for (const agent of agentTree) {
    const icon = agent.status === "done" ? `${FG.green}✓${RESET}` : `${FG.yellow}●${RESET}`;
    const start = agent.startTs;
    const end = agent.endTs || Date.now();
    const secs = Math.floor((end - start) / 1000);
    const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;

    lines.push(` ${icon} ${agent.type}`);
    lines.push(`   ${DIM}${elapsed}${RESET}`);
  }

  while (lines.length < rows) lines.push("");
  if (lines.length > rows) lines.length = rows;

  return lines.map(l => {
    const len = stripAnsi(l).length;
    return l + " ".repeat(Math.max(0, TREE_WIDTH - len));
  });
}

function render() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Header
  const connStr = connected ? `${FG.green}●${RESET}` : `${FG.red}●${RESET}`;
  const phaseColor = {
    exploring: FG.magenta, implementing: FG.blue, debugging: FG.red,
    testing: FG.green, planning: FG.yellow, idle: FG.gray,
  }[phase] || FG.gray;

  let header = `${BOLD} LOUPE ${RESET} ${connStr} `;
  header += `${phaseColor}${BOLD}${thinkingActive ? "thinking" : phase}${RESET}`;
  if (currentTool) header += `  ${DIM}▸ ${currentTool.name}${RESET}`;

  let stats = ` ${DIM}events:${RESET}${eventCount}`;
  stats += `  ${DIM}files:${RESET}${fileSet.size}`;
  stats += `  ${DIM}tokens:${RESET}${formatTokens(tokenTotal)}`;
  if (errorCount > 0) stats += `  ${FG.red}errors:${errorCount}${RESET}`;
  if (sessionCount > 1) stats += `  ${DIM}sessions:${RESET}${sessionCount}`;

  const sep = DIM + "─".repeat(cols) + RESET;

  // Layout: header(2) + sep(1) + log + sep(1) + status(1)
  const logRows = rows - 5;
  const visibleEvents = recentEvents.slice(-logRows);

  // Build output
  let output = `${ESC}[H`;
  output += header + " ".repeat(Math.max(0, cols - stripAnsi(header).length)) + "\n";
  output += stats + " ".repeat(Math.max(0, cols - stripAnsi(stats).length)) + "\n";
  output += sep + "\n";

  // Event log with optional agent tree pane
  const logWidth = agentTreeVisible ? Math.max(40, cols - TREE_WIDTH - 1) : cols;
  const treeLines = agentTreeVisible ? renderAgentTree(logRows) : null;

  for (let i = 0; i < logRows; i++) {
    const eventLine = visibleEvents[i] || "";
    const stripped = stripAnsi(eventLine);
    let truncated;
    if (stripped.length > logWidth) {
      truncated = eventLine.slice(0, eventLine.length - (stripped.length - logWidth));
    } else {
      truncated = eventLine + " ".repeat(Math.max(0, logWidth - stripped.length));
    }

    if (agentTreeVisible && treeLines) {
      output += truncated + `${DIM}│${RESET}` + treeLines[i] + "\n";
    } else {
      output += truncated + "\n";
    }
  }

  output += sep + "\n";
  output += renderStatusLine(cols) + "\n";

  process.stdout.write(output);
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// Connection with auto-reconnect
let ws = null;
let reconnectTimer = null;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    connected = true;
    render();
  });

  ws.on("message", (data) => {
    handleMessage(data.toString());
  });

  ws.on("close", () => {
    connected = false;
    render();
    scheduleReconnect();
  });

  ws.on("error", () => {
    connected = false;
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

// Startup
process.stdout.write(HIDE_CURSOR + CLEAR_SCREEN);
process.on("exit", () => process.stdout.write(SHOW_CURSOR));
process.on("SIGINT", () => { process.stdout.write(SHOW_CURSOR); process.exit(0); });
process.on("SIGTERM", () => { process.stdout.write(SHOW_CURSOR); process.exit(0); });

// Handle terminal resize
process.stdout.on("resize", () => render());

connect();

// Periodic render for status freshness (elapsed time, agent tree timers)
setInterval(() => { if (connected) render(); }, 1000);
