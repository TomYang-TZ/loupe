// replay-template.js — generates self-contained HTML for session replay
"use strict";

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

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMarkdownToHtml(text) {
  if (!text) return "";
  let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Fenced code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre class="md-code-block"><code>${code.trimEnd()}</code></pre>`);
  // Tables
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split("\n").filter(r => r.trim());
    if (rows.length < 2) return tableBlock;
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
  // Inline
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Progress bars
  html = html.replace(/^(\s*)(\u2588+\u2591*)\s*(.*)$/gm,
    '<div style="font-family:monospace;font-size:10px;color:var(--text-muted)">$1<span style="color:#06b6d4">$2</span> $3</div>');
  // Block formatting
  html = html.replace(/\n\n/g, "<br><br>");
  html = html.replace(/\n- /g, "<br>\u2022 ");
  html = html.replace(/\n(\d+)\. /g, "<br>$1. ");
  return html;
}

/**
 * Build a self-contained HTML replay page.
 * @param {object} data
 * @param {string} data.sessionLabel
 * @param {string} data.sessionId
 * @param {string} data.startTime - ISO string
 * @param {string} data.endTime - ISO string
 * @param {number} data.totalDuration - ms
 * @param {Array} data.topics - [{ title, durLabel, durMs, edits, reads, execs, mood }]
 * @param {Array} data.timeline - [{ n, type, text, tool, detail, ts }]
 * @param {string} data.analysis - markdown string
 * @param {string} data.theme - "dark" | "light"
 * @returns {string} - complete HTML document
 */
function buildReplayHtml(data) {
  const {
    sessionLabel, sessionId, startTime, endTime, totalDuration,
    topics, timeline, analysis, theme,
  } = data;

  const totalDurStr = fmtDur(totalDuration);
  const startStr = startTime ? new Date(startTime).toLocaleString() : "—";
  const endStr = endTime ? new Date(endTime).toLocaleString() : "—";

  // --- Build topic narration HTML ---
  const maxDur = Math.max(...(topics || []).map(t => t.durMs || 1), 1);
  const barMax = 20;
  let topicsHtml = "";
  for (const t of (topics || [])) {
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
    const durStr = (t.durLabel || "").padStart(5);
    topicsHtml += `<div class="rn-topic">`;
    topicsHtml += `<div class="rn-bar">${bar} ${durStr}${icon}</div>`;
    topicsHtml += `<div class="rn-label">${esc(t.title)}</div>`;
    if (statStr) topicsHtml += `<div class="rn-meta">${statStr}</div>`;
    topicsHtml += `</div>`;
  }

  // --- Build event log HTML ---
  let timelineHtml = "";
  if (timeline && timeline.length > 0) {
    const userCount = timeline.filter(t => t.type === "user").length;
    const toolCount = timeline.filter(t => t.type === "tool").length;
    const errCount = timeline.filter(t => t.type === "error").length;
    timelineHtml += `<div class="tl-summary">${timeline.length} entries &middot; ${userCount} queries &middot; ${toolCount} tools${errCount ? ` &middot; <span style="color:#ef4444">${errCount} errors</span>` : ""}</div>`;

    // Group by user query
    let currentGroup = null;
    const groups = [];
    for (const item of timeline) {
      if (item.type === "user") {
        currentGroup = { query: item, children: [] };
        groups.push(currentGroup);
      } else if (currentGroup) {
        currentGroup.children.push(item);
      } else {
        groups.push({ query: null, children: [item] });
      }
    }

    for (const group of groups) {
      if (group.query) {
        timelineHtml += `<details class="tl-group" open>`;
        timelineHtml += `<summary class="tl-entry tl-user"><span class="tl-num">${group.query.n}</span><span class="tl-badge tl-badge-user">Q</span><span class="tl-text">${esc(group.query.text || "")}</span></summary>`;
        for (const item of group.children) {
          const badge = item.type === "think" ? "T" : item.type === "tool" ? (item.tool || "USE") : item.type === "error" ? "ERR" : "TXT";
          const badgeClass = `tl-badge-${item.type}`;
          const text = item.text || item.detail || "";
          const displayText = text.replace(/\/[\w./-]+\/([\w.-]+)/g, "$1");
          timelineHtml += `<div class="tl-entry tl-${item.type}"><span class="tl-num">${item.n}</span><span class="tl-badge ${badgeClass}">${esc(badge)}</span><span class="tl-text" title="${esc(text)}">${esc(displayText)}</span></div>`;
        }
        timelineHtml += `</details>`;
      } else {
        for (const item of group.children) {
          const badge = item.type === "think" ? "T" : item.type === "tool" ? (item.tool || "USE") : item.type === "error" ? "ERR" : "TXT";
          timelineHtml += `<div class="tl-entry tl-${item.type}"><span class="tl-num">${item.n}</span><span class="tl-badge tl-badge-${item.type}">${esc(badge)}</span><span class="tl-text">${esc(item.text || item.detail || "")}</span></div>`;
        }
      }
    }
  } else {
    timelineHtml = '<div class="tl-empty">No timeline data</div>';
  }

  // --- Build analysis HTML ---
  const analysisHtml = analysis ? renderMarkdownToHtml(analysis) : '<div style="color:var(--text-muted);padding:20px;text-align:center">No analysis available</div>';

  // --- Summary stats ---
  const totalTopics = (topics || []).length;
  const totalEdits = (topics || []).reduce((s, t) => s + (t.edits || 0), 0);
  const totalReads = (topics || []).reduce((s, t) => s + (t.reads || 0), 0);
  const totalExecs = (topics || []).reduce((s, t) => s + (t.execs || 0), 0);

  // --- ASCII art animations (inline JS) ---
  // Embed the same animations, seeded from sessionId
  const asciiAnimationsJson = JSON.stringify([
    { interval: 400, frames: [
      ["     (  ","    ) ( )","   ( ) ( ","    )  ) ","   .^^^. ","   |   | ","   '---' "],
      ["    ) ( ","   ( ) ( ","    ) )  ","   (  (  ","   .^^^. ","   |   | ","   '---' "],
      ["   (  ) ","    )(   ","   ) ( ) ","    )(   ","   .^^^. ","   |   | ","   '---' "],
    ]},
    { interval: 500, frames: [
      ["         ","~._.~._.~","_.~._.~._","~._.~._.~","   __/|  ","  /  __|_","_/______\\"],
      ["         ","._.~._.~.","~._.~._.~","_.~._.~._","   __/|  ","  /  __|_","_/______\\"],
      ["         ","_.~._.~._","~._.~._.~","._.~._.~.","   __/|  ","  /  __|_","_/______\\"],
    ]},
    { interval: 800, frames: [
      ["         ","  /\\_/\\  "," ( o.o ) ","  > ^ <  "," /|   |\\ ","(_|   |_)"],
      ["         ","  /\\_/\\  "," ( -.- ) ","  > ^ <  "," /|   |\\ ","(_|   |_)"],
      ["         ","  /\\_/\\  "," ( o.o ) ","  > ^ <  "," /|   |\\ ","(_|   |_)"],
      ["         ","  /\\_/\\  "," ( -.- ) ","  > ^ <  "," /|   |\\ ","(_|   |_)"],
      ["         ","  /\\_/\\  "," ( -.- ) ","  > ^ <  "," /|   |\\ ","(_|   |_)"],
    ]},
    { interval: 300, frames: [
      ["  .---.  "," /  |  \\ ","|  -+-  |"," \\  |  / ","  '---'  "],
      ["  .---.  "," / / / \\ ","|/ / /  |"," \\ / / / ","  '---'  "],
      ["  .---.  "," /--   \\ ","|---   |"," \\--   / ","  '---'  "],
      ["  .---.  "," / \\ \\ \\ ","|  \\ \\ \\|"," \\ \\ \\  /","  '---'  "],
    ]},
    { interval: 350, frames: [
      [" .------."," | '  ' |"," |  '   |"," |'   ' |"," | ' '  |"," '------'"],
      [" .------."," |  ' ' |"," | '  ' |"," |  '   |"," |'   ' |"," '------'"],
      [" .------."," |'   ' |"," |  ' ' |"," | '  ' |"," |  '   |"," '------'"],
    ]},
    { interval: 500, frames: [
      [" .-----. "," | 12  | "," |9  3 | "," | 6/  | "," '-----' ","   \\     ","    *    "],
      [" .-----. "," | 12  | "," |9  3 | "," | 6|  | "," '-----' ","    |    ","    *    "],
      [" .-----. "," | 12  | "," |9  3 | "," | 6 \\ | "," '-----' ","     /   ","    *    "],
      [" .-----. "," | 12  | "," |9  3 | "," | 6|  | "," '-----' ","    |    ","    *    "],
    ]},
    { interval: 600, frames: [
      ["  ____   ","  |  |   ","  | O|   ","  |  |   ","  |o |   ","  | O|   ","  |__|   "],
      ["  ____   ","  | o|   ","  |  |   ","  |O |   ","  |  |   ","  |o |   ","  |__|   "],
      ["  ____   ","  |  |   ","  |o |   ","  |  |   ","  | O|   ","  |  |   ","  |__|   "],
      ["  ____   ","  |O |   ","  |  |   ","  | o|   ","  |  |   ","  | O|   ","  |__|   "],
    ]},
    { interval: 500, frames: [
      [" .-------."," |  ><>  |"," |       |"," | <><   |"," |    ~~ |"," '-------'"],
      [" .-------."," |   ><> |"," |       |"," |  <><  |"," |   ~~  |"," '-------'"],
      [" .-------."," |    ><>|"," |       |"," |   <>< |"," |  ~~   |"," '-------'"],
      [" .-------."," |   ><> |"," |       |"," |  <><  |"," |   ~~  |"," '-------'"],
    ]},
    { interval: 700, frames: [
      ["  *   .  ","    .    "," .    *  ","   *     ","      .  "," .  *    ","    .   *"],
      ["  .   *  ","    .    "," *    .  ","   .     ","      *  "," *  .    ","    *   ."],
      ["  *   .  ","    *    "," .    *  ","   *     ","      .  "," .  *    ","    .   *"],
    ]},
    { interval: 500, frames: [
      ["  )  )   ","   (  (  ","  )  )   ","         ","  .---. /"," |     | ","  '---'  "],
      ["   (  (  ","  )  )   ","   (  (  ","         ","  .---. /"," |     | ","  '---'  "],
      ["  )  )   ","   ) )   ","  (  (   ","         ","  .---. /"," |     | ","  '---'  "],
    ]},
  ]);

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Session Replay — ${esc(sessionLabel)}</title>
<style>
/* Dark theme (default) */
:root, [data-theme="dark"] {
  --bg: #0f1115;
  --surface: #16181d;
  --border: rgba(255,255,255,0.08);
  --text: #e4e4e7;
  --text-muted: #71717a;
  --text-dim: #52525b;
  --hover-bg: rgba(255,255,255,0.03);
  --text-border-subtle: rgba(255,255,255,0.1);
  --content-text: rgba(255,248,240,0.85);
  --content-heading: rgba(255,248,240,0.95);
  --content-dim: rgba(255,248,240,0.7);
  --code-bg: rgba(255,255,255,0.06);
  --code-block-bg: rgba(0,0,0,0.25);
  --code-block-border: rgba(255,255,255,0.06);
  --table-border: rgba(255,255,255,0.08);
  --table-header-bg: rgba(255,255,255,0.04);
  --badge-text-bg: rgba(255,255,255,0.06);
}
/* Light theme */
[data-theme="light"] {
  --bg: #ffffff;
  --surface: #fafbfc;
  --border: rgba(0,0,0,0.08);
  --text: #18181b;
  --text-muted: #a1a1aa;
  --text-dim: #d4d4d8;
  --hover-bg: rgba(0,0,0,0.02);
  --text-border-subtle: rgba(0,0,0,0.06);
  --content-text: rgba(0,0,0,0.8);
  --content-heading: rgba(0,0,0,0.9);
  --content-dim: rgba(0,0,0,0.65);
  --code-bg: rgba(0,0,0,0.05);
  --code-block-bg: rgba(0,0,0,0.04);
  --code-block-border: rgba(0,0,0,0.08);
  --table-border: rgba(0,0,0,0.08);
  --table-header-bg: rgba(0,0,0,0.03);
  --badge-text-bg: rgba(0,0,0,0.04);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;
  background: var(--bg);
  color: var(--text);
  font-size: 11px;
  line-height: 1.5;
  overflow-x: hidden;
}

/* Header */
.header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.header-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.header-meta {
  font-size: 10px;
  color: var(--text-muted);
}
.header-dur {
  font-weight: 600;
  color: #06b6d4;
  margin-left: auto;
  font-size: 12px;
}

/* ASCII art section */
.ascii-section {
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 0;
  max-height: 260px;
  overflow-y: auto;
}
.ascii-art {
  font: 400 10px "SF Mono", "JetBrains Mono", Menlo, monospace;
  color: var(--text-muted);
  padding: 8px 8px 8px 12px;
  white-space: pre;
  line-height: 1.3;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  min-width: 80px;
}
.narration {
  padding: 8px 12px;
  flex: 1;
  overflow-y: auto;
}
.rn-topic { margin-bottom: 10px; }
.rn-bar {
  font: 400 11px "SF Mono", "JetBrains Mono", Menlo, monospace;
  color: var(--text-muted);
  line-height: 1.4;
}
.rn-label {
  font: 500 11px "SF Mono", "JetBrains Mono", Menlo, monospace;
  color: var(--text);
  line-height: 1.4;
}
.rn-meta {
  font: 400 10px "SF Mono", "JetBrains Mono", Menlo, monospace;
  color: var(--text-muted);
  line-height: 1.4;
}

/* Event log */
.event-log {
  border-bottom: 1px solid var(--border);
  max-height: 300px;
  overflow-y: auto;
  padding: 4px 0;
}
.section-title {
  font: 500 11px "SF Mono", monospace;
  color: var(--text-muted);
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.tl-summary {
  padding: 8px 10px;
  color: var(--text-muted);
  font-size: 10px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.tl-group { margin: 0; }
.tl-group > summary { list-style: none; cursor: pointer; }
.tl-group > summary::-webkit-details-marker { display: none; }
.tl-group > summary::before { content: "\\25BE "; font-size: 8px; color: var(--text-dim); }
.tl-group[open] > summary::before { content: "\\25B4 "; }
.tl-entry {
  display: flex;
  gap: 4px;
  padding: 2px 8px;
  font: 400 9px "SF Mono", monospace;
  color: var(--text-muted);
  line-height: 1.5;
  border-left: 2px solid transparent;
}
.tl-entry:hover { background: var(--hover-bg); }
.tl-entry.tl-user {
  border-left-color: #8b5cf6;
  color: var(--text);
  font-weight: 500;
  padding-top: 8px;
  margin-top: 4px;
}
.tl-entry.tl-think { border-left-color: rgba(139,92,246,0.3); font-style: italic; }
.tl-entry.tl-tool { border-left-color: rgba(6,182,212,0.4); }
.tl-entry.tl-error { border-left-color: #ef4444; color: #ef4444; }
.tl-entry.tl-text { border-left-color: var(--text-border-subtle); }
.tl-num {
  color: var(--text-dim);
  width: 20px;
  text-align: right;
  flex-shrink: 0;
  font-size: 8px;
  padding-top: 1px;
}
.tl-badge {
  font-size: 7px;
  font-weight: 600;
  padding: 1px 3px;
  border-radius: 2px;
  flex-shrink: 0;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  white-space: nowrap;
}
.tl-badge-user { background: rgba(139,92,246,0.15); color: #a78bfa; }
.tl-badge-think { background: rgba(139,92,246,0.08); color: #8b5cf6; }
.tl-badge-tool { background: rgba(6,182,212,0.12); color: #06b6d4; }
.tl-badge-error { background: rgba(239,68,68,0.12); color: #ef4444; }
.tl-badge-text { background: var(--badge-text-bg); color: var(--text-muted); }
.tl-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-empty {
  color: var(--text-muted);
  text-align: center;
  padding: 20px;
}

/* Analysis */
.analysis {
  padding: 16px 20px;
}
.analysis-content {
  font-size: 12px;
  line-height: 1.65;
  color: var(--content-text);
  white-space: pre-wrap;
  word-break: break-word;
}
.analysis-content h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 16px 0 6px 0;
  color: var(--content-heading);
}
.analysis-content h4 {
  font-size: 11px;
  margin: 10px 0 4px;
  color: var(--content-dim);
}
.analysis-content strong {
  color: var(--content-heading);
}
.analysis-content code {
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--code-bg);
}
.analysis-content .md-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
  margin: 6px 0;
}
.analysis-content .md-table th,
.analysis-content .md-table td {
  padding: 4px 8px;
  border: 1px solid var(--table-border);
  text-align: left;
}
.analysis-content .md-table th {
  background: var(--table-header-bg);
  font-weight: 600;
}
.analysis-content .md-code-block {
  background: var(--code-block-bg);
  border: 1px solid var(--code-block-border);
  border-radius: 4px;
  padding: 8px 10px;
  margin: 6px 0;
  font-size: 10px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Footer */
.footer {
  border-top: 1px solid var(--border);
  padding: 12px 20px;
  display: flex;
  gap: 16px;
  color: var(--text-muted);
  font-size: 10px;
  flex-wrap: wrap;
}
.footer-stat { display: flex; gap: 4px; }
.footer-val { font-weight: 600; color: var(--text); }
</style>
</head>
<body>

<!-- 1. Header -->
<div class="header">
  <span class="header-title">Session Replay</span>
  <span class="header-meta">${esc(sessionLabel)} &middot; ${esc(startStr)} \u2192 ${esc(endStr)}</span>
  <span class="header-dur">${esc(totalDurStr)}</span>
</div>

<!-- 2. ASCII art + Narrated timeline -->
<div class="ascii-section">
  <pre class="ascii-art" id="ascii-art"></pre>
  <div class="narration">
    ${topicsHtml || '<div style="color:var(--text-muted);padding:8px">No topics classified</div>'}
  </div>
</div>

<!-- 3. Event Log -->
<div class="section-title">Event Log</div>
<div class="event-log">
  ${timelineHtml}
</div>

<!-- 4. Analysis -->
<div class="section-title">Analysis</div>
<div class="analysis">
  <div class="analysis-content">${analysisHtml}</div>
</div>

<!-- 5. Footer -->
<div class="footer">
  <div class="footer-stat"><span>Topics:</span> <span class="footer-val">${totalTopics}</span></div>
  <div class="footer-stat"><span>Duration:</span> <span class="footer-val">${esc(totalDurStr)}</span></div>
  <div class="footer-stat"><span>Edits:</span> <span class="footer-val">${totalEdits}</span></div>
  <div class="footer-stat"><span>Reads:</span> <span class="footer-val">${totalReads}</span></div>
  <div class="footer-stat"><span>Execs:</span> <span class="footer-val">${totalExecs}</span></div>
</div>

<!-- ASCII art animation (inline JS) -->
<script>
(function() {
  var animations = ${asciiAnimationsJson};
  var sid = ${JSON.stringify(sessionId || "default")};

  function seededRng(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    var s = h >>> 0;
    return function() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  }

  var rng = seededRng(sid);
  var anim = animations[Math.floor(rng() * animations.length)];
  var el = document.getElementById("ascii-art");
  var frame = 0;

  function draw() {
    el.textContent = anim.frames[frame].join("\\n");
    frame = (frame + 1) % anim.frames.length;
  }
  draw();
  setInterval(draw, anim.interval);

  // Theme from parent query param
  var params = new URLSearchParams(window.location.search);
  var theme = params.get("theme");
  if (theme) document.documentElement.setAttribute("data-theme", theme);
})();
</script>

</body>
</html>`;
}

module.exports = { buildReplayHtml };
