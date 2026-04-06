#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { fork } = require("child_process");
const islandState = require("./island-state");
const sessionTracker = require("./session-tracker");
const { sendBacklog, truncateForBacklog, looksLikeJson } = require("./backlog");
const { createRouter } = require("./http-routes");

const args = process.argv.slice(2);
let port = 8390;
let filePath = null;
let jsonMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--json") {
    jsonMode = true;
  } else if (!args[i].startsWith("-")) {
    filePath = path.resolve(args[i]);
  }
}

if (!filePath) {
  console.error("Usage: logstream <file> [--port 8390] [--json]");
  console.error("");
  console.error("  <file>    Path to log file to watch");
  console.error("  --port    Port number (default: 8390)");
  console.error("  --json    Enable JSON-aware parsing");
  process.exit(1);
}

// Create the file if it doesn't exist
if (!fs.existsSync(filePath)) {
  fs.writeFileSync(filePath, "");
}

const uiDir = path.join(__dirname, "..", "ui");

// --- Dedup for thinking entries (hook + watcher can double-log) ---
const recentThinking = new Set();
const DEDUP_WINDOW = 10000; // 10 seconds

function isDuplicateThinking(json) {
  if (!json || json._logstream_type !== "thinking") return false;
  const text = json.data?.thinking || "";
  // Use first 200 chars as key to avoid huge strings in the Set
  const key = text.slice(0, 200);
  if (recentThinking.has(key)) return true;
  recentThinking.add(key);
  setTimeout(() => recentThinking.delete(key), DEDUP_WINDOW);
  return false;
}

// --- Replay analysis session filter ---
// When `claude --print` runs for replay analysis, it creates a session that
// shows up in the log. Detect and suppress it.
const replaySessionIds = new Set();
const REPLAY_PROMPT_SIG = "You are analyzing a Claude Code agent session";

function isReplayAnalysisLine(json) {
  if (!json) return false;
  const inner = (json._logstream_type && json.data) ? json.data : json;
  const sid = inner.session_id;
  if (!sid) return false;

  // Already known replay session
  if (replaySessionIds.has(sid)) return true;

  // Detect by user_query or thinking content matching the analysis prompt signature
  const uq = inner.user_query || "";
  const thinking = inner.thinking || "";
  if (uq.includes(REPLAY_PROMPT_SIG) || thinking.includes(REPLAY_PROMPT_SIG)) {
    replaySessionIds.add(sid);
    // Auto-expire after 10 minutes
    setTimeout(() => replaySessionIds.delete(sid), 10 * 60 * 1000);
    return true;
  }
  return false;
}

function buildMessage(line) {
  const msg = { type: "line", data: line, ts: Date.now(), json: null };
  if (jsonMode || looksLikeJson(line)) {
    try {
      msg.json = JSON.parse(line);
    } catch {}
  }
  return msg;
}

// --- WebSocket ---
// Clients in backlog send are buffered — live events queued until backlog completes
const pendingBacklog = new Set(); // clients currently receiving backlog
const pendingQueue = new Map();   // client → [queued messages]

function broadcast(data) {
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (pendingBacklog.has(client)) {
      // Queue live events until backlog is done
      if (!pendingQueue.has(client)) pendingQueue.set(client, []);
      pendingQueue.get(client).push(data);
    } else {
      client.send(data);
    }
  }
}

// --- Session tracker init ---
sessionTracker.init(broadcast);

// --- File tailing ---
let fileSize = fs.statSync(filePath).size;
let buffer = "";

function readNewBytes() {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }

  if (stat.size < fileSize) {
    fileSize = 0;
    broadcast(JSON.stringify({ type: "reset" }));
  }
  if (stat.size === fileSize) return;

  const stream = fs.createReadStream(filePath, {
    start: fileSize,
    encoding: "utf-8",
  });

  let chunk = "";
  stream.on("data", (data) => (chunk += data));
  stream.on("end", () => {
    fileSize = stat.size;
    buffer += chunk;

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (line.trim() === "") continue;
      const msg = buildMessage(line);
      if (msg.json && isDuplicateThinking(msg.json)) continue;
      if (msg.json && isReplayAnalysisLine(msg.json)) continue;
      sessionTracker.trackSession(line);
      broadcast(JSON.stringify(msg));
      // Feed to island state machine (skip during initial backlog read)
      if (msg.json && !islandBacklogReading) islandState.processEvent(msg.json, msg.ts);
    }
  });
}

