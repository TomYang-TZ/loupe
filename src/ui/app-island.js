"use strict";

// LoupeIsland — Dynamic Island bridge for native macOS app.
// Per-session state tracking and condensed signal updates.

const LoupeIsland = (() => {

  let _sessions = null; // reference to app.js sessions Map, set via init()

  const islandSessions = new Map(); // sessionId -> per-session state

  function getIslandSession(sid) {
    if (!islandSessions.has(sid)) {
      islandSessions.set(sid, {
        id: sid,
        label: "",
        phase: "idle",
        progress: null,
        tool: null,
        toolDetail: null,
        thinking: false,
        waiting: false,
        waitingTool: null,
        approved: null,        // briefly set after approval for strikethrough
        idleSince: null,
        userQuery: null,
        recentTools: [],
        errors: 0,
        tokens: 0,
        files: 0,
        activeFile: null,
        startTs: null,
        denied: null,
        rejected: null,
        denials: 0,
        agentsRunning: 0,
        agentsTotal: 0,
        apiError: null,
        _fileSet: new Set(),
        _totalTokens: 0,
        _idleTimer: null,
        _stopFailureTs: null,
        _agentClearTimer: null,
      });
    }
    return islandSessions.get(sid);
  }

  function updateIslandFromEntry(entry) {
    const cat = entry.category;
    const sid = entry.sessionId;
    if (!sid) { sendIslandUpdate(); return; } // skip entries without session
    const s = getIslandSession(sid);
    if (!s.startTs) s.startTs = entry.ts;
    s._lastActivityTs = entry.ts;

    // Session label + color
    const sInfo = _sessions ? _sessions.get(sid) : null;
    if (sInfo) {
      s.label = sInfo.label;
      s._color = sInfo.color || null;
    }

    // Track user query — new turn resets phase
    if (cat === "user_query" && entry.userQuery) {
      s.userQuery = entry.userQuery.slice(0, 120);
      s.phase = "starting";
      s.pulsing = false;
      if (s._pulseTimer) { clearTimeout(s._pulseTimer); s._pulseTimer = null; }
      s.idleSince = null;
      if (s._idleTimer) { clearTimeout(s._idleTimer); s._idleTimer = null; }
      s._lastActivityTs = entry.ts;
    }

    // Track thinking — also clears "starting"
    if (cat === "thinking") {
      s.thinking = true;
      s.phase = "exploring";
      if (entry.userQuery && !s.userQuery) s.userQuery = entry.userQuery.slice(0, 120);
    }

    // Track tool usage
    if (cat === "tool_use" || cat === "pre_tool") {
      s.thinking = false;
      const toolName = entry.json?.data?.tool_name || entry.json?.tool_name || entry.title || "";
      const input = entry.json?.data?.tool_input || {};
      s.tool = toolName;

      let detail = "";
      if (input.file_path) {
        const parts = input.file_path.split("/");
        detail = parts.slice(-2).join("/");
        s.activeFile = input.file_path;
        s._fileSet.add(input.file_path);
      } else if (input.command) {
        detail = input.command.split("\n")[0].slice(0, 80);
      } else if (input.pattern) {
        detail = input.pattern;
      } else if (input.description) {
        detail = input.description.slice(0, 60);
      }
      s.toolDetail = detail;
      s.files = s._fileSet.size;

      s.recentTools.push({ name: toolName, detail, ts: entry.ts });
      if (s.recentTools.length > 5) s.recentTools.shift();

      if (["Read", "Glob", "Grep", "LSP"].some(t => toolName.includes(t))) s.phase = "exploring";
      else if (["Edit", "Write", "NotebookEdit"].some(t => toolName.includes(t))) s.phase = "implementing";
      else if (toolName.includes("Bash")) {
        const cmd = input.command || "";
        if (/test|jest|pytest|cargo test|npm test/.test(cmd)) s.phase = "testing";
        else if (s.phase === "idle" || s.phase === "starting") s.phase = "implementing";
      } else if (toolName.includes("Agent")) s.phase = "planning";
    }

    // Approval tracking — any tool activity after waiting means approval was granted
    if (cat === "tool_use" || cat === "pre_tool") {
      // New tool arriving while waiting = previous tool was approved
      if (s.waiting || s.phase === "waiting for input") {
        s.approved = s.waitingTool || s._pendingToolName || s.tool;
        s.waiting = false;
        s.pulsing = false;
        s.waitingTool = null;
        if (s._pulseTimer) { clearTimeout(s._pulseTimer); s._pulseTimer = null; }
        sendIslandUpdate();
        setTimeout(() => { s.approved = null; sendIslandUpdate(); }, 1000);
      }
      s._pendingToolName = s.tool;
      s._pendingToolTs = Date.now();
    }
    if (cat === "post_tool" || cat === "tool_result" || cat === "sub_agent_result") {
      // Tool completed — if we were waiting, this means approval was granted
      if (s.waiting || s.phase === "waiting for input") {
        s.approved = s.waitingTool || s._pendingToolName || s.tool;
        s.waiting = false;
        s.pulsing = false;
        s.waitingTool = null;
        if (s._pulseTimer) { clearTimeout(s._pulseTimer); s._pulseTimer = null; }
        s.phase = s.tool ? "implementing" : "exploring";
        sendIslandUpdate();
        setTimeout(() => { s.approved = null; sendIslandUpdate(); }, 1000);
      }
      s._pendingToolName = null;
      s._pendingToolTs = null;
    }
    // Thinking after waiting also means approval (Claude resumed work)
    if (cat === "thinking" && (s.waiting || s.phase === "waiting for input")) {
      s.approved = s.waitingTool || s.tool;
      s.waiting = false;
      s.pulsing = false;
      s.waitingTool = null;
      if (s._pulseTimer) { clearTimeout(s._pulseTimer); s._pulseTimer = null; }
      s.phase = "exploring";
      sendIslandUpdate();
      setTimeout(() => { s.approved = null; sendIslandUpdate(); }, 1000);
    }

    // Rejection detection — tool_rejected, user_query, or thinking after waiting = tool was rejected
    // Only check the session that the event belongs to (not all sessions)
    if (cat === "user_query" || cat === "thinking" || cat === "tool_rejected") {
      if (s.waiting) {
        s.rejected = s.waitingTool || "tool";
        s.waiting = false;
        s.pulsing = false;
        s.waitingTool = null;
        if (s._pulseTimer) { clearTimeout(s._pulseTimer); s._pulseTimer = null; }
        s.phase = "exploring";
        setTimeout(() => { s.rejected = null; sendIslandUpdate(); }, 1500);
      }
      sendIslandUpdate();
    }

    // Errors
    if (cat === "error") { s.errors++; s.progress = "stuck"; }
    else if (cat === "tool_result" || cat === "post_tool") {
      if (s.progress === "stuck") s.progress = null;
    }

    // Tokens
    const usage = entry.json?.data?.message?.usage || entry.json?.message?.usage;
    if (usage) {
      s._totalTokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
      s.tokens = s._totalTokens;
    }

    // Notification hook = Claude needs input → show "needs input"
    if (cat === "Notification") {
      s.phase = "waiting for input";
      s.thinking = false;
      // Don't clear waiting/waitingTool if PermissionRequest already set them
      if (!s.waiting) {
        s.waitingTool = null;
        // Pulse 10 times for waiting for input
        s.pulsing = true;
        if (s._pulseTimer) clearTimeout(s._pulseTimer);
        s._pulseTimer = setTimeout(() => { s.pulsing = false; sendIslandUpdate(); }, 10000);
      }
      if (s._idleTimer) clearTimeout(s._idleTimer);
    }

    // PermissionRequest — explicit waiting signal
    if (cat === "permission_request") {
      const toolName = entry.json?.data?.tool_name || entry.title || "tool";
      s.waiting = true;
      s.pulsing = true;
      s.waitingTool = toolName;
      s.phase = "waiting for input";
      s.thinking = false;
      if (s._idleTimer) clearTimeout(s._idleTimer);
      // Pulse for ~10s then hold steady
      if (s._pulseTimer) clearTimeout(s._pulseTimer);
      s._pulseTimer = setTimeout(() => {
        s.pulsing = false;
        sendIslandUpdate();
      }, 10000);
    }

    // PermissionDenied — flash denied, increment friction counter
    if (cat === "permission_denied") {
      const toolName = entry.json?.data?.tool_name || entry.title || "tool";
      s.denied = toolName;
      s.denials++;
      if (s.denials >= 3) s.progress = "stuck";
      sendIslandUpdate();
      setTimeout(() => { s.denied = null; sendIslandUpdate(); }, 2000);
    }

    // Reset denials on new turn
    if (cat === "user_query") {
      s.denials = 0;
    }

    // SubagentStart — track running agent count
    if (cat === "sub_agent") {
      s.agentsRunning++;
      s.agentsTotal++;
      s.toolDetail = s.agentsRunning + " agent" + (s.agentsRunning > 1 ? "s" : "");
      if (s._agentClearTimer) { clearTimeout(s._agentClearTimer); s._agentClearTimer = null; }
    }

    // SubagentStop — decrement, show progress
    if (cat === "sub_agent_result") {
      s.agentsRunning = Math.max(0, s.agentsRunning - 1);
      if (s.agentsRunning > 0) {
        const done = s.agentsTotal - s.agentsRunning;
        s.toolDetail = done + "/" + s.agentsTotal + " agents";
      } else {
        s.toolDetail = s.agentsTotal + "/" + s.agentsTotal + " agents";
        s._agentClearTimer = setTimeout(() => {
          s.agentsRunning = 0;
          s.agentsTotal = 0;
          s.toolDetail = null;
          sendIslandUpdate();
        }, 3000);
      }
    }

    // PostToolUseFailure — increment errors, signal stuck
    if (cat === "tool_failure") {
      s.errors++;
      s.progress = "stuck";
    }

    // stop_failure — API error (rate limit, auth, billing)
    if (cat === "stop_failure") {
      s.progress = "stuck";
      s._stopFailureTs = Date.now();
      s.phase = "idle";
      s.thinking = false;
      s.tool = null;
      s.toolDetail = null;
    }

    // Stop hook = Claude finished → "done", then idle after 10s
    // StopFailure takes precedence — suppress "done" if StopFailure arrived within 500ms
    if (cat === "Stop" && !(s._stopFailureTs && (Date.now() - s._stopFailureTs < 500))) {
      s.phase = "done";
      s.thinking = false;
      s.tool = null;
      s.toolDetail = null;
      // Clean up any orphaned running agents
      if (s.agentsRunning > 0) { s.agentsRunning = 0; s.toolDetail = null; }
      if (s._agentClearTimer) { clearTimeout(s._agentClearTimer); s._agentClearTimer = null; }
      // Pulse for done
      s.pulsing = true;
      if (s._pulseTimer) clearTimeout(s._pulseTimer);
      s._pulseTimer = setTimeout(() => { s.pulsing = false; sendIslandUpdate(); }, 5000);
      if (s._idleTimer) clearTimeout(s._idleTimer);
      s._idleTimer = setTimeout(() => {
        s.phase = "idle";
        s.idleSince = Date.now();
        sendIslandUpdate();
      }, 10000);
    }

    // Fallback idle timer — reset on activity (not on Stop/thinking/Notification which have their own timers)
    if (cat !== "thinking" && cat !== "Notification" && cat !== "Stop" && cat !== "stop_failure") {
      s.idleSince = null;
      if (s._idleTimer) clearTimeout(s._idleTimer);
      s._idleTimer = setTimeout(() => {
        s.phase = "idle";
        s.tool = null;
        s.toolDetail = null;
        s.thinking = false;
        s.idleSince = Date.now();
        sendIslandUpdate();
      }, 30000);
    }

    // Prune stale sessions (no events for 5 min)
    const now = Date.now();
    for (const [id, ss] of islandSessions) {
      const lastEvent = ss.recentTools.length > 0 ? ss.recentTools[ss.recentTools.length - 1].ts : (ss.startTs || 0);
      if (now - lastEvent > 5 * 60 * 1000) {
        if (ss._idleTimer) clearTimeout(ss._idleTimer);
        islandSessions.delete(id);
      }
    }

    sendIslandUpdate();
  }

  function sendIslandUpdate() {
    try {
      // Most recently active session drives the main display
      let active = null;
      let latestTs = 0;
      for (const [, s] of islandSessions) {
        const t = s._lastActivityTs || s.startTs || 0;
        if (t > latestTs) { latestTs = t; active = s; }
      }
      if (!active) active = { phase: "idle", progress: null, tool: null, toolDetail: null, files: 0, tokens: 0, errors: 0, thinking: false, waiting: false, waitingTool: null, yourTurn: false, userQuery: null, recentTools: [], activeFile: null, startTs: null };

      // Build session dots: { status: "working"|"waiting"|"yourTurn"|"stuck", label }
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
        const mainSession = _sessions ? _sessions.get(s.id) : null;
        const dotColor = mainSession?.color || s._color || LoupeUtils.SESSION_COLORS[dotIdx % LoupeUtils.SESSION_COLORS.length];
        sessionDots.push({ status, label: s.label || s.id.slice(0, 6), color: dotColor, id: s.id });
        dotIdx++;
      }

      const elapsed = active.startTs ? Math.floor((Date.now() - active.startTs) / 1000) : 0;
      if (!window.webkit?.messageHandlers?.islandUpdate) return;
      window.webkit.messageHandlers.islandUpdate.postMessage({
        phase: active.phase,
        progress: active.progress,
        tool: active.tool,
        toolDetail: active.toolDetail,
        files: active.files,
        sessions: islandSessions.size,
        tokens: active.tokens,
        errors: active.errors,
        thinking: active.thinking,
        waiting: active.waiting,
        pulsing: active.pulsing || false,
        waitingTool: active.waitingTool,
        approved: active.approved,
        denied: active.denied || null,
        rejected: active.rejected || null,
        agentsRunning: active.agentsRunning || 0,
        agentsTotal: active.agentsTotal || 0,
        apiError: active.apiError || null,
        idleSeconds: active.idleSince ? Math.floor((Date.now() - active.idleSince) / 1000) : 0,
        userQuery: active.userQuery,
        recentTools: active.recentTools.map(t => t.name + (t.detail ? " " + t.detail : "")),
        activeFile: active.activeFile,
        elapsed: elapsed,
        sessionDots: sessionDots,
        activeSessionColor: active._color || (active.id && _sessions && _sessions.get(active.id)?.color) || null,
        activeSessionId: active.id || null,
      });
    } catch (e) { console.error("sendIslandUpdate error:", e); }
  }

  // Periodic update so idle seconds tick up in the pill
  setInterval(() => {
    const hasIdle = [...islandSessions.values()].some(s => s.idleSince);
    if (hasIdle) sendIslandUpdate();
  }, 1000);

  function normalizeBacklogState() {
    for (const [, ss] of islandSessions) {
      ss.waiting = false;
      ss.pulsing = false;
      ss.waitingTool = null;
      ss.rejected = null;
      ss.approved = null;
      ss.denied = null;
      // Normalize transient phases — "starting" and "done" are momentary
      if (ss.phase === "starting") ss.phase = "idle";
      if (ss.phase === "done") ss.phase = "idle";
      if (ss.phase === "waiting for input") ss.phase = "idle";
    }
    sendIslandUpdate();
  }

  function init({ sessions }) {
    _sessions = sessions;
  }

  return {
    islandSessions,
    getIslandSession,
    updateIslandFromEntry,
    sendIslandUpdate,
    normalizeBacklogState,
    init,
  };
})();
