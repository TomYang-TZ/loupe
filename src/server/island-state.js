// Island State Machine — server-side module
// Processes events and produces island display state
// Consumers: native island (Swift WebSocket), webview (app.js), TUI

const { SESSION_COLORS, extractSessionId: _extractSessionId, extractUserQuery: _extractUserQuery, extractSessionLabel: _extractSessionLabel } = require("../shared/session-extract");
const { extractToolDetail, detectPhaseFromTool } = require("../shared/tool-detail");

const sessions = new Map(); // sessionId → { label, color }
const islandSessions = new Map(); // sessionId → per-session state
let colorIdx = 0;
let onUpdate = null; // callback: (state) => void
let pinnedSessionId = null; // when set, getState() returns this session's data

function init(callback) {
  onUpdate = callback;
}

function getSession(sid) {
  if (!islandSessions.has(sid)) {
    islandSessions.set(sid, {
      id: sid, label: "", phase: "idle", progress: null,
      tool: null, toolDetail: null, thinking: false,
      waiting: false, waitingTool: null, approved: null,
      idleSince: null, userQuery: null, recentTools: [],
      errors: 0, tokens: 0, files: 0, activeFile: null,
      startTs: null, denied: null, rejected: null, denials: 0,
      agentsRunning: 0, agentsTotal: 0, apiError: null,
      pulsing: false, _lastActivityTs: 0,
      _fileSet: new Set(), _totalTokens: 0, _tokIn: 0, _tokOut: 0, _tokCacheRead: 0, _tokCacheCreate: 0,
      _pendingToolName: null, _pendingToolTs: null,
      _pulseTimer: null, _idleTimer: null, _startingTimer: null,
      _stopFailureTs: null, _agentClearTimer: null, _color: null,
      _erroredFiles: new Set(), planningStrike: false, _planningStrikeTimer: null,
    });
  }
  return islandSessions.get(sid);
}

function extractSessionLabel(json) { return _extractSessionLabel(json); }
function extractSessionId(json) { return _extractSessionId(json); }
function extractUserQuery(json) { return _extractUserQuery(json); }

function categorize(json) {
  if (!json) return null;
  const type = json._logstream_type;
  const data = json.data || {};
  if (type === "PreToolUse") {
    if (data.tool_name === "Agent") return null;
    return "pre_tool";
  }
  if (type === "PostToolUse") {
    if (data.tool_name === "Agent") return null;
    if (data.is_error) return "tool_error";
    return "post_tool";
  }
  if (type === "thinking") return "thinking";
  if (type === "UserPromptSubmit") return "user_query";
  if (type === "user_query") return "user_query";
  if (type === "SubagentStart") return "sub_agent";
  if (type === "SubagentStop") return "sub_agent_result";
  if (type === "PostToolUseFailure") return "tool_failure";
  if (type === "StopFailure") return "stop_failure";
  if (type === "SessionStart") return "session_start";
  if (type === "SessionEnd") return "session_end";
  if (type === "PermissionRequest") return "permission_request";
  if (type === "PermissionDenied") return "permission_denied";
  if (type === "Notification") return "Notification";
  if (type === "Stop") return "Stop";
  if (type === "tool_rejected") return "tool_rejected";
  if (type === "TaskCreated") return "task_created";
  if (type === "TaskCompleted") return "task_completed";
  return null;
}

