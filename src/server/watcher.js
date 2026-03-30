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

// Track file positions, last user query, and images per file
const filePositions = new Map();
const lastUserQuery = new Map();
const lastUserImages = new Map();

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

function processFile(filePath) {
  let pos = filePositions.get(filePath) || 0;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
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
        // Track the latest user message per file
        if (obj.type === "user" && obj.isMeta) {
          // isMeta messages carry image file paths
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const text = typeof block === "string" ? block : block.text || "";
              const match = text.match(/\[Image: source: ([^\]]+)\]/);
              if (match) {
                const images = lastUserImages.get(filePath) || [];
                images.push(match[1]);
                lastUserImages.set(filePath, images);
              }
            }
          }
        }
        if (obj.type === "user" && !obj.isMeta) {
          // Reset images for new user message
          lastUserImages.set(filePath, []);
          const content = obj.message?.content;
          let text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter(b => typeof b === "string" || b.type === "text").map(b => typeof b === "string" ? b : b.text).join(" ")
              : "";
          // Strip [Image #N] references from the text
          text = text.replace(/\s*\[Image #\d+\]\s*/g, " ").trim();
          if (text) lastUserQuery.set(filePath, text);
        }
        if (obj.type === "assistant" && obj.message?.content) {
          const sessionId = path.basename(filePath, ".jsonl");
          const userQuery = lastUserQuery.get(filePath) || null;
          const userImages = (lastUserImages.get(filePath) || []).length > 0 ? lastUserImages.get(filePath) : null;
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