// --- HTTP server + WebSocket ---
const server = http.createServer();
const wss = new WebSocketServer({ server });

const router = createRouter(filePath, uiDir, wss, {
  buildMessage,
  isReplayAnalysisLine,
  looksLikeJson,
});
server.on("request", router);

wss.on("connection", (ws) => {
  console.log(`Client connected (total: ${wss.clients.size})`);
  pendingBacklog.add(ws);
  sendBacklog(ws, filePath, {
    buildMessage,
    isReplayAnalysisLine,
    trackSession: sessionTracker.trackSession,
    getSessionsList: sessionTracker.getSessionsList,
  }).then(() => {
    pendingBacklog.delete(ws);
    // Flush live events that arrived during backlog send
    const queued = pendingQueue.get(ws);
    if (queued) {
      for (const data of queued) {
        if (ws.readyState === 1) ws.send(data);
      }
      pendingQueue.delete(ws);
    }
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "show_window") {
        for (const client of wss.clients) {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify({ type: "show_window" }));
          }
        }
      }
      // Dynamic history: client requests older events
      // { type: "fetch_history", before: timestamp, count: 200 }
      if (msg.type === "fetch_history") {
        const before = msg.before || Date.now();
        const count = Math.min(msg.count || 200, 500);
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const allLines = content.split("\n").filter(l => l.trim() !== "");
          const older = [];
          for (let i = allLines.length - 1; i >= 0 && older.length < count; i--) {
            try {
              const obj = JSON.parse(allLines[i]);
              const ts = obj._ts ? new Date(obj._ts).getTime() : 0;
              if (ts < before) older.unshift(allLines[i]);
            } catch {}
          }
          for (const line of older) {
            const m = buildMessage(truncateForBacklog(line));
            if (m.json && isReplayAnalysisLine(m.json)) continue;
            ws.send(JSON.stringify({ ...m, type: "history" }));
          }
          ws.send(JSON.stringify({ type: "history_done", count: older.length }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "history_done", count: 0, error: err.message }));
        }
      }
    } catch (e) { /* ignore non-JSON */ }
  });

  ws.on("close", () => {
    console.log(`Client disconnected (total: ${wss.clients.size})`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

// --- File watcher ---
let watchDebounce = null;
fs.watch(filePath, () => {
  if (watchDebounce) return;
  watchDebounce = setTimeout(() => {
    watchDebounce = null;
    readNewBytes();
  }, 50);
});

// Fallback poll
setInterval(readNewBytes, 500);

// --- Start thinking watcher as child process ---
let watcherProcess = null;
const watcherScript = path.join(__dirname, "watcher.js");

if (fs.existsSync(watcherScript)) {
  watcherProcess = fork(watcherScript, [filePath], { silent: true });
  console.log(`thinking-watcher started (PID: ${watcherProcess.pid})`);
  watcherProcess.on("exit", (code) => {
    console.log(`thinking-watcher exited (code: ${code})`);
    watcherProcess = null;
  });
}

// --- Island state ---
let islandBacklogReading = true;
// Normalize after initial backlog read (first readNewBytes completes within ~1s)
setTimeout(() => { islandBacklogReading = false; }, 2000);

islandState.init((state) => {
  // Send island state only to non-backlog clients (don't queue during backlog)
  const msg = JSON.stringify({ type: "island_state", data: state });
  for (const client of wss.clients) {
    if (client.readyState === 1 && !pendingBacklog.has(client)) {
      client.send(msg);
    }
  }
});

// --- Start ---
server.listen(port, () => {
  console.log(`logstream watching: ${filePath}`);
  console.log(`UI: http://localhost:${port}`);
  console.log(`PID: ${process.pid}`);
});

// Graceful shutdown
function shutdown() {
  console.log("\nShutting down...");
  if (watcherProcess) {
    watcherProcess.kill();
    watcherProcess = null;
  }
  wss.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