function processEvent(json, ts) {
  const cat = categorize(json);
  if (!cat) return;

  const sid = extractSessionId(json);
  if (!sid) return;

  const s = getSession(sid);
  if (!s.startTs) s.startTs = ts;
  s._lastActivityTs = ts;

  // Session label + color
  const label = extractSessionLabel(json);
  if (label && !sessions.has(sid)) {
    sessions.set(sid, { label, color: SESSION_COLORS[colorIdx++ % SESSION_COLORS.length] });
  }
  const sInfo = sessions.get(sid);
  if (sInfo) { s.label = sInfo.label; s._color = sInfo.color || null; }

  const data = json.data || {};
  const userQuery = extractUserQuery(json);

  // User query — new turn
  if (cat === "user_query" && userQuery) {
    s.userQuery = userQuery.slice(0, 120);
    s.phase = "starting";
    s.pulsing = false;
    if (s._pulseTimer) { clearTimeout(s._pulseTimer); s._pulseTimer = null; }
    s.idleSince = null;
    if (s._idleTimer) { clearTimeout(s._idleTimer); s._idleTimer = null; }
    s.denials = 0;
    // Auto-advance from "starting" to "thinking" if no event arrives within 3s
    if (s._startingTimer) clearTimeout(s._startingTimer);
    s._startingTimer = setTimeout(() => {
      if (s.phase === "starting") { s.phase = "thinking"; emit(); }
    }, 3000);
  }

  // Thinking
  if (cat === "thinking") {
    s.thinking = true;
    s.phase = "thinking";
    if (s._startingTimer) { clearTimeout(s._startingTimer); s._startingTimer = null; }
    if (userQuery && !s.userQuery) s.userQuery = userQuery.slice(0, 120);
  }

  // Tool usage
  if (cat === "pre_tool") {
    s.thinking = false;
    if (s._startingTimer) { clearTimeout(s._startingTimer); s._startingTimer = null; }
    const toolName = data.tool_name || "";
    const input = data.tool_input || {};
    s.tool = toolName;

    const { detail, filePath } = extractToolDetail(input);
    if (filePath) {
      s.activeFile = filePath;
      s._fileSet.add(filePath);
    }
    s.toolDetail = detail;
    s.files = s._fileSet.size;
    s.recentTools.push({ name: toolName, detail, ts });
    if (s.recentTools.length > 5) s.recentTools.shift();

    // Strikethrough when exiting plan mode
    if (toolName.includes("ExitPlanMode") && s.phase === "planning") {
      s.planningStrike = true;
      if (s._planningStrikeTimer) clearTimeout(s._planningStrikeTimer);
      s._planningStrikeTimer = setTimeout(() => { s.planningStrike = false; emit(); }, 1500);
    }

    const newPhase = detectPhaseFromTool(toolName, input.command, s.phase);
    if (newPhase) s.phase = newPhase;

    // Override to debugging if touching a previously-errored file
    if (s._erroredFiles.size > 0 && filePath && s._erroredFiles.has(filePath)) {
      s.phase = "debugging";
    }
  }

  // Approval — any activity after waiting means approved
  if (cat === "pre_tool" || cat === "post_tool" || cat === "sub_agent_result" || cat === "thinking") {
    if (s.waiting || s.phase === "waiting for input") {
      s.approved = s.waitingTool || s._pendingToolName || s.tool;
      s.waiting = false;
      s.pulsing = false;
      s.waitingTool = null;
      if (s._pulseTimer) { clearTimeout(s._pulseTimer); s._pulseTimer = null; }
      if (cat !== "thinking") s.phase = s.tool ? "implementing" : "exploring";
      else s.phase = "thinking";
      emit();
      setTimeout(() => { s.approved = null; emit(); }, 1500);
    }
  }
  if (cat === "pre_tool") { s._pendingToolName = s.tool; s._pendingToolTs = Date.now(); }
  if (cat === "post_tool" || cat === "sub_agent_result") { s._pendingToolName = null; s._pendingToolTs = null; }

  // Rejection
  if ((cat === "user_query" || cat === "thinking" || cat === "tool_rejected") && s.waiting) {
    s.rejected = s.waitingTool || "tool";
    s.waiting = false; s.pulsing = false; s.waitingTool = null;
    if (s._pulseTimer) { clearTimeout(s._pulseTimer); s._pulseTimer = null; }
    s.phase = "thinking";
    setTimeout(() => { s.rejected = null; emit(); }, 1500);
  }

  // Errors — track errored files and switch to debugging
  if (cat === "error" || cat === "tool_failure" || cat === "tool_error") {
    s.errors++;
    s.progress = "stuck";
    s.phase = "debugging";
    if (s.activeFile) s._erroredFiles.add(s.activeFile);
  }
  if ((cat === "post_tool") && s.progress === "stuck") s.progress = null;

  // Tasks — planning phase
  if (cat === "task_created") s.phase = "planning";
  if (cat === "task_completed" && s.phase === "planning") {
    s.planningStrike = true;
    if (s._planningStrikeTimer) clearTimeout(s._planningStrikeTimer);
    s._planningStrikeTimer = setTimeout(() => { s.planningStrike = false; emit(); }, 1500);
  }

  // Tokens — watcher emits token data under data.meta, not data.message.usage
  const usage = data?.meta || data?.message?.usage;
  if (usage) {
    const inT = usage.input_tokens || 0;
    const outT = usage.output_tokens || 0;
    const cacheR = usage.cache_read || usage.cache_read_input_tokens || 0;
    s._totalTokens += inT + outT;
    const cacheC = usage.cache_create || usage.cache_creation_input_tokens || 0;
    s._tokIn += inT; s._tokOut += outT; s._tokCacheRead += cacheR; s._tokCacheCreate += cacheC;
    s.tokens = s._totalTokens;
  }

  // Notification
  if (cat === "Notification") {
    s.phase = "waiting for input"; s.thinking = false;
    if (!s.waiting) {
      s.waitingTool = null; s.pulsing = true;
      if (s._pulseTimer) clearTimeout(s._pulseTimer);
      s._pulseTimer = setTimeout(() => { s.pulsing = false; emit(); }, 10000);
    }
    if (s._idleTimer) clearTimeout(s._idleTimer);
  }

  // PermissionRequest
  if (cat === "permission_request") {
    s.waiting = true; s.pulsing = true;
    s.waitingTool = data.tool_name || "tool";
    s.phase = "waiting for input"; s.thinking = false;
    if (s._idleTimer) clearTimeout(s._idleTimer);
    if (s._pulseTimer) clearTimeout(s._pulseTimer);
    s._pulseTimer = setTimeout(() => { s.pulsing = false; emit(); }, 10000);
  }

  // PermissionDenied
  if (cat === "permission_denied") {
    s.denied = data.tool_name || "tool"; s.denials++;
    if (s.denials >= 3) s.progress = "stuck";
    emit();
    setTimeout(() => { s.denied = null; emit(); }, 2000);
  }

  // Subagents
  if (cat === "sub_agent") {
    s.phase = "orchestrating";
    s.agentsRunning++; s.agentsTotal++;
    s.toolDetail = s.agentsRunning + " agent" + (s.agentsRunning > 1 ? "s" : "");
    if (s._agentClearTimer) { clearTimeout(s._agentClearTimer); s._agentClearTimer = null; }
  }
  if (cat === "sub_agent_result") {
    s.agentsRunning = Math.max(0, s.agentsRunning - 1);
    if (s.agentsRunning > 0) {
      s.toolDetail = (s.agentsTotal - s.agentsRunning) + "/" + s.agentsTotal + " agents";
    } else {
      s.toolDetail = s.agentsTotal + "/" + s.agentsTotal + " agents";
      s._agentClearTimer = setTimeout(() => {
        s.agentsRunning = 0; s.agentsTotal = 0; s.toolDetail = null; emit();
      }, 3000);
    }
  }

  // Tool failure
  if (cat === "tool_failure") { s.errors++; s.progress = "stuck"; }

  // Stop failure
  if (cat === "stop_failure") {
    s.progress = "stuck"; s._stopFailureTs = Date.now();
    s.phase = "idle"; s.thinking = false; s.tool = null; s.toolDetail = null;
  }

  // Stop — done
  if (cat === "Stop" && !(s._stopFailureTs && (Date.now() - s._stopFailureTs < 500))) {
    s.phase = "done"; s.thinking = false; s.tool = null; s.toolDetail = null;
    // Clean up any orphaned running agents
    if (s.agentsRunning > 0) { s.agentsRunning = 0; s.toolDetail = null; }
    if (s._agentClearTimer) { clearTimeout(s._agentClearTimer); s._agentClearTimer = null; }
    s.pulsing = true;
    if (s._pulseTimer) clearTimeout(s._pulseTimer);
    s._pulseTimer = setTimeout(() => { s.pulsing = false; emit(); }, 5000);
    if (s._idleTimer) clearTimeout(s._idleTimer);
    s._idleTimer = setTimeout(() => { s.phase = "idle"; s.idleSince = Date.now(); emit(); }, 10000);
  }

  // Fallback idle timer
  if (cat !== "Notification" && cat !== "Stop" && cat !== "stop_failure") {
    s.idleSince = null;
    if (s._idleTimer) clearTimeout(s._idleTimer);
    s._idleTimer = setTimeout(() => {
      s.phase = "idle"; s.tool = null; s.toolDetail = null;
      s.thinking = false; s.idleSince = Date.now(); emit();
    }, 30000);
  }

  // Prune stale sessions
  const now = Date.now();
  for (const [id, ss] of islandSessions) {
    const lastEvent = ss._lastActivityTs || ss.startTs || 0;
    if (now - lastEvent > 5 * 60 * 1000) {
      if (ss._idleTimer) clearTimeout(ss._idleTimer);
      if (ss._pulseTimer) clearTimeout(ss._pulseTimer);
      if (ss._startingTimer) clearTimeout(ss._startingTimer);
      if (ss._agentClearTimer) clearTimeout(ss._agentClearTimer);
      islandSessions.delete(id);
    }
  }

  emit();
}

