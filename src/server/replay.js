// Entry condensation for replay analysis — extracted from index.js

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

module.exports = { condenseEntry, condenseRawEntry };
