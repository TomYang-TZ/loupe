"use strict";

// LoupeReplay — Session replay analysis popover and timeline.

const LoupeReplay = (() => {

  let _sessions = null;        // reference to app.js sessions Map
  let _getActiveSession = null; // function() => activeSession string

  const esc = LoupeUtils.esc;
  const formatTime = LoupeUtils.formatTime;

  let replayAbort = null;      // current AbortController
  let replaySessionId = null;  // session being analyzed
  let replayAnalyzing = false;
  let replayRawMarkdown = null; // raw analysis text for export

  window.requestReplayAnalysis = async () => {
    const activeSession = _getActiveSession();
    const sid = activeSession === "all" ? (_sessions.keys().next().value || null) : activeSession;
    if (!sid) return;
    // Open the popover with timeline only — don't auto-run analysis
    openReplayPopover(sid);
  };

  async function fetchReplayTimeline(sid) {
    try {
      const resp = await fetch("/api/session-timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid }),
      });
      const data = await resp.json();
      renderReplayTimeline(data.timeline || [], data.totalEntries || 0);
    } catch {}
  }

  async function runReplayAnalysis(sid) {
    if (replayAbort) replayAbort.abort();
    replayAbort = new AbortController();
    replaySessionId = sid;
    replayAnalyzing = true;
    updateReplayActionBtn();

    const scroll = document.getElementById("replay-analysis-scroll");
    scroll.innerHTML = '<div class="replay-loading">Analyzing session...</div>';

    // Gather behavioral signature from Momentum (if available)
    const behavioral = (typeof Momentum !== "undefined" && Momentum.getSessionVector)
      ? Momentum.getSessionVector(sid)
      : null;
    // Also include risk history from signature
    if (behavioral) {
      const sig = Momentum.getSignature ? Momentum.getSignature(sid) : null;
      if (sig) {
        behavioral.riskHistory = sig.riskHistory || [];
        behavioral.riskTrend = sig.riskTrend || "neutral";
        behavioral.fileDiversity = sig.uniqueFiles ? sig.uniqueFiles.size : 0;
      }
    }

    const data = await fetch("/api/replay-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, behavioral }),
      signal: replayAbort.signal,
    }).then(r => r.json()).catch(err => {
      if (err.name === "AbortError") return { cancelled: true };
      return { error: `Request failed: ${err.message}` };
    });

    replayAnalyzing = false;
    updateReplayActionBtn();

    if (data.cancelled) {
      replayRawMarkdown = null;
      scroll.innerHTML = '<div class="replay-error" style="color:var(--text-muted)">Analysis cancelled.</div>';
    } else if (data.error) {
      replayRawMarkdown = null;
      scroll.innerHTML = `<div class="replay-error">${esc(data.error)}</div>`;
    } else {
      replayRawMarkdown = data.analysis;
      scroll.innerHTML = `<div class="replay-content">${renderMarkdown(data.analysis)}</div>`;
    }
    updateExportBtn();
  }

  window.startReplayAnalysis = function() {
    if (!replaySessionId) return;
    runReplayAnalysis(replaySessionId);
  };

  window.cancelReplayAnalysis = function() {
    if (replayAbort) { replayAbort.abort(); replayAbort = null; }
  };

  window.restartReplayAnalysis = function() {
    if (!replaySessionId) return;
    runReplayAnalysis(replaySessionId);
  };

  function updateReplayActionBtn() {
    const btn = document.getElementById("replay-action-btn");
    if (!btn) return;
    if (replayAnalyzing) {
      btn.textContent = "Cancel";
      btn.title = "Cancel analysis";
      btn.onclick = cancelReplayAnalysis;
      btn.className = "replay-action-btn replay-action-cancel";
    } else if (replayRawMarkdown) {
      btn.textContent = "Restart";
      btn.title = "Re-run analysis";
      btn.onclick = restartReplayAnalysis;
      btn.className = "replay-action-btn replay-action-restart";
    } else {
      btn.textContent = "Start";
      btn.title = "Run analysis";
      btn.onclick = startReplayAnalysis;
      btn.className = "replay-action-btn replay-action-start";
    }
  }

  function updateExportBtn() {
    const btn = document.getElementById("replay-export-btn");
    if (!btn) return;
    btn.disabled = !replayRawMarkdown;
    btn.style.opacity = replayRawMarkdown ? "1" : "0.4";
  }

  window.exportReplayMd = function() {
    if (!replayRawMarkdown) return;
    const sInfo = replaySessionId ? _sessions.get(replaySessionId) : null;
    const label = sInfo ? sInfo.label : "session";
    const date = new Date().toISOString().slice(0, 10);
    const filename = `replay-${label}-${date}.md`;

    const blob = new Blob([replayRawMarkdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  function openReplayPopover(sessionId) {
    const overlay = document.getElementById("replay-popover-overlay");
    const sessionLabel = document.getElementById("replay-session-label");
    const archetypeBadge = document.getElementById("replay-archetype-badge");
    const timelineScroll = document.getElementById("replay-timeline-scroll");
    const analysisScroll = document.getElementById("replay-analysis-scroll");
    const riskMeter = document.getElementById("replay-risk-meter");

    // Reset content
    replayRawMarkdown = null;
    replaySessionId = sessionId;
    replayAnalyzing = false;
    timelineScroll.innerHTML = '<div class="replay-loading">Loading timeline...</div>';
    analysisScroll.innerHTML = '<div class="replay-idle">Press <strong>Start</strong> to run analysis</div>';
    updateReplayActionBtn();
    updateExportBtn();

    // Fetch timeline immediately
    fetchReplayTimeline(sessionId);

    // Session label
    const sInfo = _sessions.get(sessionId);
    sessionLabel.textContent = sInfo ? sInfo.label : sessionId.slice(0, 12);

    // Behavioral signature data from Momentum
    const sig = Momentum.getSignature ? Momentum.getSignature(sessionId) : null;
    if (sig && sig.archetype) {
      archetypeBadge.textContent = sig.archetype.replace(/-/g, " ");
      archetypeBadge.style.display = "";
    } else {
      archetypeBadge.style.display = "none";
    }

    // Risk meter
    if (sig) {
      const risk = Math.round(sig.riskScore * 100);
      let barColor;
      if (sig.riskScore < 0.3) barColor = "#06b6d4";
      else if (sig.riskScore < 0.6) barColor = "#eab308";
      else barColor = "#ef4444";
      riskMeter.innerHTML = `
        <span class="risk-label">risk ${risk}%</span>
        <div class="risk-bar"><div class="risk-fill" style="width:${risk}%;background:${barColor}"></div></div>
      `;
    } else {
      riskMeter.innerHTML = "";
    }

    overlay.style.display = "";
  }

  window.closeReplayPopover = function() {
    document.getElementById("replay-popover-overlay").style.display = "none";
  };

  function renderReplayTimeline(timeline, totalEntries) {
    const scroll = document.getElementById("replay-timeline-scroll");
    if (!timeline || timeline.length === 0) {
      scroll.innerHTML = '<div class="replay-loading" style="animation:none">No timeline data available</div>';
      return;
    }

    const frag = document.createDocumentFragment();

    for (const item of timeline) {
      const div = document.createElement("div");
      div.className = `tl-entry tl-${item.type}`;

      const num = document.createElement("span");
      num.className = "tl-num";
      num.textContent = item.n;
      div.appendChild(num);

      const badge = document.createElement("span");
      badge.className = `tl-badge tl-badge-${item.type}`;
      if (item.type === "user") badge.textContent = "Q";
      else if (item.type === "think") badge.textContent = "T";
      else if (item.type === "tool") badge.textContent = item.tool || "USE";
      else if (item.type === "error") badge.textContent = "ERR";
      else badge.textContent = "TXT";
      div.appendChild(badge);

      const text = document.createElement("span");
      text.className = "tl-text";
      let displayText = item.text || item.detail || "";
      // Shorten file paths to basename for readability
      displayText = displayText.replace(/\/[\w./-]+\/([\w.-]+)/g, "$1");
      text.textContent = displayText;
      text.title = item.text || item.detail || ""; // full path in tooltip
      div.appendChild(text);

      frag.appendChild(div);
    }

    // Summary at top
    const summary = document.createElement("div");
    summary.className = "tl-entry";
    summary.style.cssText = "padding:8px 10px;color:var(--text-muted);border-bottom:1px solid var(--border,rgba(255,255,255,0.06));margin-bottom:4px";
    const userCount = timeline.filter(t => t.type === "user").length;
    const toolCount = timeline.filter(t => t.type === "tool").length;
    const errCount = timeline.filter(t => t.type === "error").length;
    summary.innerHTML = `<span style="font-size:10px">${totalEntries} entries &middot; ${userCount} queries &middot; ${toolCount} tools${errCount ? ` &middot; <span style="color:#ef4444">${errCount} errors</span>` : ""}</span>`;

    scroll.innerHTML = "";
    scroll.appendChild(summary);
    scroll.appendChild(frag);
  }

  function renderMarkdown(text) {
    if (!text) return "";
    // Escape HTML
    let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Fenced code blocks (```...```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre class="md-code-block"><code>${code.trimEnd()}</code></pre>`);

    // Tables: detect rows of |...|...|
    html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (tableBlock) => {
      const rows = tableBlock.trim().split("\n").filter(r => r.trim());
      if (rows.length < 2) return tableBlock;
      // Check if second row is separator (|---|---|)
      const isSep = rows[1] && /^\|[\s:-]+\|/.test(rows[1]);
      const dataRows = isSep ? [rows[0], ...rows.slice(2)] : rows;
      let t = '<table class="md-table">';
      dataRows.forEach((row, i) => {
        const cells = row.split("|").slice(1, -1).map(c => c.trim());
        const tag = (i === 0 && isSep) ? "th" : "td";
        t += "<tr>" + cells.map(c => `<${tag}>${c}</${tag}>`).join("") + "</tr>";
      });
      t += "</table>";
      return t;
    });

    // Headings
    html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
    // Inline formatting
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Progress bars
    html = html.replace(/^(\s*)(█+░*)\s*(.*)$/gm,
      '<div style="font-family:monospace;font-size:10px;color:var(--text-muted)">$1<span style="color:#06b6d4">$2</span> $3</div>');
    // Block formatting
    html = html.replace(/\n\n/g, "<br><br>");
    html = html.replace(/\n- /g, "<br>• ");
    html = html.replace(/\n(\d+)\. /g, "<br>$1. ");
    return html;
  }

  // --- Claude Insights launcher ---

  let insightsRunning = false;

  window.openInsightsPopover = function() {
    const overlay = document.getElementById("insights-popover-overlay");
    const iframe = document.getElementById("insights-iframe");
    const status = document.getElementById("insights-status");
    overlay.style.display = "";
    status.textContent = "Loading report...";
    // Try to load existing report
    iframe.src = "/api/insights/report";
    iframe.onload = () => { status.textContent = ""; };
    iframe.onerror = () => { status.textContent = "No report found — click Refresh"; };
    // Also handle 404 inside iframe
    fetch("/api/insights/report", { method: "HEAD" }).then(r => {
      if (!r.ok) status.textContent = "No report yet — click Refresh to generate";
    }).catch(() => {});
  };

  window.closeInsightsPopover = function() {
    document.getElementById("insights-popover-overlay").style.display = "none";
  };

  window.runInsights = async function() {
    if (insightsRunning) return;
    insightsRunning = true;
    const status = document.getElementById("insights-status");
    const btn = document.getElementById("insights-refresh-btn");
    btn.textContent = "Running...";
    btn.disabled = true;
    status.textContent = "Generating insights (this may take a few minutes)...";

    try {
      const resp = await fetch("/api/insights/run", { method: "POST" });
      const text = await resp.text();
      // Response is chunked — parse the last JSON line
      const lines = text.trim().split("\n");
      const result = JSON.parse(lines[lines.length - 1]);
      if (result.status === "done" && result.reportExists) {
        status.textContent = "Report ready";
        document.getElementById("insights-iframe").src = "/api/insights/report?" + Date.now();
      } else {
        status.textContent = result.error || "Failed to generate report";
      }
    } catch (err) {
      status.textContent = "Error: " + err.message;
    }
    insightsRunning = false;
    btn.textContent = "Refresh";
    btn.disabled = false;
  };

  window.openInsightsInBrowser = function() {
    window.open("/api/insights/report", "_blank");
  };

  function init({ sessions, getActiveSession }) {
    _sessions = sessions;
    _getActiveSession = getActiveSession;
  }

  return {
    fetchReplayTimeline,
    runReplayAnalysis,
    openReplayPopover,
    renderReplayTimeline,
    renderMarkdown,
    updateReplayActionBtn,
    updateExportBtn,
    init,
  };
})();
