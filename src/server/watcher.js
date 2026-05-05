#!/usr/bin/env node

// Watches Claude Code transcript files for thinking blocks
// and appends them to the logstream log file.
//
// Usage: node thinking-watcher.js <logstream-output-file>
//
// Watches ~/.claude/projects/*/session.jsonl files for new entries
// with type "assistant" containing thinking content blocks.

const fs = require("fs");
const path = require("path");

const outputFile = process.argv[2];
if (!outputFile) {
  console.error("Usage: thinking-watcher.js <output-logstream-file>");
  process.exit(1);
}

// Single-instance guard: write PID file, exit if another watcher is running
const pidFile = path.join(path.dirname(outputFile), "loupe-thinker.pid");
try {
  if (fs.existsSync(pidFile)) {
    const existingPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    try {
      process.kill(existingPid, 0); // Check if process exists
      console.error(`thinking-watcher: already running (PID ${existingPid}), exiting`);
      process.exit(0);
    } catch {
      // Process doesn't exist, stale PID file — continue
    }
  }
  fs.writeFileSync(pidFile, String(process.pid));
} catch {}

process.on("exit", () => {
  try { fs.unlinkSync(pidFile); } catch {}
});

const claudeDir = path.join(process.env.HOME, ".claude", "projects");

// Track file positions
const filePositions = new Map();

function findTranscriptFiles() {
  const files = [];
  try {
    for (const projDir of fs.readdirSync(claudeDir)) {
      const projPath = path.join(claudeDir, projDir);
      if (!fs.statSync(projPath).isDirectory()) continue;
      for (const f of fs.readdirSync(projPath)) {
        if (f.endsWith(".jsonl")) {
          files.push(path.join(projPath, f));
        }
      }
    }
  } catch {}
  return files;
}

function extractUserMessage(text) {
  // Extract user's message from rejection boilerplate
  // "...the user said:\nactual message" → "actual message"
  const match = text.match(/the user said:\s*\n?(.*)/s);
  if (match && match[1].trim()) return match[1].trim();
  // Fallback: strip known boilerplate
  return text
    .replace(/\[Request interrupted by user for tool use\]\s*/g, "")
    .replace(/The user doesn't want to proceed.*?the user said:\s*/s, "")
    .replace(/STOP what you are doing.*$/s, "")
    .trim() || null;
}

const LOCK_FILE = path.join(process.env.HOME, ".claude", "logs", ".loupe-skip-hooks");

function processFile(filePath) {
  // Skip processing while topic detection is running (lock file present)
  try { if (fs.existsSync(LOCK_FILE)) { return; } } catch {}

  let pos = filePositions.get(filePath) || 0;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }

  if (stat.size < pos) {
    // File was truncated/compacted — reset position to read from the tail
    pos = Math.max(0, stat.size - 50000);
    filePositions.set(filePath, pos);
  }
  if (stat.size <= pos) return;
  if (pos === 0 && stat.size > 50000) {
    // For large existing files, only read the last 50KB on first encounter
    pos = Math.max(0, stat.size - 50000);
  }

  try {
    // Read only the new bytes using a file descriptor with position
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(stat.size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    const newData = buf.toString("utf-8");
    filePositions.set(filePath, stat.size);

    const lines = newData.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        // Detect tool rejection — user denied permission
        if (obj.type === "user" && !obj.isMeta) {
          const content = obj.message?.content;
          // Extract text from all block types (text blocks, tool_result content, raw strings)
          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            for (const b of content) {
              if (typeof b === "string") text += " " + b;
              else if (b.type === "text") text += " " + (b.text || "");
              else if (b.type === "tool_result") text += " " + (typeof b.content === "string" ? b.content : "");
            }
          }
          text = text.trim();
          if (text.includes("[Request interrupted by user for tool use]") || text.includes("The tool use was rejected")) {
            const sessionId = path.basename(filePath, ".jsonl");
            const entry = {
              _logstream_type: "tool_rejected",
              _ts: new Date().toISOString(),
              data: {
                session_id: sessionId,
                type: "tool_rejected",
                message: extractUserMessage(text),
              },
            };
            fs.appendFileSync(outputFile, JSON.stringify(entry) + "\n");
          } else if (Array.isArray(content)) {
            // Detect approval with message: tool_result (not error) + text block
            const hasToolResult = content.some(b => b.type === "tool_result" && !b.is_error);
            const textBlocks = content.filter(b => b.type === "text" && b.text?.trim());
            if (hasToolResult && textBlocks.length > 0) {
              const approvalMsg = textBlocks.map(b => b.text.trim()).join(" ");
              if (approvalMsg) {
                const sessionId = path.basename(filePath, ".jsonl");
                const entry = {
                  _logstream_type: "tool_approved_with_message",
                  _ts: new Date().toISOString(),
                  data: {
                    session_id: sessionId,
                    type: "tool_approved_with_message",
                    message: approvalMsg,
                  },
                };
                fs.appendFileSync(outputFile, JSON.stringify(entry) + "\n");
              }
            }
          }
        }
        // Thinking block extraction
        if (obj.type === "assistant" && obj.message?.content) {
          const sessionId = path.basename(filePath, ".jsonl");
          const userQuery = null;
          const userImages = null;
          const usage = obj.message?.usage || {};
          const meta = {
            model: obj.message?.model || null,
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read: usage.cache_read_input_tokens || 0,
            cache_create: usage.cache_creation_input_tokens || 0,
            cwd: obj.cwd || null,
            git_branch: obj.gitBranch || null,
            version: obj.version || null,
          };
          for (const block of obj.message.content) {
            if (block.type === "thinking" && block.thinking) {
              const entry = {
                _logstream_type: "thinking",
                _ts: new Date().toISOString(),
                data: {
                  session_id: sessionId,
                  type: "thinking",
                  thinking: block.thinking,
                  user_query: userQuery,
                  user_images: userImages,
                  meta,
                },
              };
              fs.appendFileSync(outputFile, JSON.stringify(entry) + "\n");
            }
          }
        }
      } catch {}
    }
  } catch {}
}

// Initial scan — set positions to current file sizes (don't replay old content)
function initPositions() {
  for (const f of findTranscriptFiles()) {
    try {
      filePositions.set(f, fs.statSync(f).size);
    } catch {}
  }
}

// Watch for changes
function watchProjects() {
  try {
    // Watch the top-level projects dir for new project directories
    fs.watch(claudeDir, { recursive: true }, (eventType, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return;

      // Reconstruct full path
      const fullPath = path.join(claudeDir, filename);
      if (fs.existsSync(fullPath)) {
        processFile(fullPath);
      }
    });
  } catch (err) {
    console.error("Watch error:", err.message);
  }
}

// Also poll as fallback
function poll() {
  for (const f of findTranscriptFiles()) {
    processFile(f);
  }
}

console.log(`thinking-watcher: monitoring ${claudeDir}`);
console.log(`thinking-watcher: writing to ${outputFile}`);

initPositions();
watchProjects();
setInterval(poll, 1000);

process.on("SIGINT", () => process.exit(0));
