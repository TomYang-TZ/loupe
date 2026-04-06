#!/usr/bin/env node
"use strict";

// Tests for LoupeGrouping agent sibling behavior.
// Run: node test/grouping.test.js

// Load the module (IIFE assigns to global in browser; we eval for Node)
const fs = require("fs");
const src = fs.readFileSync(require("path").resolve(__dirname, "../src/ui/app-grouping.js"), "utf8");
const mod = eval(src.replace(/^"use strict";\s*/, "") + "\nLoupeGrouping;");

function runTests() {

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }
}

function makeEntry(category, ts, extra) {
  return { category, ts, sessionId: "s1", ...extra };
}

function topItems() {
  const gs = mod.getGroupState("s1");
  return gs.currentQuery ? gs.currentQuery.items : [];
}

// ── Setup: seed a query boundary so entries have somewhere to go ──
function seedQuery() {
  mod.reset();
  mod.assignToGroup(makeEntry("user_query", 1000, { userQuery: "test" }));
}

// ── Test 1: 4 agents, alternating with/without tool children, all siblings ──
console.log("\nAgent grouping — 4 agents should always be flat siblings");

seedQuery();

// Agent A — with tool children
mod.assignToGroup(makeEntry("sub_agent", 2000));
mod.assignToGroup(makeEntry("pre_tool", 2100));       // tool child
mod.assignToGroup(makeEntry("post_tool", 2200));       // tool child
mod.assignToGroup(makeEntry("sub_agent_result", 2300));

// Agent B — without tool children (empty)
mod.assignToGroup(makeEntry("sub_agent", 3000));
mod.assignToGroup(makeEntry("sub_agent_result", 3100));

// Agent C — with tool children
mod.assignToGroup(makeEntry("sub_agent", 4000));
mod.assignToGroup(makeEntry("pre_tool", 4100));
mod.assignToGroup(makeEntry("sub_agent_result", 4200));

// Agent D — without tool children
mod.assignToGroup(makeEntry("sub_agent", 5000));
mod.assignToGroup(makeEntry("sub_agent_result", 5100));

const items = topItems();
const agents = items.filter(i => i.agentEntry);

assert(agents.length === 4, `4 top-level agents (got ${agents.length})`);
assert(items.length === 4, `no orphan items outside agents (got ${items.length} items)`);
assert(agents[0].children.length === 2, `Agent A has 2 tool children (got ${agents[0].children.length})`);
assert(agents[1].children.length === 0, `Agent B has 0 children (got ${agents[1].children.length})`);
assert(agents[2].children.length === 1, `Agent C has 1 tool child (got ${agents[2].children.length})`);
assert(agents[3].children.length === 0, `Agent D has 0 children (got ${agents[3].children.length})`);

// No nesting — no agent should have agent children
for (let i = 0; i < agents.length; i++) {
  const nested = agents[i].children.filter(c => c.agentEntry);
  assert(nested.length === 0, `Agent ${String.fromCharCode(65 + i)} has no nested agents`);
}

// All agents should have resultEntry set
for (let i = 0; i < agents.length; i++) {
  assert(agents[i].resultEntry != null, `Agent ${String.fromCharCode(65 + i)} has resultEntry`);
}

// ── Test 2: interleaved — agent starts before previous finishes ──
console.log("\nAgent grouping — interleaved spawn (A starts, B starts before A stops)");

seedQuery();

mod.assignToGroup(makeEntry("sub_agent", 2000));       // Agent A
mod.assignToGroup(makeEntry("pre_tool", 2100));         // A's tool
mod.assignToGroup(makeEntry("sub_agent", 3000));        // Agent B starts (A still running)
mod.assignToGroup(makeEntry("pre_tool", 3100));         // B's tool
mod.assignToGroup(makeEntry("sub_agent_result", 3200)); // A finishes (first unresolved)
mod.assignToGroup(makeEntry("sub_agent_result", 3300)); // B finishes

const items2 = topItems();
const agents2 = items2.filter(i => i.agentEntry);

assert(agents2.length === 2, `2 top-level agents (got ${agents2.length})`);
assert(agents2[0].resultEntry != null, "Agent A resolved");
assert(agents2[1].resultEntry != null, "Agent B resolved");
// A's tool child: only the one before B started
assert(agents2[0].children.length === 1, `Agent A has 1 tool child (got ${agents2[0].children.length})`);
// B's tool child
assert(agents2[1].children.length === 1, `Agent B has 1 tool child (got ${agents2[1].children.length})`);

// ── Test 3: tools between agents go to correct parent ──
console.log("\nAgent grouping — tools route to active agent, not previous");

seedQuery();

mod.assignToGroup(makeEntry("sub_agent", 2000));
mod.assignToGroup(makeEntry("pre_tool", 2100));
mod.assignToGroup(makeEntry("sub_agent_result", 2200));
// Tool after agent A finished, before agent B — should go to query level
mod.assignToGroup(makeEntry("thinking", 2500));
mod.assignToGroup(makeEntry("sub_agent", 3000));
mod.assignToGroup(makeEntry("pre_tool", 3100));
mod.assignToGroup(makeEntry("sub_agent_result", 3200));

const items3 = topItems();
const agents3 = items3.filter(i => i.agentEntry);
const nonAgents3 = items3.filter(i => !i.agentEntry);

assert(agents3.length === 2, `2 agents (got ${agents3.length})`);
assert(nonAgents3.length === 1, `1 thinking entry between agents at query level (got ${nonAgents3.length})`);

// ── Test 4: user_query breaks out of unfinished agent ──
console.log("\nAgent grouping — user_query creates new Q even with unfinished agent");

seedQuery();

mod.assignToGroup(makeEntry("sub_agent", 2000));
mod.assignToGroup(makeEntry("pre_tool", 2100));
// Agent never finishes — no sub_agent_result
// User sends a new prompt
mod.assignToGroup(makeEntry("user_query", 5000, { userQuery: "new question" }));
mod.assignToGroup(makeEntry("pre_tool", 5100));

const gs4 = mod.getGroupState("s1");
assert(gs4.tasks[0].queries.length === 2, `2 queries created (got ${gs4.tasks[0].queries.length})`);
assert(gs4.tasks[0].queries[1].userQuery === "new question", "second query has correct userQuery");
// The tool after the new query should NOT be inside the agent
assert(gs4.tasks[0].queries[1].items.length === 1, `new query has 1 tool item (got ${gs4.tasks[0].queries[1].items.length})`);

// ── Summary ──
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) throw new Error(`${failed} test(s) failed`);

} // end runTests

if (typeof test === "function") { test("grouping", runTests); } else { runTests(); }
