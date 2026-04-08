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

    // Classify topics in parallel (Haiku, fast)
    const narrEl = document.getElementById("replay-narration");
    if (narrEl) narrEl.textContent = "classifying topics...";
    fetchSessionTopics(sid);

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
    // Reset narration panel
    const narrEl = document.getElementById("replay-narration");
    const artEl = document.getElementById("replay-ascii-art");
    if (narrEl) narrEl.textContent = "press Start to classify topics";
    if (artEl) artEl.textContent = "";
    stopAsciiArt();
    startAsciiArt(sessionId);
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
    stopAsciiArt();
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

    // Check if a report already exists
    fetch("/api/insights/report", { method: "HEAD" }).then(r => {
      if (r.ok) {
        // Show existing report immediately
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
    // Fetch the report and open it as a data URL in a new window,
    // or fall back to copying the URL
    const url = window.location.origin + "/api/insights/report";
    // Try window.open first (works in regular browser, may fail in WKWebView)
    const w = window.open(url, "_blank");
    if (!w) {
      // WKWebView blocks window.open — copy URL to clipboard instead
      navigator.clipboard.writeText(url).then(() => {
        const status = document.getElementById("insights-status");
        status.textContent = "URL copied — paste in browser";
        setTimeout(() => { status.textContent = ""; }, 3000);
      }).catch(() => {
        // Last resort: prompt
        prompt("Open this URL in your browser:", url);
      });
    }
  };

  // --- Session Timeline: ASCII art + narrated topics ---

  // Seeded PRNG from session ID
  function seededRng(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    let s = h >>> 0;
    return () => { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  }

  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

  // --- ASCII Art Animations ---
  // Each animation is { frames: string[][], interval: ms }
  // frames[i] is an array of lines

  function getAsciiAnimations() { return [
    // Campfire
    { interval: 400, frames: [
      ["     (  ","    ) ( )","   ( ) ( ","    )  ) ","   .^^^. ","   |   | ","   '---' "],
      ["    ) ( ","   ( ) ( ","    ) )  ","   (  (  ","   .^^^. ","   |   | ","   '---' "],
      ["   (  ) ","    )(   ","   ) ( ) ","    )(   ","   .^^^. ","   |   | ","   '---' "],
    ]},
    // Ocean waves
    { interval: 500, frames: [
      ["         ","~._.~._.~","_.~._.~._","~._.~._.~","   __/|  ","  /  __|_","_/______\\"],
      ["         ","._.~._.~.","~._.~._.~","_.~._.~._","   __/|  ","  /  __|_","_/______\\"],
      ["         ","_.~._.~._","~._.~._.~","._.~._.~.","   __/|  ","  /  __|_","_/______\\"],
    ]},
    // Cat napping
    { interval: 800, frames: [
      ["         ","  /\\_/\\  "," ( o.o ) ","  > ^ <  "," /|   |\\ ","(_|   |_)"],
      ["         ","  /\\_/\\  "," ( -.- ) ","  > ^ <  "," /|   |\\ ","(_|   |_)"],
      ["         ","  /\\_/\\  "," ( o.o ) ","  > ^ <  "," /|   |\\ ","(_|   |_)"],
      ["         ","  /\\_/\\  "," ( -.- ) ","  > ^ <  "," /|   |\\ ","(_|   |_)"],
      ["         ","  /\\_/\\  "," ( -.- ) ","  > ^ <  "," /|   |\\ ","(_|   |_)"],
    ]},
    // Spinning planet
    { interval: 300, frames: [
      ["  .---.  "," /  |  \\ ","|  -+-  |"," \\  |  / ","  '---'  "],
      ["  .---.  "," / / / \\ ","|/ / /  |"," \\ / / / ","  '---'  "],
      ["  .---.  "," /--   \\ ","|---   |"," \\--   / ","  '---'  "],
      ["  .---.  "," / \\ \\ \\ ","|  \\ \\ \\|"," \\ \\ \\  /","  '---'  "],
    ]},
    // Rain on window
    { interval: 350, frames: [
      [" .------."," | '  ' |"," |  '   |"," |'   ' |"," | ' '  |"," '------'"],
      [" .------."," |  ' ' |"," | '  ' |"," |  '   |"," |'   ' |"," '------'"],
      [" .------."," |'   ' |"," |  ' ' |"," | '  ' |"," |  '   |"," '------'"],
    ]},
    // Pendulum clock
    { interval: 500, frames: [
      [" .-----. "," | 12  | "," |9  3 | "," | 6/  | "," '-----' ","   \\     ","    *    "],
      [" .-----. "," | 12  | "," |9  3 | "," | 6|  | "," '-----' ","    |    ","    *    "],
      [" .-----. "," | 12  | "," |9  3 | "," | 6 \\ | "," '-----' ","     /   ","    *    "],
      [" .-----. "," | 12  | "," |9  3 | "," | 6|  | "," '-----' ","    |    ","    *    "],
    ]},
    // Lava lamp
    { interval: 600, frames: [
      ["  ____   ","  |  |   ","  | O|   ","  |  |   ","  |o |   ","  | O|   ","  |__|   "],
      ["  ____   ","  | o|   ","  |  |   ","  |O |   ","  |  |   ","  |o |   ","  |__|   "],
      ["  ____   ","  |  |   ","  |o |   ","  |  |   ","  | O|   ","  |  |   ","  |__|   "],
      ["  ____   ","  |O |   ","  |  |   ","  | o|   ","  |  |   ","  | O|   ","  |__|   "],
    ]},
    // Windmill
    { interval: 400, frames: [
      ["    |    ","    |    ","----+----","    |    ","    |    ","   /|\\   ","  / | \\  "],
      ["  \\ | /  ","   \\|/   ","    +    ","   /|\\   ","  / | \\  ","   /|\\   ","  / | \\  "],
      ["    |    ","    |    ","----+----","    |    ","    |    ","   /|\\   ","  / | \\  "],
      ["  / | \\  ","   /|\\   ","    +    ","   \\|/   ","  \\ | /  ","   /|\\   ","  / | \\  "],
    ]},
    // Fish tank
    { interval: 500, frames: [
      [" .-------."," |  ><>  |"," |       |"," | <><   |"," |    ~~ |"," '-------'"],
      [" .-------."," |   ><> |"," |       |"," |  <><  |"," |   ~~  |"," '-------'"],
      [" .-------."," |    ><>|"," |       |"," |   <>< |"," |  ~~   |"," '-------'"],
      [" .-------."," |   ><> |"," |       |"," |  <><  |"," |   ~~  |"," '-------'"],
    ]},
    // Constellation
    { interval: 700, frames: [
      ["  *   .  ","    .    "," .    *  ","   *     ","      .  "," .  *    ","    .   *"],
      ["  .   *  ","    .    "," *    .  ","   .     ","      *  "," *  .    ","    *   ."],
      ["  *   .  ","    *    "," .    *  ","   *     ","      .  "," .  *    ","    .   *"],
    ]},
    // Music notes
    { interval: 450, frames: [
      ["    \u266A    ","  \u266B     ","      \u266A  "," \u266A      ","         ","   \u266B    ","         "],
      ["         ","    \u266A    ","  \u266B     ","      \u266A  "," \u266A      ","         ","   \u266B    "],
      ["   \u266B    ","         ","    \u266A    ","  \u266B     ","      \u266A  "," \u266A      ","         "],
    ]},
    // Steam from mug
    { interval: 500, frames: [
      ["  )  )   ","   (  (  ","  )  )   ","         ","  .---. /"," |     | ","  '---'  "],
      ["   (  (  ","  )  )   ","   (  (  ","         ","  .---. /"," |     | ","  '---'  "],
      ["  )  )   ","   ) )   ","  (  (   ","         ","  .---. /"," |     | ","  '---'  "],
    ]},
  ]; }

  let artInterval = null;

  function startAsciiArt(sessionId) {
    const el = document.getElementById("replay-ascii-art");
    if (!el) return;
    if (artInterval) { clearInterval(artInterval); artInterval = null; }

    const rng = seededRng(sessionId || "default");
    const animations = getAsciiAnimations();
    const anim = animations[Math.floor(rng() * animations.length)];

    let frame = 0;
    function draw() {
      el.textContent = anim.frames[frame].join("\n");
      frame = (frame + 1) % anim.frames.length;
    }
    draw();
    artInterval = setInterval(draw, anim.interval);
  }

  function stopAsciiArt() {
    if (artInterval) { clearInterval(artInterval); artInterval = null; }
  }

  // --- Narration engine ---

  // Phrase banks keyed by mood
  const OPENERS = [
    "okay so first we dove into",
    "started off with",
    "right, so first thing \u2014",
    "jumped straight into",
    "alright so we kicked off with",
    "first up was",
  ];
  const MIDDLES = [
    "then we got into",
    "after that, moved on to",
    "next thing you know we're doing",
    "then pivoted to",
    "okay then we tackled",
    "cool, then shifted to",
    "from there went into",
    "then it was time for",
  ];
  const CLOSERS = [
    "and to wrap it all up,",
    "last stretch \u2014",
    "and finally,",
    "finished strong with",
    "home stretch:",
    "one more thing before done \u2014",
  ];
  const SMOOTH = [
    "Smooth sailing.",
    "No issues, just vibes.",
    "Clean run.",
    "Went like butter.",
    "No drama.",
    "Textbook.",
  ];
  const GRINDY = [
    "This one took a minute ngl.",
    "Lot of back and forth here.",
    "Bit of a grind.",
    "Really had to dig in.",
    "Put in the work on this one.",
    "Kept at it.",
  ];
  const ROUGH = [
    "Hit some errors along the way.",
    "Bumpy ride, had to debug.",
    "Ran into trouble on this one.",
    "Things got spicy.",
    "Had to fight through errors.",
  ];
  const QUICK = [
    "Quick one.",
    "In and out.",
    "Done in a flash.",
    "Barely blinked.",
  ];

  function narrateFromTopics(topics, sessionId) {
    const rng = seededRng(sessionId || "x");
    const maxDur = Math.max(...topics.map(t => t.durMs || 1));
    const barMax = 20;
    let html = "";

    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      const dur = t.durMs || 1;
      const barLen = maxDur > 0 ? Math.max(1, Math.round((dur / maxDur) * barMax)) : 1;
      const bar = "\u2588".repeat(barLen) + "\u2591".repeat(barMax - barLen);

      const stats = [];
      if (t.edits) stats.push(`${t.edits}e`);
      if (t.reads) stats.push(`${t.reads}r`);
      if (t.execs) stats.push(`${t.execs}x`);
      const statStr = stats.join(" ");

      const m = (t.mood || "").trim();
      const icon = m === "rough" ? " \u26A1" : m === "grindy" ? " \u2026" : "";
      let comment = "";
      if (m === "rough") comment = pick(rng, ROUGH);
      else if (m === "grindy") comment = pick(rng, GRINDY);
      else if (m === "quick") comment = pick(rng, QUICK);

      const durStr = (t.durLabel || "").padStart(5);

      html += `<div class="rn-topic">`;
      html += `<div class="rn-bar">${bar} ${durStr}${icon}</div>`;
      html += `<div class="rn-label">${esc(t.label)}</div>`;
      if (statStr || comment) {
        html += `<div class="rn-meta">${statStr}${comment ? `<span class="rn-comment">${esc(comment)}</span>` : ""}</div>`;
      }
      html += `</div>`;
    }

    return html;
  }

  async function fetchSessionTopics(sessionId) {
    const narrEl = document.getElementById("replay-narration");
    try {
      const resp = await fetch("/api/session-topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await resp.json();
      if (data.topics && data.topics.length > 0) {
        const topics = data.topics.map(t => ({
          label: t.title,
          durLabel: t.durLabel || "",
          durMs: t.durMs || 0,
          edits: t.edits || 0,
          reads: t.reads || 0,
          execs: t.execs || 0,
          mood: t.mood || "smooth",
        }));
        if (narrEl) narrEl.innerHTML = narrateFromTopics(topics, sessionId);
      } else {
        if (narrEl) narrEl.textContent = data.error || "no topics found";
      }
    } catch (err) {
      if (narrEl) narrEl.textContent = "failed to classify topics";
    }
  }

  function fmtDur(ms) {
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
