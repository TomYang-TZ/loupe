#!/usr/bin/env node
"use strict";

// Tests for phase detection: tool-detail shared classifier + island-state transitions.
// Run: node test/phase.test.js

const { detectPhaseFromTool } = require("../src/shared/tool-detail");
const islandState = require("../src/server/island-state");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }
}

// ── detectPhaseFromTool ──

console.log("\ndetectPhaseFromTool — tool name → phase mapping");

assert(detectPhaseFromTool("Read", null, "idle") === "exploring", "Read → exploring");
assert(detectPhaseFromTool("Glob", null, "idle") === "exploring", "Glob → exploring");
assert(detectPhaseFromTool("Grep", null, "idle") === "exploring", "Grep → exploring");
assert(detectPhaseFromTool("LSP", null, "idle") === "exploring", "LSP → exploring");

assert(detectPhaseFromTool("Edit", null, "idle") === "implementing", "Edit → implementing");
assert(detectPhaseFromTool("Write", null, "idle") === "implementing", "Write → implementing");
assert(detectPhaseFromTool("NotebookEdit", null, "idle") === "implementing", "NotebookEdit → implementing");

assert(detectPhaseFromTool("Bash", "npm test", "idle") === "testing", "Bash npm test → testing");
assert(detectPhaseFromTool("Bash", "jest --watch", "idle") === "testing", "Bash jest → testing");
assert(detectPhaseFromTool("Bash", "pytest -v", "idle") === "testing", "Bash pytest → testing");
assert(detectPhaseFromTool("Bash", "cargo test", "idle") === "testing", "Bash cargo test → testing");
assert(detectPhaseFromTool("Bash", "ls -la", "idle") === "implementing", "Bash ls from idle → implementing");
assert(detectPhaseFromTool("Bash", "ls -la", "exploring") === null, "Bash ls from exploring → null (no change)");

assert(detectPhaseFromTool("Agent", null, "idle") === "orchestrating", "Agent → orchestrating");

assert(detectPhaseFromTool("EnterPlanMode", null, "idle") === "planning", "EnterPlanMode → planning");
assert(detectPhaseFromTool("TodoWrite", null, "idle") === "planning", "TodoWrite → planning");
assert(detectPhaseFromTool("TaskCreate", null, "idle") === "planning", "TaskCreate → planning");
assert(detectPhaseFromTool("TaskUpdate", null, "idle") === "planning", "TaskUpdate → planning");

assert(detectPhaseFromTool(null, null, "idle") === null, "null tool → null");
assert(detectPhaseFromTool("UnknownTool", null, "idle") === null, "unknown tool → null");

// ── Island State — phase transitions ──

console.log("\nIsland State — phase transitions via processEvent");

let lastState = null;
islandState.init((state) => { lastState = state; });

function event(type, data, sid = "test-session") {
  const json = { _logstream_type: type, data: { session_id: sid, ...data } };
  islandState.processEvent(json, Date.now());
  return islandState.getState();
}

// Start a session
let s = event("UserPromptSubmit", { prompt: "fix the bug" });
assert(s.phase === "starting", "user query → starting");

// Thinking
s = event("thinking", {});
assert(s.phase === "thinking", "thinking event → thinking phase");

// Read tool → exploring
s = event("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/foo/bar.js" } });
assert(s.phase === "exploring", "Read tool → exploring");

// Edit tool → implementing
s = event("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/foo/bar.js" } });
assert(s.phase === "implementing", "Edit tool → implementing");

// Test command → testing
s = event("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } });
assert(s.phase === "testing", "Bash npm test → testing");

// Agent tool → orchestrating
s = event("PreToolUse", { tool_name: "Agent", tool_input: { description: "research" } });
// Note: Agent is filtered out in island-state categorize, so it returns null
// Agent detection happens via SubagentStart instead

// EnterPlanMode → planning
s = event("PreToolUse", { tool_name: "EnterPlanMode", tool_input: {} });
assert(s.phase === "planning", "EnterPlanMode → planning");

// ExitPlanMode while planning → planningStrike
s = event("PreToolUse", { tool_name: "ExitPlanMode", tool_input: {} });
assert(s.planningStrike === true, "ExitPlanMode from planning → planningStrike");

// TodoWrite → planning
s = event("PreToolUse", { tool_name: "TodoWrite", tool_input: {} });
assert(s.phase === "planning", "TodoWrite → planning");

// TaskCreated → planning
s = event("TaskCreated", {});
assert(s.phase === "planning", "TaskCreated → planning");

// TaskCompleted while planning → planningStrike
s = event("TaskCompleted", {});
assert(s.planningStrike === true, "TaskCompleted from planning → planningStrike");

// Error via PostToolUseFailure → debugging
s = event("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/foo/bug.js" } });
s = event("PostToolUseFailure", { tool_name: "Edit" });
assert(s.phase === "debugging", "PostToolUseFailure → debugging");

// PostToolUse with is_error → debugging
s = event("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm run build" } });
s = event("PostToolUse", { tool_name: "Bash", is_error: true, error: "Exit code 1" });
assert(s.phase === "debugging", "PostToolUse is_error → debugging");

// Revisiting errored file → debugging
s = event("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/foo/bug.js" } });
assert(s.phase === "debugging", "revisiting errored file → debugging (overrides exploring)");

// Non-errored file → exploring (not debugging)
s = event("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/foo/clean.js" } });
assert(s.phase === "exploring", "reading clean file → exploring");

// SubagentStart (since Agent tool is filtered in categorize)
s = event("SubagentStart", { agent_id: "a1" });
// SubagentStart doesn't change phase directly, just tracks agent count

// ── Summary ──
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) throw new Error(`${failed} test(s) failed`);
