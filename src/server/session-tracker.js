// Session tracking — extracted from index.js
const { extractSessionId: _extractSid, extractSessionLabel: _extractLabel } = require("../shared/session-extract");

const knownSessions = new Map(); // sessionId -> { label, lastEventTs }

let _broadcast = null;

function extractSessionFromLine(line) {
  try {
    const obj = JSON.parse(line);
    const sessionId = _extractSid(obj);
    if (!sessionId) return null;
    const label = _extractLabel(obj) || sessionId.slice(0, 8);
    return { id: sessionId, label };
  } catch {
    return null;
  }
}

function trackSession(line) {
  const info = extractSessionFromLine(line);
  if (!info) return;
  knownSessions.set(info.id, { label: info.label, lastEventTs: Date.now() });
}

function getSessionsList() {
  return [...knownSessions.entries()].map(([id, info]) => ({ id, label: info.label }));
}

function init(broadcastFn) {
  _broadcast = broadcastFn;

  // Prune sessions with no events for 5+ minutes
  setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, info] of knownSessions) {
      if (info.lastEventTs < cutoff) {
        knownSessions.delete(id);
        if (_broadcast) _broadcast(JSON.stringify({ type: "session_remove", id }));
      }
    }
  }, 30000);
}

module.exports = { init, trackSession, getSessionsList, knownSessions };
