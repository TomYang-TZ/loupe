"use strict";

// Categorize a hook event by its _logstream_type.
// Returns a category string or null to skip the event.
// This is the shared core — consumers may add their own filtering on top
// (e.g., TUI filters Agent PreToolUse/PostToolUse, window UI has different logic).

const HOOK_CATEGORIES = {
  PreToolUse: "pre_tool",
  PostToolUse: "post_tool",
  thinking: "thinking",
  UserPromptSubmit: "user_query",
  user_query: "user_query",
  SubagentStart: "sub_agent",
  SubagentStop: "sub_agent_result",
  PostToolUseFailure: "tool_failure",
  StopFailure: "stop_failure",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  PreCompact: "compact",
  PostCompact: "compact",
  PermissionRequest: "permission_request",
  PermissionDenied: "permission_denied",
  TaskCreated: "task_created",
  TaskCompleted: "task_completed",
  tool_rejected: "tool_rejected",
  tool_approved_with_message: "tool_approved_msg",
  topic_shift: "topic_shift",
  topic_clear: "topic_clear",
  Notification: "Notification",
  Stop: "Stop",
};

// Basic categorization from hookType. Returns category string or null.
function categorizeHookType(hookType) {
  return HOOK_CATEGORIES[hookType] || null;
}

module.exports = { HOOK_CATEGORIES, categorizeHookType };
