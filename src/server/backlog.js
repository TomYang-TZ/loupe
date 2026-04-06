// Backlog sending — extracted from index.js
const fs = require("fs");

function looksLikeJson(line) {
  const t = line.trimStart();
  return t.startsWith("{") || t.startsWith("[");
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

async function sendBacklog(ws, filePath, opts) {
  const { buildMessage, isReplayAnalysisLine, trackSession, getSessionsList } = opts;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const allLines = content.split("\n").filter((l) => l.trim() !== "");

    // Scan backwards to find query boundaries (UserPromptSubmit/user_query)
    // Send only events that belong to queries from the last 200 lines
    const tail = allLines.slice(-200);
    let firstQueryIdx = -1;
    for (let i = 0; i < tail.length; i++) {
      try {
        const obj = JSON.parse(tail[i]);
        const type = obj._logstream_type || obj.data?.hook_event_name;
        if (type === "UserPromptSubmit" || type === "user_query") {
          if (firstQueryIdx < 0) firstQueryIdx = i;
        }
      } catch {}
    }
    // Only send from the first query boundary onwards (skip orphaned preamble)
    const backlog = firstQueryIdx >= 0 ? tail.slice(firstQueryIdx) : tail.slice(-50);

    for (const line of backlog) {
      const truncated = truncateForBacklog(line);
      const msg = buildMessage(truncated);
      if (!msg.json) continue; // skip broken/split lines
      if (isReplayAnalysisLine(msg.json)) continue;
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

module.exports = { sendBacklog, truncateForBacklog, truncateDeep, looksLikeJson };
