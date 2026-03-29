#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

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

const uiPath = path.join(__dirname, "index.html");

function getUiHtml() {
  return fs.readFileSync(uiPath, "utf-8");
}

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
    const backlog = lines.slice(-50);

    for (const line of backlog) {
      const truncated = truncateForBacklog(line);
      const msg = buildMessage(truncated);
      ws.send(JSON.stringify(msg));

      // Yield to event loop between messages to prevent buffer overflow
      await new Promise((r) => setTimeout(r, 5));
    }
    ws.send(JSON.stringify({ type: "backlog_done" }));
  } catch (err) {
    console.error("Backlog error:", err.message);
  }
}

// --- HTTP server ---
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getUiHtml());
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        file: filePath,
        clients: wss.clients.size,
      })
    );
  } else {
    res.writeHead(404);
    res.end("Not found");
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

// --- Start ---
server.listen(port, () => {
  console.log(`logstream watching: ${filePath}`);
  console.log(`UI: http://localhost:${port}`);
  console.log(`PID: ${process.pid}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  wss.close();
  server.close();
  process.exit(0);
});
