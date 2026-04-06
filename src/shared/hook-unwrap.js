"use strict";

// Unwrap the hook envelope that wraps all logstream events.
// Hook events have shape: { _logstream_type, _ts, data: { ...inner } }
// Returns { hookType, ts, inner } or null if not a hook envelope.

function unwrapHook(json) {
  if (json && json._logstream_type && json.data) {
    return { hookType: json._logstream_type, ts: json._ts, inner: json.data };
  }
  return null;
}

// Get the inner data object, unwrapping hook envelope if present.
function getInner(json) {
  if (!json) return {};
  return (json._logstream_type && json.data) ? json.data : json;
}

module.exports = { unwrapHook, getInner };
