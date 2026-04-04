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
const recentEvents = [];   // last N events for the scrolling log
const MAX_EVENTS = 100;
const fileSet = new Set();

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
};

function categorize(json) {
  if (!json) return "unknown";
  const type = json._logstream_type;
  if (type === "thinking") return "thinking";
  if (type === "user_query") return "user_query";
  if (type === "PreToolUse") return "pre_tool";
  if (type === "PostToolUse") return json.data?.is_error ? "error" : "post_tool";
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
      // Infer phase
      if (["Read", "Glob", "Grep", "LSP"].some(t => tool.name.includes(t))) phase = "exploring";
      else if (["Edit", "Write"].some(t => tool.name.includes(t))) phase = "implementing";
      else if (tool.name.includes("Bash")) {
        const cmd = json.data.tool_input?.command || "";
        if (/test|jest|pytest|cargo test|npm test/.test(cmd)) phase = "testing";
        else if (phase === "idle") phase = "implementing";
      }
      else if (tool.name.includes("Agent")) phase = "planning";
    }
  }
  if (cat === "error") errorCount++;

  // Token tracking
  const usage = json?.data?.message?.usage || json?.message?.usage;
  if (usage) tokenTotal += (usage.input_tokens || 0) + (usage.output_tokens || 0);

  // Build event line
  const ts = new Date(msg.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let line = `${DIM}${ts}${RESET} `;

  const color = catColors[cat] || FG.gray;
  const badge = {
    pre_tool: "USE", post_tool: "OK", tool_use: "USE", tool_result: "RES",
    error: "ERR", thinking: "THK", text: "TXT", sub_agent: "AGT",
    sub_agent_result: "AGT", user_query: "QRY",
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
    const q = json?.data?.user_query || "";
    line += `${FG.yellow}${q.slice(0, 60)}${RESET}`;
  } else if (cat === "post_tool") {
    const toolName = json?.data?.tool_name || "";
    line += `${FG.green}${toolName} ✓${RESET}`;
  } else {
    const text = json?.data?.text || json?.data?.thinking || "";
    line += `${DIM}${String(text).replace(/\n/g, " ").slice(0, 50)}${RESET}`;
  }

  recentEvents.push(line);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();

  render();
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function render() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Header (3 lines)
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

  // Event log (fill remaining rows)
  const logRows = rows - 4;
  const visibleEvents = recentEvents.slice(-logRows);

  // Build output
  let output = `${ESC}[H`; // cursor to top
  output += header + " ".repeat(Math.max(0, cols - stripAnsi(header).length)) + "\n";
  output += stats + " ".repeat(Math.max(0, cols - stripAnsi(stats).length)) + "\n";
  output += sep + "\n";

  for (let i = 0; i < logRows; i++) {
    const line = visibleEvents[i] || "";
    // Truncate to terminal width
    const stripped = stripAnsi(line);
    if (stripped.length > cols) {
      output += line.slice(0, line.length - (stripped.length - cols)) + "\n";
    } else {
      output += line + " ".repeat(Math.max(0, cols - stripped.length)) + "\n";
    }
  }

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

// Periodic render for status freshness
setInterval(() => { if (connected) render(); }, 1000);
