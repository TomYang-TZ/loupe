#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { fork } = require("child_process");

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

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

function serveStatic(filePath, res) {
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

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

// --- Session tracking ---
const knownSessions = new Map(); // sessionId -> { label, lastEventTs }

function extractSessionFromLine(line) {
  try {
    const obj = JSON.parse(line);
    // Unwrap hook envelope if present
    const inner = (obj._logstream_type && obj.data) ? obj.data : obj;
    const sessionId = inner.session_id;
    if (!sessionId) return null;
    // Extract label from cwd (last path segment)
    const cwd = inner.cwd;
    let label = sessionId.slice(0, 8);
    if (cwd) {
      const parts = cwd.split("/");
      label = parts[parts.length - 1] || parts[parts.length - 2] || cwd;
    }
    return { id: sessionId, label };
  } catch {
    return null;
  }
}

function trackSession(line) {
  const info = extractSessionFromLine(line);
  if (!info) return;
  knownSessions.set(info.id, { label: info.label, lastEventTs: Date.now() });
}

function getSessionsList() {
  return [...knownSessions.entries()].map(([id, info]) => ({ id, label: info.label }));
}

// Prune sessions with no events for 5+ minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, info] of knownSessions) {
    if (info.lastEventTs < cutoff) {
      knownSessions.delete(id);
      broadcast(JSON.stringify({ type: "session_remove", id }));
    }
  }
}, 30000);

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
      trackSession(line);
      broadcast(JSON.stringify(msg));
    }
  });
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

function looksLikeJson(line) {
  const t = line.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

// --- WebSocket ---
function broadcast(data) {
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

// Truncate large values in JSON for backlog (keep live events full-size)
function truncateForBacklog(line) {
  if (line.length <= 4096) return line;
  if (!looksLikeJson(line)) return line.slice(0, 4096) + "...(truncated)";

  try {
    const obj = JSON.parse(line);
    truncateDeep(obj, 0);
    return JSON.stringify(obj);
  } catch {
    return line.slice(0, 4096) + "...(truncated)";
  }
}

function truncateDeep(obj, depth) {
  if (depth > 5 || obj === null || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "string" && val.length > 2048) {
      obj[key] = val.slice(0, 2048) + `...(${val.length - 2048} more chars)`;
    } else if (typeof val === "object" && val !== null) {
      truncateDeep(val, depth + 1);
    }
  }
}

async function sendBacklog(ws) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");

    // Only send entries from the last 5 minutes
    const cutoff = Date.now() - 5 * 60 * 1000;
    const recent = lines.filter((line) => {
      try {
        const obj = JSON.parse(line);
        const ts = obj._ts ? new Date(obj._ts).getTime() : 0;
        return ts > cutoff;
      } catch { return true; }
    });
    const backlog = recent.slice(-200);

    for (const line of backlog) {
      const truncated = truncateForBacklog(line);
      const msg = buildMessage(truncated);
      ws.send(JSON.stringify(msg));

      // Yield to event loop between messages to prevent buffer overflow
      await new Promise((r) => setTimeout(r, 5));
    }
    ws.send(JSON.stringify({ type: "backlog_done" }));
    // Track sessions from backlog for new clients
    for (const line of backlog) {
      trackSession(line);
    }
    // Send current session list
    ws.send(JSON.stringify({ type: "sessions", list: getSessionsList() }));
  } catch (err) {
    console.error("Backlog error:", err.message);
  }
}

// --- HTTP server ---
const server = http.createServer((req, res) => {
  const fullUrl = req.url;
  const url = fullUrl.split("?")[0];

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, file: filePath, clients: wss.clients.size }));
    return;
  }

  // Serve local images (only from .claude/image-cache)
  if (url === "/image" && fullUrl.includes("path=")) {
    const imgPath = decodeURIComponent(fullUrl.split("path=")[1]);
    const allowedPrefix = path.join(process.env.HOME, ".claude", "image-cache");
    const resolved = path.resolve(imgPath);
    if (!resolved.startsWith(allowedPrefix)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const imgMime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[ext] || "application/octet-stream";
    try {
      const data = fs.readFileSync(resolved);
      res.writeHead(200, { "Content-Type": imgMime, "Cache-Control": "max-age=3600" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  // Serve static UI files
  const file = url === "/" ? "index.html" : url.replace(/^\//, "");
  const safe = path.normalize(file).replace(/^(\.\.[\/\\])+/, "");
  const fullPath = path.join(uiDir, safe);

  if (fullPath.startsWith(uiDir)) {
    serveStatic(fullPath, res);
  } else {
    res.writeHead(403);
    res.end("Forbidden");
  }
});

// --- WebSocket server ---
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log(`Client connected (total: ${wss.clients.size})`);
  sendBacklog(ws);

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
