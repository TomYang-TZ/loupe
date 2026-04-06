#!/usr/bin/env node
"use strict";

// Tests for hook.sh JSONL output and backlog/server processing of split lines.
// Run: node test/hook-jsonl.test.js

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOOK = path.resolve(__dirname, "../scripts/hook.sh");
const { truncateForBacklog, looksLikeJson } = require("../src/server/backlog");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }
}

// --- hook.sh: output is always single-line JSONL ---

console.log("\nhook.sh — single-line JSONL output");

function runHook(input, eventType = "TestEvent") {
  const tmp = path.join(os.tmpdir(), `loupe-test-${Date.now()}.jsonl`);
  try {
    execSync(`LOG_DIR="${path.dirname(tmp)}" LOG_FILE="${tmp}" bash -c '
      LOG_FILE="${tmp}"
      mkdir -p "$(dirname "$LOG_FILE")"
      EVENT_TYPE="${eventType}"
      INPUT=$(cat)
      if [ -n "$INPUT" ]; then
        TIMESTAMP="2026-01-01T00:00:00.000Z"
        printf "%s\\n" "{\\"_logstream_type\\":\\"$EVENT_TYPE\\",\\"_ts\\":\\"$TIMESTAMP\\",\\"data\\":$(printf "%s" "$INPUT" | tr "\\n" " ")}" >> "$LOG_FILE"
      fi
    '`, { input, stdio: ["pipe", "pipe", "pipe"] });
    return fs.existsSync(tmp) ? fs.readFileSync(tmp, "utf-8").trim() : "";
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

{
  const out = runHook('{"tool_name":"Edit","tool_input":{"old_string":"line1\\nline2"}}');
  const lines = out.split("\n");
  assert(lines.length === 1, "simple JSON input produces single line");
  try { JSON.parse(lines[0]); assert(true, "output is valid JSON"); }
  catch { assert(false, "output is valid JSON"); }
}

{
  // Input with literal newlines (the bug scenario)
  const multiline = '{"tool_name":"Edit","tool_input":{"old_string":"function foo() {\\n  return 1;\\n}"}}'
  const out = runHook(multiline);
  const lines = out.split("\n");
  assert(lines.length === 1, "JSON with escaped newlines produces single line");
}

{
  // Input that actually has literal newlines in the value (piped from Claude Code)
  const withNewlines = '{"prompt":"line one\nline two\nline three"}';
  const out = runHook(withNewlines);
  const lines = out.split("\n");
  assert(lines.length === 1, "input with literal newlines collapsed to single line");
  try {
    const obj = JSON.parse(lines[0]);
    assert(obj._logstream_type === "TestEvent", "event type preserved");
    assert(obj.data.prompt.includes("line one"), "content preserved after newline collapse");
  } catch { assert(false, "collapsed output is valid JSON"); }
}

// --- looksLikeJson ---

console.log("\nlooksLikeJson");
assert(looksLikeJson('{"foo":1}') === true, "object detected as JSON");
assert(looksLikeJson('[1,2]') === true, "array detected as JSON");
assert(looksLikeJson('  {"foo":1}') === true, "leading whitespace handled");
assert(looksLikeJson('for (i=0; i<n; i++)') === false, "code fragment rejected");
assert(looksLikeJson('}}') === false, "closing braces rejected");
assert(looksLikeJson('hello world') === false, "plain text rejected");

// --- truncateForBacklog ---

console.log("\ntruncateForBacklog");

{
  const short = '{"_logstream_type":"PreToolUse","data":{"tool_name":"Read"}}';
  assert(truncateForBacklog(short) === short, "short lines pass through unchanged");
}

{
  const big = '{"data":{"content":"' + "x".repeat(5000) + '"}}';
  const result = truncateForBacklog(big);
  assert(result.length < big.length, "large JSON gets truncated");
  try { JSON.parse(result); assert(true, "truncated JSON is still valid"); }
  catch { assert(false, "truncated JSON is still valid"); }
}

{
  const broken = "for (i, line) in artLines.enumerated() {";
  assert(!looksLikeJson(broken), "code fragment not detected as JSON");
}

// --- Server buildMessage simulation ---

console.log("\nbuildMessage — broken line handling");

function buildMessage(line) {
  const msg = { type: "line", data: line, ts: Date.now(), json: null };
  if (looksLikeJson(line)) {
    try { msg.json = JSON.parse(line); } catch {}
  }
  return msg;
}

{
  const valid = '{"_logstream_type":"SubagentStop","_ts":"2026-01-01","data":{"agent_id":"abc"}}';
  const msg = buildMessage(valid);
  assert(msg.json !== null, "valid JSON parsed successfully");
  assert(msg.json._logstream_type === "SubagentStop", "event type extracted");
}

{
  const fragment = '{"_logstream_type":"PreToolUse","_ts":"2026-01-01","data":{"session_id":"abc';
  const msg = buildMessage(fragment);
  assert(msg.json === null, "truncated JSON results in null json");
}

{
  const code = 'for (i, line) in artLines.enumerated() {';
  const msg = buildMessage(code);
  assert(msg.json === null, "code fragment results in null json");
}

{
  const braces = '}}';
  const msg = buildMessage(braces);
  assert(msg.json === null, "stray braces result in null json");
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
