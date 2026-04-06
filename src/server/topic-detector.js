#!/usr/bin/env node
"use strict";

// Topic Detector — on-demand topic classification using claude -p
// Called when user presses a key in TUI. Takes a list of user queries,
// classifies them into topics, and emits topic_shift events.

const { execFile } = require("child_process");
const fs = require("fs");

let cliAvailable = null; // null = unknown, true/false after check

function checkCli() {
  return new Promise((resolve) => {
    if (cliAvailable !== null) { resolve(cliAvailable); return; }
    execFile("claude", ["--version"], (err) => {
      cliAvailable = !err;
      resolve(cliAvailable);
    });
  });
}

/**
 * Classify an array of user queries into topics.
 * @param {string[]} queries - user query texts
 * @returns {Promise<{start: number, title: string}[]|null>} - topic boundaries or null on failure
 */
async function classify(queries) {
  if (!await checkCli()) return null;
  if (!queries || queries.length < 3) return null;

  const numbered = queries.map((q, i) => `${i + 1}. ${q.replace(/\n/g, " ").slice(0, 150)}`).join("\n");
  const prompt = `You are analyzing a coding assistant conversation to identify topic groups.

Here are ${queries.length} user messages (oldest first):
${numbered}

Group these messages into broad topics. A topic is a coherent unit of work — a feature, bug fix, investigation, or discussion. Rules:
- Each topic MUST contain at least 2-3 messages. Never create a single-message topic.
- Minor follow-ups ("yes", "do it", "looks good", short replies) belong to the preceding topic.
- Prefer fewer, broader topics. If in doubt, merge adjacent topics.
- Aim for 2-4 topics total, not one per message.

Identify where each topic starts (1-indexed message number) and give each a concise title (max 8 words).`;

  const schema = JSON.stringify({
    type: "object",
    properties: {
      topics: {
        type: "array",
        items: {
          type: "object",
          properties: {
            start: { type: "number", description: "1-indexed message number where this topic starts" },
            title: { type: "string", description: "concise topic title, max 8 words" }
          },
          required: ["start", "title"]
        }
      }
    },
    required: ["topics"]
  });

  return callClaude(prompt, schema);
}

const LOCK_FILE = require("path").join(process.env.HOME, ".claude", "logs", ".loupe-skip-hooks");

function callClaude(prompt, schema) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "json", "--json-schema", schema, "--model", "haiku", "--allowedTools", ""];

    // Create lock file to suppress hooks, remove when done
    try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch {}

    execFile("claude", args, { timeout: 30000, maxBuffer: 1024 * 100 }, (err, stdout) => {
      try { fs.unlinkSync(LOCK_FILE); } catch {}
      // Clean up the claude -p transcript file to prevent ghost sessions
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (parsed.session_id) {
          const claudeProjects = require("path").join(process.env.HOME, ".claude", "projects");
          const dirs = fs.readdirSync(claudeProjects);
          for (const dir of dirs) {
            const transcript = require("path").join(claudeProjects, dir, parsed.session_id + ".jsonl");
            if (fs.existsSync(transcript)) { fs.unlinkSync(transcript); break; }
          }
        }
      } catch {}
      if (err) {
        console.error("topic-detector: claude call failed:", err.message);
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const inner = parsed.structured_output || parsed.result || parsed;
        const result = typeof inner === "string" ? JSON.parse(inner) : inner;
        resolve(result?.topics || null);
      } catch (e) {
        console.error("topic-detector: failed to parse response:", e.message);
        resolve(null);
      }
    });
  });
}

/**
 * Run classification and write topic_shift events to the JSONL file.
 * @param {string} outputFile - path to loupe JSONL
 * @param {string} sessionId - session to classify
 * @param {{userQuery: string, ts: number}[]} queries - queries with timestamps
 * @returns {Promise<number>} - number of topics detected
 */
async function classifyAndEmit(outputFile, sessionId, queries) {
  const texts = queries.map(q => q.userQuery);
  const topics = await classify(texts);
  if (!topics || topics.length === 0) return { count: 0 };

  const lastQueryTs = queries[queries.length - 1].ts;

  // Clear previous topics for this session before writing new ones
  const clearEntry = {
    _logstream_type: "topic_clear",
    _ts: new Date().toISOString(),
    data: { session_id: sessionId, type: "topic_clear" },
  };
  try { fs.appendFileSync(outputFile, JSON.stringify(clearEntry) + "\n"); } catch {}

  for (const topic of topics) {
    const qi = Math.max(0, Math.min(topic.start - 1, queries.length - 1));
    const entry = {
      _logstream_type: "topic_shift",
      _ts: new Date(queries[qi].ts).toISOString(),
      data: {
        session_id: sessionId,
        type: "topic_shift",
        title: topic.title,
        query_index: topic.start,
        last_query_ts: lastQueryTs,
      },
    };
    try {
      fs.appendFileSync(outputFile, JSON.stringify(entry) + "\n");
    } catch (e) {
      console.error("topic-detector: failed to write event:", e.message);
    }
  }
  return { count: topics.length };
}

module.exports = { classify, classifyAndEmit, checkCli };
