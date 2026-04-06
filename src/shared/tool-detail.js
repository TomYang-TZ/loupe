"use strict";

// Extract a human-readable detail string and file path from tool input.
// Used by island-state, TUI, and window UI for tool display.
function extractToolDetail(input) {
  if (!input) return { detail: "", filePath: null };
  let detail = "";
  let filePath = null;
  if (input.file_path) {
    const parts = input.file_path.split("/");
    detail = parts.slice(-2).join("/");
    filePath = input.file_path;
  } else if (input.command) {
    detail = input.command.split("\n")[0].slice(0, 80);
  } else if (input.pattern) {
    detail = input.pattern;
  } else if (input.description) {
    detail = input.description.slice(0, 60);
  }
  return { detail, filePath };
}

// Detect workflow phase from tool name and command.
// Returns new phase string or null if no change detected.
function detectPhaseFromTool(toolName, command, currentPhase) {
  if (!toolName) return null;
  if (["Read", "Glob", "Grep", "LSP"].some(t => toolName.includes(t))) return "exploring";
  if (["Edit", "Write", "NotebookEdit"].some(t => toolName.includes(t))) return "implementing";
  if (toolName.includes("Bash")) {
    const cmd = command || "";
    if (/test|jest|pytest|cargo test|npm test/.test(cmd)) return "testing";
    if (currentPhase === "idle" || currentPhase === "starting") return "implementing";
    return null;
  }
  if (toolName.includes("Agent")) return "planning";
  return null;
}

module.exports = { extractToolDetail, detectPhaseFromTool };
