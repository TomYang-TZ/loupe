"use strict";

// Tool action classification — maps Claude tool names to action categories.

const TOOL_ACTIONS = {
  Read: "read", Grep: "read", Glob: "read",
  Edit: "edit", Write: "edit",
  Bash: "exec",
};

// Bash subcommand → action category for finer-grained classification.
const BASH_CMD_CATEGORY = {
  cat: "read", head: "read", tail: "read", less: "read", more: "read",
  ls: "read", stat: "read", file: "read", wc: "read",
  sed: "edit", awk: "edit", tee: "edit", chmod: "edit", chown: "edit",
  chgrp: "edit", touch: "edit", mv: "edit", cp: "edit",
  rm: "exec", mkdir: "exec", rmdir: "exec",
  node: "exec", python: "exec", python3: "exec", npm: "exec", npx: "exec",
  make: "exec", cargo: "exec", go: "exec", git: "exec", docker: "exec",
  curl: "exec", wget: "exec",
};

// Extract the leading command name from a bash command string,
// stripping sudo, env vars, etc.
function extractBashSubcommand(cmd) {
  if (!cmd) return null;
  const m = cmd.match(/^(?:sudo\s+|env\s+\S+=\S+\s+)*(\w[\w.+-]*)/);
  return m ? m[1] : null;
}

module.exports = { TOOL_ACTIONS, BASH_CMD_CATEGORY, extractBashSubcommand };
