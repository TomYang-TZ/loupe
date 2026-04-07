"use strict";

// Convert Claude Code raw session transcript lines to loupe hook format.
// Raw: {type: "user"|"assistant", message: {role, content}, sessionId, timestamp, cwd, ...}
// Loupe: {_logstream_type, _ts, data: {session_id, ...}}

function convertSessionLine(obj) {
  if (!obj || !obj.type) return [];
  const sid = obj.sessionId || null;
  const ts = obj.timestamp || null;
  const base = { session_id: sid, cwd: obj.cwd };

  if (obj.type === "user") {
    const content = obj.message && obj.message.content;
    // Tool results: user messages containing tool_result blocks
    if (Array.isArray(content) && content.some(b => b.type === "tool_result")) {
      const events = [];
      for (const b of content) {
        if (b.type !== "tool_result") continue;
        // Try to find the tool name from the corresponding assistant message's tool_use
        // (not available here — we just emit the result)
        events.push({
          _logstream_type: b.is_error ? "PostToolUseFailure" : "PostToolUse",
          _ts: ts,
          data: { ...base, tool_use_id: b.tool_use_id, tool_response: typeof b.content === "string" ? b.content : JSON.stringify(b.content), is_error: !!b.is_error }
        });
      }
      return events;
    }
    // User prompt text
    let text = "";
    if (Array.isArray(content)) {
      text = content.filter(b => b.type === "text").map(b => b.text || "").join("\n");
    } else if (typeof content === "string") {
      text = content;
    }
    if (!text && obj.toolUseResult) return []; // tool result without text, skip
    return [{ _logstream_type: "UserPromptSubmit", _ts: ts, data: { ...base, prompt: text, user_query: text } }];
  }

  if (obj.type === "assistant") {
    const events = [];
    const contentBlocks = (obj.message && obj.message.content) || [];
    // Track tool_use blocks so we can attach tool_name to PostToolUse later
    for (const block of contentBlocks) {
      if (block.type === "thinking") {
        events.push({ _logstream_type: "thinking", _ts: ts, data: { ...base, thinking: block.thinking } });
      } else if (block.type === "tool_use") {
        events.push({ _logstream_type: "PreToolUse", _ts: ts, data: { ...base, tool_name: block.name, tool_input: block.input || {}, tool_use_id: block.id } });
      } else if (block.type === "text" && block.text) {
        events.push({ _logstream_type: "text", _ts: ts, data: { ...base, text: block.text } });
      }
    }
    return events;
  }

  // Skip: permission-mode, file-history-snapshot, queue-operation, summary, etc.
  return [];
}

// Convert an entire session file content to loupe events.
// Returns array of {line: JSON string, ts: milliseconds}
function convertSessionFile(content, maxLines) {
  const lines = content.split("\n").filter(l => l.trim());
  const events = [];
  const limit = maxLines || lines.length;
  // Process from end (most recent first) if maxLines is set
  const start = maxLines ? Math.max(0, lines.length - maxLines) : 0;
  for (let i = start; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      const converted = convertSessionLine(obj);
      for (const evt of converted) {
        events.push({ line: JSON.stringify(evt), ts: evt._ts ? new Date(evt._ts).getTime() : 0 });
      }
    } catch {}
  }
  return events;
}

module.exports = { convertSessionLine, convertSessionFile };
