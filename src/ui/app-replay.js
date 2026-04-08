"use strict";

// LoupeReplay — Session replay popover (iframe-based) and insights launcher.

const LoupeReplay = (() => {

  let _sessions = null;        // reference to app.js sessions Map
  let _getActiveSession = null; // function() => activeSession string

  const esc = LoupeUtils.esc;

  let replayAbort = null;      // current AbortController
  let replaySessionId = null;  // session being replayed
  let replayAnalyzing = false;
  let replayHasReport = false;

  window.requestReplayAnalysis = async () => {
    const activeSession = _getActiveSession();
    const sid = activeSession === "all" ? (_sessions.keys().next().value || null) : activeSession;
    if (!sid) return;
    openReplayPopover(sid);
  };

  // --- Replay popover (iframe pattern, mirrors insights) ---

  function openReplayPopover(sessionId) {
    const overlay = document.getElementById("replay-popover-overlay");
    const sessionLabel = document.getElementById("replay-session-label");
    const idle = document.getElementById("replay-idle");
    const loading = document.getElementById("replay-loading");
    const iframe = document.getElementById("replay-iframe");

    replaySessionId = sessionId;
    replayAnalyzing = false;
    replayHasReport = false;

    // Reset
    idle.style.display = "";
    loading.style.display = "none";
    iframe.style.display = "none";
    iframe.src = "";

    // Session label
    const sInfo = _sessions.get(sessionId);
    sessionLabel.textContent = sInfo ? sInfo.label : sessionId.slice(0, 12);

    updateReplayActionBtn();
    updateExportBtn();
    overlay.style.display = "";

    // Check if a cached report exists
    fetch(`/api/replay/report?sessionId=${encodeURIComponent(sessionId)}`, { method: "HEAD" }).then(r => {
      if (r.ok) {
        replayHasReport = true;
        idle.style.display = "none";
        loading.style.display = "none";
        iframe.style.display = "";
        const theme = document.documentElement.getAttribute("data-theme") || "dark";
        iframe.src = `/api/replay/report?sessionId=${encodeURIComponent(sessionId)}&theme=${theme}&t=${Date.now()}`;
      }
      updateReplayActionBtn();
      updateExportBtn();
    }).catch(() => {});
  }

  window.closeReplayPopover = function() {
    document.getElementById("replay-popover-overlay").style.display = "none";
    if (replayAbort) { replayAbort.abort(); replayAbort = null; }
    replayAnalyzing = false;
  };

  window.startReplayAnalysis = async function() {
    if (!replaySessionId || replayAnalyzing) return;
    replayAnalyzing = true;
    replayAbort = new AbortController();
    updateReplayActionBtn();

    const idle = document.getElementById("replay-idle");
    const loading = document.getElementById("replay-loading");
    const iframe = document.getElementById("replay-iframe");

    idle.style.display = "none";
    loading.style.display = "";
    iframe.style.display = "none";

    try {
      const resp = await fetch("/api/replay/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: replaySessionId }),
        signal: replayAbort.signal,
      });
      const data = await resp.json();

      if (data.status === "done" && data.reportExists) {
        replayHasReport = true;
        loading.style.display = "none";
        iframe.style.display = "";
        const theme = document.documentElement.getAttribute("data-theme") || "dark";
        iframe.src = `/api/replay/report?sessionId=${encodeURIComponent(replaySessionId)}&theme=${theme}&t=${Date.now()}`;
      } else {
        loading.style.display = "none";
        idle.style.display = "";
        idle.innerHTML = `<span style="color:#ef4444">${esc(data.error || "Failed to generate report")}</span>`;
      }
    } catch (err) {
      loading.style.display = "none";
      if (err.name === "AbortError") {
        idle.style.display = "";
        idle.textContent = "Analysis cancelled.";
      } else {
        idle.style.display = "";
        idle.innerHTML = `<span style="color:#ef4444">Error: ${esc(err.message)}</span>`;
      }
    }

    replayAnalyzing = false;
    replayAbort = null;
    updateReplayActionBtn();
    updateExportBtn();
  };

  window.cancelReplayAnalysis = function() {
    if (replayAbort) { replayAbort.abort(); replayAbort = null; }
  };

  window.restartReplayAnalysis = function() {
    if (!replaySessionId) return;
    replayHasReport = false;
    startReplayAnalysis();
  };

  function updateReplayActionBtn() {
    const btn = document.getElementById("replay-action-btn");
    if (!btn) return;
    if (replayAnalyzing) {
      btn.textContent = "Cancel";
      btn.title = "Cancel analysis";
      btn.onclick = cancelReplayAnalysis;
      btn.className = "replay-action-btn replay-action-cancel";
    } else if (replayHasReport) {
      btn.textContent = "Restart";
      btn.title = "Re-generate replay";
      btn.onclick = restartReplayAnalysis;
      btn.className = "replay-action-btn replay-action-restart";
    } else {
      btn.textContent = "Start";
      btn.title = "Generate replay";
      btn.onclick = startReplayAnalysis;
      btn.className = "replay-action-btn replay-action-start";
    }
  }

  function updateExportBtn() {
    const btn = document.getElementById("replay-export-btn");
    if (!btn) return;
    btn.style.display = replayHasReport ? "" : "none";
  }

  window.exportReplayMd = function() {
    // Open the cached report in a new browser tab
    if (!replaySessionId) return;
    const url = window.location.origin + `/api/replay/report?sessionId=${encodeURIComponent(replaySessionId)}`;
    const w = window.open(url, "_blank");
    if (!w) {
      navigator.clipboard.writeText(url).then(() => {
        const label = document.getElementById("replay-session-label");
        const origText = label.textContent;
        label.textContent = "URL copied — paste in browser";
        setTimeout(() => { label.textContent = origText; }, 3000);
      }).catch(() => {
        prompt("Open this URL in your browser:", url);
      });
    }
  };

  // --- Claude Insights launcher (unchanged) ---

  let insightsRunning = false;
  let insightsAbort = null;
  let insightsHasReport = false;

  function updateInsightsActionBtn() {
    const btn = document.getElementById("insights-action-btn");
    const openBtn = document.getElementById("insights-open-btn");
    if (!btn) return;
    if (insightsRunning) {
      btn.textContent = "Cancel";
      btn.title = "Cancel insights generation";
      btn.onclick = cancelInsights;
      btn.className = "replay-action-btn replay-action-cancel";
    } else if (insightsHasReport) {
      btn.textContent = "Restart";
      btn.title = "Re-generate insights report";
      btn.onclick = startInsights;
      btn.className = "replay-action-btn replay-action-restart";
      if (openBtn) openBtn.style.display = "";
    } else {
      btn.textContent = "Start";
      btn.title = "Generate insights report";
      btn.onclick = startInsights;
      btn.className = "replay-action-btn replay-action-start";
      if (openBtn) openBtn.style.display = "none";
    }
  }

  window.openInsightsPopover = function() {
    const overlay = document.getElementById("insights-popover-overlay");
    const iframe = document.getElementById("insights-iframe");
    const idle = document.getElementById("insights-idle");
    const status = document.getElementById("insights-status");
    overlay.style.display = "";

    fetch("/api/insights/report", { method: "HEAD" }).then(r => {
      if (r.ok) {
        insightsHasReport = true;
        idle.style.display = "none";
        iframe.style.display = "";
        iframe.src = "/api/insights/report?" + Date.now();
        status.textContent = "";
      } else {
        insightsHasReport = false;
        idle.style.display = "";
        iframe.style.display = "none";
        status.textContent = "";
      }
      updateInsightsActionBtn();
    }).catch(() => {
      insightsHasReport = false;
      updateInsightsActionBtn();
    });
  };

  window.closeInsightsPopover = function() {
    document.getElementById("insights-popover-overlay").style.display = "none";
    if (insightsAbort) { insightsAbort.abort(); insightsAbort = null; insightsRunning = false; }
  };

  window.startInsights = async function() {
    if (insightsRunning) return;
    insightsRunning = true;
    insightsAbort = new AbortController();
    updateInsightsActionBtn();

    const status = document.getElementById("insights-status");
    const idle = document.getElementById("insights-idle");
    const iframe = document.getElementById("insights-iframe");
    idle.style.display = "none";
    iframe.style.display = "none";
    status.textContent = "Generating insights (this may take a few minutes)...";

    try {
      const resp = await fetch("/api/insights/run", { method: "POST", signal: insightsAbort.signal });
      const text = await resp.text();
      const lines = text.trim().split("\n");
      const result = JSON.parse(lines[lines.length - 1]);
      if (result.status === "done" && result.reportExists) {
        insightsHasReport = true;
        status.textContent = "";
        iframe.style.display = "";
        iframe.src = "/api/insights/report?" + Date.now();
      } else {
        status.textContent = result.error || "Failed to generate report";
      }
    } catch (err) {
      if (err.name === "AbortError") {
        status.textContent = "Cancelled";
      } else {
        status.textContent = "Error: " + err.message;
      }
    }
    insightsRunning = false;
    insightsAbort = null;
    updateInsightsActionBtn();
  };

  window.cancelInsights = function() {
    if (insightsAbort) { insightsAbort.abort(); insightsAbort = null; }
  };

  window.openInsightsInBrowser = function() {
    const url = window.location.origin + "/api/insights/report";
    const w = window.open(url, "_blank");
    if (!w) {
      navigator.clipboard.writeText(url).then(() => {
        const status = document.getElementById("insights-status");
        status.textContent = "URL copied — paste in browser";
        setTimeout(() => { status.textContent = ""; }, 3000);
      }).catch(() => {
        prompt("Open this URL in your browser:", url);
      });
    }
  };

  function init({ sessions, getActiveSession }) {
    _sessions = sessions;
    _getActiveSession = getActiveSession;
  }

  return {
    openReplayPopover,
    updateReplayActionBtn,
    updateExportBtn,
    init,
  };
})();
