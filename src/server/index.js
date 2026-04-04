#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { fork, execSync } = require("child_process");

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

// --- Entry condensation for replay analysis ---
function condenseEntry(obj) {
  const type = obj._logstream_type;
  const inner = obj.data || obj;
  const ts = obj._ts ? new Date(obj._ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "??:??:??";

  if (type === "user_query") {
    const q = inner.user_query || "";
    return `[${ts}] USER QUERY: "${q.slice(0, 200)}"`;
  }

  if (type === "thinking") {
    const thinking = (inner.thinking || "").slice(0, 150).replace(/\n/g, " ");
    const q = inner.user_query ? ` (Q: "${inner.user_query.slice(0, 100)}")` : "";
    return `[${ts}] THINK: "${thinking}"${q}`;
  }

  if (type === "PreToolUse") {
    const toolName = inner.tool_name || "unknown";
    const input = inner.tool_input || {};

    if (toolName === "Agent") {
      const desc = input.description || input.prompt?.slice(0, 80) || "agent";
      return `[${ts}] AGENT spawn: "${desc}"`;
    }

    let detail = "";
    if (input.file_path) detail = input.file_path;
    else if (input.command) detail = input.command.split("\n")[0].slice(0, 120);
    else if (input.pattern) detail = `pattern: ${input.pattern}`;
    else if (input.query) detail = input.query.slice(0, 80);
    else detail = Object.keys(input).slice(0, 3).join(", ");

    return `[${ts}] USE ${toolName} → ${detail}`;
  }

  if (type === "PostToolUse") {
    const toolName = inner.tool_name || "unknown";
    const resp = inner.tool_response || {};
    const isError = inner.is_error || inner.error;

    if (toolName === "Agent") {
      const text = resp.content?.[0]?.text || resp.status || "";
      return `[${ts}] AGENT result: "${(typeof text === "string" ? text : "").split("\n")[0].slice(0, 120)}"`;
    }

    if (isError) {
      const errMsg = typeof inner.error === "string" ? inner.error : (inner.tool_result || resp.stderr || "error");
      return `[${ts}] ERROR ${toolName}: ${String(errMsg).split("\n")[0].slice(0, 150)}`;
    }

    // Skip non-error PostToolUse (too verbose for analysis)
    return null;
  }

  return null;
}

// --- Raw session transcript condensation ---
function condenseRawEntry(obj) {
  const type = obj.type;

  // User message
  if (type === "user") {
    if (obj.isMeta) return null; // skip meta messages (image refs, etc.)
    const content = obj.message?.content;
    let text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter(b => typeof b === "string" || b.type === "text").map(b => typeof b === "string" ? b : b.text).join(" ")
        : "";
    text = text.replace(/\s*\[Image #\d+\]\s*/g, " ").trim();
    if (!text) return null;
    return `[USER] ${text.slice(0, 300)}`;
  }

  // Assistant message
  if (type === "assistant" && obj.message?.content) {
    const parts = [];
    for (const block of obj.message.content) {
      if (block.type === "thinking" && block.thinking) {
        parts.push(`[THINK] ${block.thinking.slice(0, 200).replace(/\n/g, " ")}`);
      } else if (block.type === "tool_use") {
        const name = block.name || "unknown";
        const input = block.input || {};
        let detail = "";
        if (input.file_path) detail = input.file_path;
        else if (input.command) detail = input.command.split("\n")[0].slice(0, 120);
        else if (input.pattern) detail = `pattern: ${input.pattern}`;
        else if (input.prompt) detail = input.prompt.slice(0, 80);
        else if (input.description) detail = input.description;
        else detail = Object.keys(input).slice(0, 3).join(", ");
        parts.push(`[USE ${name}] ${detail}`);
      } else if (block.type === "text" && block.text) {
        parts.push(`[TEXT] ${block.text.slice(0, 150).replace(/\n/g, " ")}`);
      }
    }
    // Include token usage if available
    const usage = obj.message?.usage;
    const tokenInfo = usage ? ` (${usage.input_tokens || 0}in/${usage.output_tokens || 0}out)` : "";
    return parts.length > 0 ? parts.join("\n") + tokenInfo : null;
  }

  // Tool result
  if (type === "tool_result" || type === "tool_response") {
    const isError = obj.is_error;
    const content = obj.content || obj.output || "";
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map(b => typeof b === "string" ? b : b.text || "").join(" ")
        : String(content);
    const prefix = isError ? "[ERROR]" : "[RESULT]";
    return `${prefix} ${text.split("\n")[0].slice(0, 200)}`;
  }

  return null;
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

  // API: return all PreToolUse entries with file paths (for gravity map)
  if (url === "/api/file-accesses") {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const results = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj._logstream_type !== "PreToolUse") continue;
          results.push(line);
        } catch {}
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Get condensed session timeline for replay popover
  if (url === "/api/session-timeline" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { sessionId } = JSON.parse(body);
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "sessionId required" }));
          return;
        }

        const claudeProjectsDir = path.join(process.env.HOME, ".claude", "projects");
        let rawSessionFile = null;
        try {
          for (const projDir of fs.readdirSync(claudeProjectsDir)) {
            const candidate = path.join(claudeProjectsDir, projDir, `${sessionId}.jsonl`);
            if (fs.existsSync(candidate)) { rawSessionFile = candidate; break; }
          }
        } catch {}

        if (!rawSessionFile) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session file not found", timeline: [] }));
          return;
        }

        const content = fs.readFileSync(rawSessionFile, "utf-8");
        const lines = content.split("\n").filter(l => l.trim());
        const timeline = [];
        let entryNum = 0;

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            entryNum++;
            const type = obj.type;

            if (type === "user") {
              const c = obj.message?.content;
              let text = typeof c === "string" ? c :
                Array.isArray(c) ? c.filter(b => typeof b === "string" || b.type === "text").map(b => typeof b === "string" ? b : b.text).join(" ") : "";
              text = text.replace(/\s*\[Image #\d+\]\s*/g, " ").trim();
              if (text) timeline.push({ n: entryNum, type: "user", text: text.slice(0, 200) });
            }

            if (type === "assistant" && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === "thinking" && block.thinking) {
                  timeline.push({ n: entryNum, type: "think", text: block.thinking.slice(0, 120).replace(/\n/g, " ") });
                } else if (block.type === "tool_use") {
                  const input = block.input || {};
                  let detail = input.file_path || input.command?.split("\n")[0]?.slice(0, 80) || input.pattern || input.description || "";
                  timeline.push({ n: entryNum, type: "tool", tool: block.name || "?", detail: detail.slice(0, 100) });
                } else if (block.type === "text" && block.text) {
                  timeline.push({ n: entryNum, type: "text", text: block.text.slice(0, 120).replace(/\n/g, " ") });
                }
              }
              const usage = obj.message?.usage;
              if (usage) {
                timeline[timeline.length - 1].tokens = { in: usage.input_tokens, out: usage.output_tokens };
              }
            }

            if (type === "tool_result" || type === "tool_response") {
              const isError = obj.is_error;
              if (isError) {
                const c = obj.content || obj.output || "";
                const text = typeof c === "string" ? c : Array.isArray(c) ? c.map(b => typeof b === "string" ? b : b.text || "").join(" ") : String(c);
                timeline.push({ n: entryNum, type: "error", text: text.split("\n")[0].slice(0, 150) });
              }
            }
          } catch {}
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ timeline, totalEntries: entryNum }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Replay analysis via Claude CLI
  if (url === "/api/replay-analysis" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { sessionId } = JSON.parse(body);
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "sessionId required" }));
          return;
        }

        // Find the raw session transcript file
        const claudeProjectsDir = path.join(process.env.HOME, ".claude", "projects");
        let rawSessionFile = null;
        try {
          for (const projDir of fs.readdirSync(claudeProjectsDir)) {
            const candidate = path.join(claudeProjectsDir, projDir, `${sessionId}.jsonl`);
            if (fs.existsSync(candidate)) {
              rawSessionFile = candidate;
              break;
            }
          }
        } catch {}

        if (!rawSessionFile) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Raw session file not found for this session" }));
          return;
        }

        // Read the raw session transcript
        const content = fs.readFileSync(rawSessionFile, "utf-8");
        const lines = content.split("\n").filter(l => l.trim());

        // Condense each raw transcript entry
        const condensed = [];
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            const summary = condenseRawEntry(obj);
            if (summary) condensed.push(summary);
          } catch {}
        }

        if (condensed.length === 0) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No entries found in session transcript" }));
          return;
        }

        // Cap at 500 lines: keep first 100 + last 400
        let condensedLog;
        if (condensed.length > 500) {
          const head = condensed.slice(0, 100);
          const tail = condensed.slice(-400);
          condensedLog = [...head, `\n... (${condensed.length - 500} entries omitted) ...\n`, ...tail].join("\n");
        } else {
          condensedLog = condensed.join("\n");
        }

        const prompt = `You are analyzing a Claude Code agent session transcript. Produce a structured analysis in the EXACT format below. Be specific — cite tool names, file names, and entry numbers. Be concise but insightful.

## Session Profile
- **Task**: [1-sentence: what was the agent trying to do?]
- **Outcome**: [succeeded / partially succeeded / failed / abandoned]
- **Duration**: [estimate from timestamps, e.g. "~8 minutes active across 47 entries"]
- **Behavioral Archetype**: [Pick ONE: focused-executor | explorer-debugger | loop-fighter | methodical-planner | rapid-iterater | deep-diver] — [1-sentence justification]

## Time Breakdown
Show approximate % of session time in each phase. Use a simple bar:
- Exploring: [██░░░░░░░░] ~20%
- Implementing: [████░░░░░░] ~40%
- Debugging: [██░░░░░░░░] ~20%
- Testing: [█░░░░░░░░░] ~10%
- Planning: [█░░░░░░░░░] ~10%

## Key Phases
Number the major phases chronologically. For each:
1. **[Phase name]** (entries ~N-M) — What happened, key decisions, outcome

## Anomalies & Warnings
Flag unusual behaviors the human operator should know about:
- Loops: Where did the agent get stuck? How long? What broke the loop?
- Wasted effort: Actions that contributed nothing to the outcome
- Missed shortcuts: Files or approaches that should have been tried earlier
- Error spirals: Cascading errors from a single root cause

## Recommendations for Next Time
Actionable advice for a human using this agent on similar tasks:
- [Specific recommendation 1]
- [Specific recommendation 2]
- [Specific recommendation 3]

## Efficiency Score
**[N]/10** — [1-sentence justification]

---
SESSION LOG (${condensed.length} entries from raw transcript):
${condensedLog}`;

        try {
          const analysis = execSync("claude --print --model sonnet", {
            input: prompt,
            timeout: 120000,
            encoding: "utf-8",
            maxBuffer: 2 * 1024 * 1024,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ analysis }));
        } catch (err) {
          const msg = err.stderr ? err.stderr.toString().slice(0, 200) : err.message;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Claude CLI failed: ${msg}` }));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
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
