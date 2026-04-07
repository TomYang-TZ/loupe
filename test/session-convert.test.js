#!/usr/bin/env node
"use strict";

// Tests for session-convert.js: raw Claude transcript → loupe format
// Run: node test/session-convert.test.js

const { convertSessionLine, convertSessionFile } = require("../src/server/session-convert");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }
}

console.log("\nconvertSessionLine — user prompt");
{
  const obj = {
    type: "user",
    message: { role: "user", content: "fix the bug" },
    sessionId: "abc-123",
    timestamp: "2026-04-01T10:00:00Z",
    cwd: "/home/user/project",
  };
  const events = convertSessionLine(obj);
  assert(events.length === 1, "produces 1 event");
  assert(events[0]._logstream_type === "UserPromptSubmit", "type is UserPromptSubmit");
  assert(events[0].data.session_id === "abc-123", "session_id preserved");
  assert(events[0].data.prompt === "fix the bug", "prompt text extracted");
  assert(events[0]._ts === "2026-04-01T10:00:00Z", "timestamp preserved");
}

console.log("\nconvertSessionLine — user prompt with content array");
{
  const obj = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hello world" }] },
    sessionId: "abc-123",
    timestamp: "2026-04-01T10:00:00Z",
    cwd: "/home/user/project",
  };
  const events = convertSessionLine(obj);
  assert(events.length === 1, "produces 1 event");
  assert(events[0].data.prompt === "hello world", "text extracted from content array");
}

console.log("\nconvertSessionLine — tool result (user message)");
{
  const obj = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_123", content: "file contents here" },
        { type: "tool_result", tool_use_id: "toolu_456", content: "error!", is_error: true },
      ],
    },
    sessionId: "abc-123",
    timestamp: "2026-04-01T10:01:00Z",
    cwd: "/home/user/project",
  };
  const events = convertSessionLine(obj);
  assert(events.length === 2, "produces 2 events (one per tool_result)");
  assert(events[0]._logstream_type === "PostToolUse", "first is PostToolUse");
  assert(events[0].data.tool_use_id === "toolu_123", "tool_use_id preserved");
  assert(events[1]._logstream_type === "PostToolUseFailure", "second is PostToolUseFailure");
  assert(events[1].data.is_error === true, "is_error flag set");
}

console.log("\nconvertSessionLine — assistant with thinking + tool_use + text");
{
  const obj = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me think about this..." },
        { type: "tool_use", id: "toolu_789", name: "Read", input: { file_path: "/foo/bar.js" } },
        { type: "text", text: "I found the issue." },
      ],
    },
    sessionId: "abc-123",
    timestamp: "2026-04-01T10:02:00Z",
    cwd: "/home/user/project",
  };
  const events = convertSessionLine(obj);
  assert(events.length === 3, "produces 3 events");
  assert(events[0]._logstream_type === "thinking", "first is thinking");
  assert(events[0].data.thinking === "Let me think about this...", "thinking text preserved");
  assert(events[1]._logstream_type === "PreToolUse", "second is PreToolUse");
  assert(events[1].data.tool_name === "Read", "tool_name preserved");
  assert(events[1].data.tool_input.file_path === "/foo/bar.js", "tool_input preserved");
  assert(events[2]._logstream_type === "text", "third is text");
}

console.log("\nconvertSessionLine — skip non-message types");
{
  assert(convertSessionLine({ type: "permission-mode" }).length === 0, "permission-mode skipped");
  assert(convertSessionLine({ type: "file-history-snapshot" }).length === 0, "file-history-snapshot skipped");
  assert(convertSessionLine({ type: "queue-operation" }).length === 0, "queue-operation skipped");
  assert(convertSessionLine(null).length === 0, "null skipped");
  assert(convertSessionLine({}).length === 0, "empty object skipped");
}

console.log("\nconvertSessionFile — multiple lines");
{
  const content = [
    JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: "abc" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "hello" }, sessionId: "abc", timestamp: "2026-04-01T10:00:00Z", cwd: "/tmp" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, sessionId: "abc", timestamp: "2026-04-01T10:00:01Z", cwd: "/tmp" }),
  ].join("\n");
  const events = convertSessionFile(content);
  assert(events.length === 2, `produces 2 events from 3 lines (got ${events.length})`);
  assert(events[0].ts > 0, "timestamp is numeric");
}

// Summary
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) throw new Error(`${failed} test(s) failed`);
