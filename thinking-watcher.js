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
    const chunk = fs.readFileSync(filePath, { encoding: "utf-8", start: pos });
    const newData = chunk.substring(pos === filePositions.get(filePath) ? 0 : chunk.indexOf("\n") + 1);
    filePositions.set(filePath, stat.size);

    const lines = newData.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "assistant" && obj.message?.content) {
          const sessionId = path.basename(filePath, ".jsonl");
          for (const block of obj.message.content) {
            if (block.type === "thinking" && block.thinking) {
              const entry = {
                _logstream_type: "thinking",
                _ts: new Date().toISOString(),
                data: {
                  session_id: sessionId,
                  type: "thinking",
                  thinking: block.thinking,
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
