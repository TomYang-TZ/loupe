"use strict";

const SESSION_COLORS = ["#8b5cf6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#6366f1", "#14b8a6"];

// Extract session ID from a hook-unwrapped or raw JSON object.
function extractSessionId(json) {
  if (!json) return null;
  const inner = (json._logstream_type && json.data) ? json.data : json;
  return inner.session_id || null;
}

// Extract user query text from a hook-unwrapped or raw JSON object.
function extractUserQuery(json) {
  if (!json) return null;
  const inner = (json._logstream_type && json.data) ? json.data : json;
  return inner.user_query || inner.prompt || null;
}

// Extract a human-readable session label from the cwd field.
function extractSessionLabel(json) {
  if (!json) return null;
  const inner = (json._logstream_type && json.data) ? json.data : json;
  const cwd = inner.cwd;
  if (!cwd) return null;
  const parts = cwd.split("/");
  return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
}

module.exports = { SESSION_COLORS, extractSessionId, extractUserQuery, extractSessionLabel };
