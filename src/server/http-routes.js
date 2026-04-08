// HTTP route handlers — extracted from index.js
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { condenseRawEntry } = require("./replay");

function fmtDurServer(ms) {
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

function serveStatic(filePath, res) {
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function createRouter(filePath, uiDir, wss, opts) {
  const { buildMessage, isReplayAnalysisLine, looksLikeJson } = opts;

  return function handleRequest(req, res) {
    const fullUrl = req.url;
    const url = fullUrl.split("?")[0];

    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, file: filePath, clients: wss.clients.size }));
      return;
    }

    if (url === "/stop") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, stopping: true }));
      const _fs = require("fs");
      const _home = require("os").homedir();
      const serverPid = path.join(_home, ".claude/logs/loupe.pid");
      const tuiPid = path.join(_home, ".claude/logs/loupe-tui.pid");
      setTimeout(() => {
        // Kill native app
        try { require("child_process").execSync('pkill -f "Loupe.app/Contents/MacOS/loupe"', { stdio: "ignore" }); } catch {}
        // Kill TUI by PID
        try {
          const pid = _fs.readFileSync(tuiPid, "utf8").trim();
          process.kill(parseInt(pid));
          _fs.unlinkSync(tuiPid);
        } catch {}
        // Clean up server PID and exit
        try { _fs.unlinkSync(serverPid); } catch {}
        process.exit(0);
      }, 200);
      return;
    }

    // Serve local images (only from .claude/image-cache)
    if (url === "/image" && fullUrl.includes("path=")) {
      const imgPath = decodeURIComponent(fullUrl.split("path=")[1]);
      const allowedPrefix = path.join(process.env.HOME, ".claude", "image-cache");
      const resolved = path.resolve(imgPath);
      if (!resolved.startsWith(allowedPrefix)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      const imgMime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[ext] || "application/octet-stream";
      try {
        const data = fs.readFileSync(resolved);
        res.writeHead(200, { "Content-Type": imgMime, "Cache-Control": "max-age=3600" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // API: return all PreToolUse entries with file paths (for gravity map)
    if (url === "/api/file-accesses") {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const results = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj._logstream_type !== "PreToolUse") continue;
            results.push(line);
          } catch {}
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(results));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Fetch full (untruncated) entry by timestamp
    if (url === "/api/full-entry" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { ts, category } = JSON.parse(body);
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          let best = null;
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              const lineTs = obj._ts ? new Date(obj._ts).getTime() : 0;
              // Match by timestamp (within 1s) and category
              if (Math.abs(lineTs - ts) < 1000) {
                const t = obj._logstream_type || "";
                const inner = obj.data || obj;
                const cat = t === "thinking" || obj.thinking ? "thinking" : t.toLowerCase();
                if (!category || cat === category || t === category) {
                  best = obj;
                }
              }
            } catch {}
          }
          if (best) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(best));
          } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: "Entry not found" }));
          }
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // API: Get condensed session timeline for replay popover
    if (url === "/api/session-timeline" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { sessionId } = JSON.parse(body);
          if (!sessionId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "sessionId required" }));
            return;
          }

          const claudeProjectsDir = path.join(process.env.HOME, ".claude", "projects");
          let rawSessionFile = null;
          try {
            for (const projDir of fs.readdirSync(claudeProjectsDir)) {
              const candidate = path.join(claudeProjectsDir, projDir, `${sessionId}.jsonl`);
              if (fs.existsSync(candidate)) { rawSessionFile = candidate; break; }
            }
          } catch {}

          if (!rawSessionFile) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session file not found", timeline: [] }));
            return;
          }

          const content = fs.readFileSync(rawSessionFile, "utf-8");
          const lines = content.split("\n").filter(l => l.trim());
          const timeline = [];
          let entryNum = 0;

          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              entryNum++;
              const type = obj.type;
              const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null;

              if (type === "user") {
                const c = obj.message?.content;
                let text = typeof c === "string" ? c :
                  Array.isArray(c) ? c.filter(b => typeof b === "string" || b.type === "text").map(b => typeof b === "string" ? b : b.text).join(" ") : "";
                text = text.replace(/\s*\[Image #\d+\]\s*/g, " ").trim();
                if (text) timeline.push({ n: entryNum, type: "user", text: text.slice(0, 200), ts });
              }

              if (type === "assistant" && obj.message?.content) {
                for (const block of obj.message.content) {
                  if (block.type === "thinking" && block.thinking) {
                    timeline.push({ n: entryNum, type: "think", text: block.thinking.slice(0, 120).replace(/\n/g, " "), ts });
                  } else if (block.type === "tool_use") {
                    const input = block.input || {};
                    let detail = input.file_path || input.command?.split("\n")[0]?.slice(0, 80) || input.pattern || input.description || "";
                    timeline.push({ n: entryNum, type: "tool", tool: block.name || "?", detail: detail.slice(0, 100), ts });
                  } else if (block.type === "text" && block.text) {
                    timeline.push({ n: entryNum, type: "text", text: block.text.slice(0, 120).replace(/\n/g, " "), ts });
                  }
                }
                const usage = obj.message?.usage;
                if (usage) {
                  timeline[timeline.length - 1].tokens = { in: usage.input_tokens, out: usage.output_tokens };
                }
              }

              if (type === "tool_result" || type === "tool_response") {
                const isError = obj.is_error;
                if (isError) {
                  const c = obj.content || obj.output || "";
                  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map(b => typeof b === "string" ? b : b.text || "").join(" ") : String(c);
                  timeline.push({ n: entryNum, type: "error", text: text.split("\n")[0].slice(0, 150), ts });
                }
              }
            } catch {}
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ timeline, totalEntries: entryNum }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // API: Classify session topics (for replay timeline, does NOT emit topic_shift events)
    if (url === "/api/session-topics" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { sessionId } = JSON.parse(body);
          if (!sessionId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "sessionId required" }));
            return;
          }

          // Read session timeline to extract queries + tool stats
          const claudeProjectsDir = path.join(process.env.HOME, ".claude", "projects");
          let rawSessionFile = null;
          try {
            for (const projDir of fs.readdirSync(claudeProjectsDir)) {
              const candidate = path.join(claudeProjectsDir, projDir, `${sessionId}.jsonl`);
              if (fs.existsSync(candidate)) { rawSessionFile = candidate; break; }
            }
          } catch {}

          if (!rawSessionFile) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ topics: [], error: "Session file not found" }));
            return;
          }

          const content = fs.readFileSync(rawSessionFile, "utf-8");
          const lines = content.split("\n").filter(l => l.trim());

          // Parse queries and tool events
          const queries = [];  // { text, ts }
          const toolEvents = []; // { tool, action, ts, queryIdx }
          let currentQueryIdx = -1;

          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null;

              if (obj.type === "user") {
                const c = obj.message?.content;
                let text = typeof c === "string" ? c :
                  Array.isArray(c) ? c.filter(b => typeof b === "string" || b.type === "text").map(b => typeof b === "string" ? b : b.text).join(" ") : "";
                text = text.replace(/<[^>]+>/g, "").replace(/\s*\[Image #\d+\]\s*/g, " ").trim();
                if (text && text.length >= 3 && !/^<(local-command|command-name|command-args|system-reminder)/.test(text)) {
                  currentQueryIdx = queries.length;
                  queries.push({ text: text.slice(0, 200), ts });
                }
              }

              if (obj.type === "assistant" && obj.message?.content) {
                for (const block of obj.message.content) {
                  if (block.type === "tool_use" && currentQueryIdx >= 0) {
                    const name = block.name || "?";
                    let action = "read";
                    if (name === "Edit" || name === "Write" || name === "NotebookEdit") action = "edit";
                    else if (name === "Bash" || name === "Agent") action = "exec";
                    toolEvents.push({ tool: name, action, ts, queryIdx: currentQueryIdx });
                  }
                }
              }
            } catch {}
          }

          if (queries.length < 2) {
            // Too few queries — return them as-is without classification
            const topics = queries.map((q, i) => ({
              title: q.text.slice(0, 50),
              start: i + 1,
              durMs: 0,
              durLabel: "<1s",
              edits: 0, reads: 0, execs: 0,
              mood: "quick",
            }));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ topics }));
            return;
          }

          // Classify via topic detector (Haiku, no side effects)
          const topicDetector = require("./topic-detector");
          const classified = await topicDetector.classify(queries.map(q => q.text));

          if (!classified || classified.length === 0) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ topics: [], error: "Classification failed" }));
            return;
          }

          // Enrich with tool stats per topic
          const enriched = [];
          for (let ti = 0; ti < classified.length; ti++) {
            const topic = classified[ti];
            const startIdx = Math.max(0, topic.start - 1);
            const endIdx = ti + 1 < classified.length ? Math.max(0, classified[ti + 1].start - 1) : queries.length;

            let edits = 0, reads = 0, execs = 0;
            for (const te of toolEvents) {
              if (te.queryIdx >= startIdx && te.queryIdx < endIdx) {
                if (te.action === "edit") edits++;
                else if (te.action === "read") reads++;
                else if (te.action === "exec") execs++;
              }
            }

            // Duration from first query ts to next topic start (or end of session)
            const startTs = queries[startIdx]?.ts || 0;
            const endTs = endIdx < queries.length ? (queries[endIdx]?.ts || 0) : (queries[queries.length - 1]?.ts || 0);
            const durMs = Math.max(0, endTs - startTs);

            // Mood
            const totalTools = edits + reads + execs;
            const hasErrors = toolEvents.some(te => te.queryIdx >= startIdx && te.queryIdx < endIdx && te.tool === "error");
            let mood = "smooth";
            if (durMs < 5000) mood = "quick";
            else if (hasErrors) mood = "rough";
            else if (totalTools > 15 || durMs > 600000) mood = "grindy";

            enriched.push({
              title: topic.title,
              start: topic.start,
              durMs,
              durLabel: fmtDurServer(durMs),
              edits, reads, execs,
              mood,
            });
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ topics: enriched }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // API: Replay analysis via Claude CLI
    if (url === "/api/replay-analysis" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { sessionId, behavioral } = JSON.parse(body);
          if (!sessionId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "sessionId required" }));
            return;
          }

          // Find the raw session transcript file
          const claudeProjectsDir = path.join(process.env.HOME, ".claude", "projects");
          let rawSessionFile = null;
          try {
            for (const projDir of fs.readdirSync(claudeProjectsDir)) {
              const candidate = path.join(claudeProjectsDir, projDir, `${sessionId}.jsonl`);
              if (fs.existsSync(candidate)) {
                rawSessionFile = candidate;
                break;
              }
            }
          } catch {}

          if (!rawSessionFile) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Raw session file not found for this session" }));
            return;
          }

          // Read the raw session transcript
          const content = fs.readFileSync(rawSessionFile, "utf-8");
          const lines = content.split("\n").filter(l => l.trim());

          // Condense each raw transcript entry
          const condensed = [];
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              const summary = condenseRawEntry(obj);
              if (summary) condensed.push(summary);
            } catch {}
          }

          if (condensed.length === 0) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No entries found in session transcript" }));
            return;
          }

          // Cap at 500 lines: keep first 100 + last 400
          let condensedLog;
          if (condensed.length > 500) {
            const head = condensed.slice(0, 100);
            const tail = condensed.slice(-400);
            condensedLog = [...head, `\n... (${condensed.length - 500} entries omitted) ...\n`, ...tail].join("\n");
          } else {
            condensedLog = condensed.join("\n");
          }

          // Build context from behavioral signatures + /insights facets
          let contextBlock = "";

          // Behavioral context from momentum.js (sent by browser)
          if (behavioral) {
            const b = behavioral;
            const phases = b.phaseDist || {};
            const phaseStr = Object.entries(phases).filter(([,v]) => v > 0).map(([k,v]) => `${k} ${Math.round(v * 100)}%`).join(", ");
            const peaks = b.patternPeaks || {};
            const peakStr = Object.entries(peaks).filter(([,v]) => v > 0.1).map(([k,v]) => `${k} ${v.toFixed(2)}`).join(", ");
            const risk = b.riskHistory || [];
            const riskStr = risk.length > 0 ? risk.slice(-5).map(r => r.toFixed(2)).join(" → ") : "n/a";
            contextBlock += `\n## Pre-computed Behavioral Analysis (from real-time tool-action pattern tracking)
- Archetype: ${b.archetype || "unknown"} (confidence: ${(b.archetypeConfidence || 0).toFixed(2)})
- Risk trajectory: ${riskStr} (trend: ${b.riskTrend || "neutral"})
- Phase distribution: ${phaseStr || "n/a"}
- Pattern peaks: ${peakStr || "none significant"}
- Unique files: ${b.fileDiversity || 0}, Error count: ${Math.round((b.errorRate || 0) * (b.totalSpans || 0))}, Action entropy: ${(b.actionEntropy || 0).toFixed(2)}
- Total spans: ${b.totalSpans || 0}, Duration: ${Math.round((b.totalDuration || 0) / 1000)}s\n`;
          }

          // /insights facets (cached on disk)
          const facetPath = path.join(process.env.HOME, ".claude", "usage-data", "facets", `${sessionId}.json`);
          try {
            if (fs.existsSync(facetPath)) {
              const facet = JSON.parse(fs.readFileSync(facetPath, "utf-8"));
              const frictions = facet.friction_counts || {};
              const frictionStr = Object.entries(frictions).filter(([,v]) => v > 0).map(([k,v]) => `${k.replace(/_/g, " ")} (${v})`).join(", ");
              contextBlock += `\n## Insights Facets (from Claude Code /insights — AI-extracted session summary)
- Goal: "${facet.underlying_goal || "unknown"}"
- Outcome: ${facet.outcome || "unknown"}
- Session type: ${facet.session_type || "unknown"}
- Helpfulness: ${facet.claude_helpfulness || "unknown"}
- Friction: ${frictionStr || "none"}
- Summary: ${facet.brief_summary || "n/a"}\n`;
            }
          } catch {}

          const contextInstructions = contextBlock ? `\nIMPORTANT: Use the pre-computed data above to ground your analysis. Cite the archetype, risk trajectory, and pattern peaks in your Session Profile and Anomalies sections. If /insights facets are provided, compare your findings against the stated goal and outcome.\n` : "";

          const prompt = `You are analyzing a Claude Code agent session transcript. Produce a structured analysis in the EXACT format below. Be specific — cite tool names, file names, and entry numbers. Be concise but insightful.
${contextBlock}${contextInstructions}

## Session Profile
- **Task**: [1-sentence: what was the agent trying to do?]
- **Outcome**: [succeeded / partially succeeded / failed / abandoned]
- **Duration**: [estimate from timestamps, e.g. "~8 minutes active across 47 entries"]
- **Behavioral Archetype**: [Pick ONE: focused-executor | explorer-debugger | loop-fighter | methodical-planner | rapid-iterater | deep-diver] — [1-sentence justification]

## Time Breakdown
Show approximate % of session time in each phase. Use a simple bar:
- Exploring: [██░░░░░░░░] ~20%
- Implementing: [████░░░░░░] ~40%
- Debugging: [██░░░░░░░░] ~20%
- Testing: [█░░░░░░░░░] ~10%
- Planning: [█░░░░░░░░░] ~10%

## Key Phases
Number the major phases chronologically. For each:
1. **[Phase name]** (entries ~N-M) — What happened, key decisions, outcome

## Anomalies & Warnings
Flag unusual behaviors the human operator should know about:
- Loops: Where did the agent get stuck? How long? What broke the loop?
- Wasted effort: Actions that contributed nothing to the outcome
- Missed shortcuts: Files or approaches that should have been tried earlier
- Error spirals: Cascading errors from a single root cause

## Recommendations for Next Time
Actionable advice for a human using this agent on similar tasks:
- [Specific recommendation 1]
- [Specific recommendation 2]
- [Specific recommendation 3]

## Prompting Advice
How should the user have prompted or interacted with the agent differently?
- **What worked**: Which parts of the user's instructions led to efficient work?
- **What to improve**: Were instructions too vague, too specific, missing context, or missing constraints?
- **Suggested prompt template**: Write a concrete prompt template the user could reuse for similar tasks. Use \`[brackets]\` for variable parts:
\`\`\`
[Your improved prompt template here — this should be a real, usable template]
\`\`\`

## Evaluation Criteria
Rate each dimension 1-5 and briefly justify. These help the user calibrate expectations:
| Criteria | Score | Notes |
|----------|-------|-------|
| Prompt clarity | /5 | Was the user's intent clear to the agent? |
| Approach directness | /5 | Did the agent take the shortest viable path? |
| Error recovery | /5 | How well did the agent recover from mistakes? |
| Tool efficiency | /5 | Were tool calls necessary and well-targeted? |
| Outcome quality | /5 | Did the final result meet the original goal? |

## Efficiency Score
**[N]/10** — [1-sentence justification]

---
SESSION LOG (${condensed.length} entries from raw transcript):
${condensedLog}`;

          const child = execFile("claude", ["--print", "--model", "sonnet"], {
              timeout: 120000,
              encoding: "utf-8",
              maxBuffer: 2 * 1024 * 1024,
            }, (err, stdout, stderr) => {
              if (err) {
                const msg = stderr ? stderr.slice(0, 200) : err.message;
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Claude CLI failed: ${msg}` }));
              } else {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ analysis: stdout }));
              }
            });
            child.stdin.write(prompt);
            child.stdin.end();
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // --- Claude Insights integration ---

    // Serve the pre-generated /insights HTML report
    if (url === "/api/insights/report") {
      const reportPath = path.join(process.env.HOME, ".claude", "usage-data", "report.html");
      if (fs.existsSync(reportPath)) {
        const content = fs.readFileSync(reportPath);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(content);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No insights report found. Run /insights in Claude Code first." }));
      }
      return;
    }

    // Run `claude /insights` to generate/refresh the report
    if (url === "/api/insights/run" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" });
      res.write(JSON.stringify({ status: "running" }) + "\n");

      const child = execFile("claude", ["-p", "/insights"], {
        timeout: 300000, // 5 min timeout — insights can be slow
        encoding: "utf-8",
        maxBuffer: 5 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) {
          res.end(JSON.stringify({ status: "error", error: stderr ? stderr.slice(0, 500) : err.message }));
        } else {
          const reportPath = path.join(process.env.HOME, ".claude", "usage-data", "report.html");
          const exists = fs.existsSync(reportPath);
          res.end(JSON.stringify({ status: "done", reportExists: exists }));
        }
      });
      return;
    }

    // Serve static UI files
    const file = url === "/" ? "index.html" : url.replace(/^\//, "");
    const safe = path.normalize(file).replace(/^(\.\.[\/\\])+/, "");
    const fullPath = path.join(uiDir, safe);

    if (fullPath.startsWith(uiDir)) {
      serveStatic(fullPath, res);
    } else {
      res.writeHead(403);
      res.end("Forbidden");
    }
  };
}

module.exports = { createRouter };