// Called after backlog replay to normalize transient states
function normalizeAfterBacklog() {
  for (const [, ss] of islandSessions) {
    ss.waiting = false; ss.pulsing = false;
    ss.waitingTool = null; ss.rejected = null;
    ss.approved = null; ss.denied = null;
    if (ss.phase === "starting") ss.phase = "idle";
    if (ss.phase === "done") ss.phase = "idle";
    if (ss.phase === "waiting for input") ss.phase = "idle";
  }
  emit();
}

function pinSession(sessionId) {
  pinnedSessionId = sessionId || null;
  emit();
}

function getState() {
  let active = null, latestTs = 0;
  if (pinnedSessionId && islandSessions.has(pinnedSessionId)) {
    active = islandSessions.get(pinnedSessionId);
  } else {
    pinnedSessionId = null;
    for (const [, s] of islandSessions) {
      const t = s._lastActivityTs || s.startTs || 0;
      if (t > latestTs) { latestTs = t; active = s; }
    }
    // Don't switch to a "starting" session unless it's significantly newer
    // This prevents focus-stealing when a prompt is submitted in another session
    if (active && active.phase === "starting" && islandSessions.size > 1) {
      let secondBest = null, secondTs = 0;
      for (const [, s] of islandSessions) {
        if (s === active) continue;
        const t = s._lastActivityTs || s.startTs || 0;
        if (t > secondTs && s.phase !== "idle" && s.phase !== "done") { secondTs = t; secondBest = s; }
      }
      // If another session was active within 3s, prefer it over the "starting" one
      if (secondBest && (latestTs - secondTs) < 3000) {
        active = secondBest;
      }
    }
  }
  if (!active) {
    return { phase: "idle", progress: null, tool: null, toolDetail: null,
      files: 0, sessions: 0, tokens: 0, errors: 0, thinking: false,
      waiting: false, pulsing: false, waitingTool: null, approved: null,
      denied: null, rejected: null, agentsRunning: 0, agentsTotal: 0,
      apiError: null, idleSeconds: 0, userQuery: null, recentTools: [],
      activeFile: null, elapsed: 0, planningStrike: false, sessionDots: [],
      activeSessionColor: null, activeSessionId: null };
  }

  const sessionDots = [];
  let dotIdx = 0;
  for (const [, s] of islandSessions) {
    let status = "working";
    if (s.phase === "waiting for input") status = "needsInput";
    else if (s.phase === "done") status = "done";
    else if (s.phase === "idle") status = "idle";
    else if (s.waiting) status = "waiting";
    else if (s.progress === "stuck") status = "stuck";
    else if (s.thinking) status = "thinking";
    sessionDots.push({ status, label: s.label || s.id.slice(0, 6),
      color: s._color || SESSION_COLORS[dotIdx % SESSION_COLORS.length], id: s.id });
    dotIdx++;
  }

  return {
    phase: active.phase, progress: active.progress,
    tool: active.tool, toolDetail: active.toolDetail,
    files: active.files, sessions: islandSessions.size,
    tokens: active.tokens, tokIn: active._tokIn, tokOut: active._tokOut, tokCacheRead: active._tokCacheRead, tokCacheCreate: active._tokCacheCreate,
    errors: active.errors,
    thinking: active.thinking, waiting: active.waiting,
    pulsing: active.pulsing || false, waitingTool: active.waitingTool,
    approved: active.approved, denied: active.denied || null,
    rejected: active.rejected || null,
    agentsRunning: active.agentsRunning || 0, agentsTotal: active.agentsTotal || 0,
    apiError: active.apiError || null,
    idleSeconds: active.idleSince ? Math.floor((Date.now() - active.idleSince) / 1000) : 0,
    userQuery: active.userQuery,
    recentTools: active.recentTools.map(t => t.name + (t.detail ? " " + t.detail : "")),
    activeFile: active.activeFile,
    elapsed: active.startTs ? Math.floor((Date.now() - active.startTs) / 1000) : 0,
    planningStrike: active.planningStrike || false,
    sessionDots, activeSessionColor: active._color || null,
    activeSessionId: active.id || null,
    pinnedSessionId: pinnedSessionId || null,
  };
}

function emit() {
  if (onUpdate) onUpdate(getState());
}

module.exports = { init, processEvent, normalizeAfterBacklog, getState, pinSession };
