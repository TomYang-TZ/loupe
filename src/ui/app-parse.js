"use strict";

// LoupeParse — Pure extraction functions for categorizing and parsing events.
// No side effects, no DOM. Loaded after loupe-utils.js.

const LoupeParse = (() => {

  function unwrapHook(json) {
    return LoupeUtils.unwrapHook(json);
  }

  function categorize(msg) {
    const json = msg.json;
    if (json) {
      const hook = unwrapHook(json);
      if (hook) {
        // --- Dedup rule 1: Agent events via dedicated hooks only ---
        // Stash Agent PreToolUse prompt for the next SubagentStart
        if (hook.hookType === "PreToolUse") {
          if (hook.inner?.tool_name === "Agent") {
            if (!window._pendingAgentPrompts) window._pendingAgentPrompts = [];
            window._pendingAgentPrompts.push(hook.inner?.tool_input?.prompt || hook.inner?.tool_input?.description || null);
            return null;
          }
          return "tool_use";
        }
        if (hook.hookType === "PostToolUse") {
          if (hook.inner?.tool_name === "Agent") return null; // filtered out
          // --- Dedup rule 2: error path handled by PostToolUseFailure ---
          if (hook.inner?.is_error) return null; // filtered out
          return "post_tool";
        }
        // --- New hook categories ---
        if (hook.hookType === "SubagentStart") {
          if (window._pendingAgentPrompts && window._pendingAgentPrompts.length > 0) {
            hook.inner._agentPrompt = window._pendingAgentPrompts.shift();
          }
          return "sub_agent";
        }
        if (hook.hookType === "SubagentStop") return "sub_agent_result";
        if (hook.hookType === "PostToolUseFailure") return "tool_failure";
        if (hook.hookType === "StopFailure") return "stop_failure";
        if (hook.hookType === "SessionStart") return "session_start";
        if (hook.hookType === "SessionEnd") return "session_end";
        if (hook.hookType === "PreCompact") return "compact";
        if (hook.hookType === "PostCompact") return "compact";
        if (hook.hookType === "UserPromptSubmit") return "user_query";
        if (hook.hookType === "PermissionRequest") return "permission_request";
        if (hook.hookType === "PermissionDenied") return "permission_denied";
        if (hook.hookType === "TaskCreated") return "task_created";
        if (hook.hookType === "TaskCompleted") return "task_completed";
        // --- Existing categories ---
        if (hook.hookType === "tool_rejected") return "tool_rejected";
        if (hook.hookType === "tool_approved_with_message") return "tool_approved_msg";
        if (hook.hookType === "topic_shift") return "topic_shift";
        if (hook.hookType === "topic_clear") return "topic_clear";
        if (hook.hookType === "thinking") return "thinking";
        if (hook.hookType === "user_query") return "user_query";
        if (hook.hookType === "Notification") return "Notification";
        if (hook.hookType === "Stop") return "Stop";
      }
      // Fallback: check _logstream_type directly when hook unwrap fails (data missing)
      if (json._logstream_type) {
        const lt = json._logstream_type;
        if (lt === "SubagentStop") return "sub_agent_result";
        if (lt === "SubagentStart") return "sub_agent";
        if (lt === "PostToolUseFailure") return "tool_failure";
        if (lt === "StopFailure") return "stop_failure";
        if (lt === "SessionStart") return "session_start";
        if (lt === "SessionEnd") return "session_end";
        if (lt === "PreCompact" || lt === "PostCompact") return "compact";
        if (lt === "Stop") return "Stop";
        if (lt === "Notification") return "Notification";
        if (lt === "topic_shift") return "topic_shift";
        if (lt === "topic_clear") return "topic_clear";
        return null; // skip unrecognized hook types
      }
      const t = json.type;
      if (t === "user_query") return "user_query";
      if (t === "thinking" || json.thinking) return "thinking";
      if (t === "tool_use") return "tool_use";
      if (t === "tool_result") return json.is_error ? "error" : "tool_result";
      if (t === "error" || json.error) return "error";
      if (t === "text" || t === "content_block_delta" || t === "assistant") return "text";
    }
    const lower = (msg.data || "").toLowerCase();
    // Skip broken JSON lines that are clearly hook events
    if (lower.includes('"_logstream_type"')) return null;
    if (lower.includes("error") || lower.includes("fatal")) return "error";
    return "text";
  }

  function extractTitle(msg, category) {
    const json = msg.json;
    if (!json) return null;
    const hook = unwrapHook(json);
    if (hook && hook.inner) {
      if (category === "sub_agent" || category === "sub_agent_result") {
        return hook.inner.agent_type || hook.inner.subagent_type || (hook.inner.tool_input || {}).subagent_type || hook.inner.description || "Agent";
      }
      if (category === "permission_request" || category === "permission_denied") {
        return hook.inner.tool_name || null;
      }
      if (category === "tool_failure") {
        return hook.inner.tool_name || null;
      }
      if (category === "task_created" || category === "task_completed") {
        return null; // subject goes in summary
      }
      return hook.inner.tool_name || hook.inner.name || null;
    }
    if (category === "tool_use") return json.name || json.tool_name || null;
    return null;
  }

  function extractSummary(msg, category) {
    const json = msg.json;
    if (!json) return msg.data || "";
    const hook = unwrapHook(json);
    const inner = hook?.inner || json;

    if (category === "tool_use") {
      const input = inner.tool_input || inner.input || {};
      if (input.description) return input.description;
      if (input.file_path) return input.file_path;
      if (input.command) return input.command.split("\n")[0];
      if (input.pattern) return `pattern: ${input.pattern}`;
      if (input.query) return input.query;
      return Object.keys(input).slice(0, 3).join(", ");
    }
    if (category === "tool_result" || category === "post_tool") {
      const resp = inner.tool_response || {};
      const out = resp.stdout || inner.tool_result || inner.output || inner.content;
      if (typeof out === "string") return out.split("\n")[0];
      return "";
    }
    if (category === "error") return inner.error || inner.tool_result || "Error";
    if (category === "thinking") {
      const t = inner.thinking || inner.content || inner.text || "";
      return typeof t === "string" ? t : "";
    }
    if (category === "sub_agent") {
      const prompt = inner._agentPrompt || inner.description || inner.prompt || (inner.tool_input || {}).description || (inner.tool_input || {}).prompt || "";
      return typeof prompt === "string" ? prompt.slice(0, 100) : "";
    }
    if (category === "sub_agent_result") {
      const text = inner.last_assistant_message || inner.tool_response?.content?.[0]?.text || inner.tool_response?.status || "";
      return typeof text === "string" ? text.split("\n")[0] : "";
    }
    if (category === "permission_request") {
      return "Waiting: " + (inner.tool_name || "unknown");
    }
    if (category === "permission_denied") {
      return "Blocked: " + (inner.tool_name || "unknown") + (inner.reason ? " \u2014 " + inner.reason : "");
    }
    if (category === "tool_failure") {
      const errMsg = inner.error || inner.tool_result || "unknown error";
      const firstLine = typeof errMsg === "string" ? errMsg.split("\n")[0] : String(errMsg);
      return (inner.tool_name || "") + " failed \u2014 " + firstLine;
    }
    if (category === "stop_failure") {
      const reason = inner.reason || inner.error_type || inner.error || "API error";
      return typeof reason === "string" ? reason.split("\n")[0] : "API error";
    }
    if (category === "session_start") {
      return inner.source === "resume" ? "Session resumed" : "Session started";
    }
    if (category === "session_end") {
      return "Session ended";
    }
    if (category === "compact") {
      const hookType = hook?.hookType;
      return hookType === "PreCompact" ? "Context compacting..." : "Compaction complete";
    }
    if (category === "topic_shift") {
      return inner.title || "Topic shift";
    }
    if (category === "task_created") {
      return inner.task_subject || inner.subject || "New task";
    }
    if (category === "task_completed") {
      return (inner.task_subject || inner.subject || "Task") + " \u2713";
    }
    return "";
  }

  function extractBody(msg, category) {
    const json = msg.json;
    if (!json) return msg.data;
    const hook = unwrapHook(json);
    if (hook && hook.inner) {
      const inner = hook.inner;
      if (category === "sub_agent") return inner._agentPrompt || inner.prompt || inner.tool_input || inner;
      if (category === "sub_agent_result") return inner.last_assistant_message || inner.tool_response || inner;
      if (category === "tool_use") return inner.tool_input || inner.input || inner;
      if (category === "tool_result" || category === "post_tool") return inner.tool_response || inner.tool_result || inner.output || inner.content || inner;
      if (category === "error") return inner.error || inner.tool_result || inner;
      if (category === "thinking") return inner.thinking || inner.content || inner.text || inner;
      return inner;
    }
    if (category === "thinking") return json.thinking || json.content || json.text || msg.data;
    if (category === "text") return json.text || json.content || json.data || msg.data;
    if (category === "tool_use") return json.input || json.parameters || json;
    if (category === "tool_result" || category === "post_tool" || category === "error") return json.content || json.output || json.result || json.error || msg.data;
    return json;
  }

  function extractSessionId(msg) {
    const json = msg.json;
    if (!json) return null;
    const hook = unwrapHook(json);
    return (hook?.inner || json).session_id || null;
  }

  function extractUserQuery(msg) {
    const json = msg.json;
    if (!json) return null;
    const hook = unwrapHook(json);
    const inner = hook?.inner || json;
    return inner.user_query || inner.prompt || null;
  }

  function extractMeta(msg) {
    const json = msg.json;
    if (!json) return null;
    const hook = unwrapHook(json);
    return (hook?.inner || json).meta || null;
  }

  function extractUserImages(msg) {
    const json = msg.json;
    if (!json) return null;
    const hook = unwrapHook(json);
    return (hook?.inner || json).user_images || null;
  }

  function extractSessionLabel(msg) {
    const json = msg.json;
    if (!json) return null;
    const hook = unwrapHook(json);
    const cwd = (hook?.inner || json).cwd;
    if (cwd) { const parts = cwd.split("/"); return parts[parts.length - 1] || parts[parts.length - 2] || cwd; }
    return null;
  }

  return {
    unwrapHook,
    categorize,
    extractTitle,
    extractSummary,
    extractBody,
    extractSessionId,
    extractUserQuery,
    extractMeta,
    extractUserImages,
    extractSessionLabel,
  };
})();
