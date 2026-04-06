"use strict";

// Shared browser-side utilities for gravity.js, momentum.js, and app modules.
// Canonical server-side sources: src/shared/*.js — keep in sync.

const LoupeUtils = (() => {
  // --- Hook envelope unwrapping (from shared/hook-unwrap.js) ---

  function unwrapHook(json) {
    if (json && json._logstream_type && json.data) {
      return { hookType: json._logstream_type, ts: json._ts, inner: json.data };
    }
    return null;
  }

  function getInner(json) {
    if (!json) return {};
    return (json._logstream_type && json.data) ? json.data : json;
  }

  // --- Tool classification (from shared/tool-classify.js) ---

  const TOOL_ACTIONS = {
    Read: "read", Grep: "read", Glob: "read",
    Edit: "edit", Write: "edit",
    Bash: "exec",
  };

  const BASH_CMD_CATEGORY = {
    cat: "read", head: "read", tail: "read", less: "read", more: "read",
    ls: "read", stat: "read", file: "read", wc: "read",
    sed: "edit", awk: "edit", tee: "edit", chmod: "edit", chown: "edit",
    chgrp: "edit", touch: "edit", mv: "edit", cp: "edit",
    rm: "exec", mkdir: "exec", rmdir: "exec",
    node: "exec", python: "exec", python3: "exec", npm: "exec", npx: "exec",
    make: "exec", cargo: "exec", go: "exec", git: "exec", docker: "exec",
    curl: "exec", wget: "exec",
  };

  function extractBashSubcommand(cmd) {
    if (!cmd) return null;
    const m = cmd.match(/^(?:sudo\s+|env\s+\S+=\S+\s+)*(\w[\w.+-]*)/);
    return m ? m[1] : null;
  }

  // --- Session colors (from shared/session-extract.js) ---

  const SESSION_COLORS = ["#8b5cf6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#6366f1", "#14b8a6"];

  // --- Entry-level extraction (used by gravity.js + momentum.js) ---

  function extractToolName(entry) {
    const json = entry.json; if (!json) return null;
    const hook = (json._logstream_type && json.data) ? json.data : null;
    return (hook || json).tool_name || (hook || json).name || null;
  }

  function extractFilePath(entry) {
    const json = entry.json; if (!json) return null;
    const hook = (json._logstream_type && json.data) ? json.data : null;
    const inner = hook || json;
    const input = inner.tool_input || inner.input || {};
    if (input.file_path) return input.file_path;
    if (input.path && !input.command) return input.path;
    if (input.command) {
      const cmd = input.command;
      const fileMatch = cmd.match(/(?:^|\s)(\/\S+\.\w+)/);
      if (fileMatch) return fileMatch[1];
      const dirMatch = cmd.match(/(?:^|\s)(\/(?:[^\s\/]+\/)+[^\s\/]+)/);
      if (dirMatch) return dirMatch[1];
    }
    return null;
  }

  function extractBashCommand(entry) {
    const json = entry.json; if (!json) return null;
    const hook = (json._logstream_type && json.data) ? json.data : null;
    const inner = hook || json;
    const input = inner.tool_input || inner.input || {};
    return input.command || null;
  }

  function classifyAction(entry) {
    const toolName = extractToolName(entry);
    if (!toolName) return "read";
    let action = TOOL_ACTIONS[toolName] || "read";
    if (toolName === "Bash") {
      const json = entry.json;
      const hook = (json._logstream_type && json.data) ? json.data : null;
      const input = (hook || json).tool_input || (hook || json).input || {};
      const subcmd = extractBashSubcommand(input.command);
      if (subcmd && BASH_CMD_CATEGORY[subcmd]) action = BASH_CMD_CATEGORY[subcmd];
      else if (subcmd) action = "exec";
    }
    return action;
  }

  // --- Shared rendering helpers ---

  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function formatTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
    return String(n);
  }

  return {
    unwrapHook, getInner,
    TOOL_ACTIONS, BASH_CMD_CATEGORY, extractBashSubcommand,
    SESSION_COLORS,
    extractToolName, extractFilePath, extractBashCommand, classifyAction,
    esc, formatTime, formatTokens,
  };
})();
