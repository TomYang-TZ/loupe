"use strict";

// LoupeGrouping — Task/query grouping state and logic.
// Manages per-session grouping: tasks, queries, agent stacks.

const LoupeGrouping = (() => {

  const TASK_GAP_MS = 5 * 60 * 1000; // 5 minutes between queries = new topic
  let queryIdCounter = 0;

  // Per-session grouping state: sessionId -> GroupState
  const sessionGroups = new Map();

  const streamHiddenCategories = new Set(["Notification", "Stop", "permission_request", "permission_denied", "tool_rejected", "tool_approved_msg"]);
  // Categories that go into groups for state tracking but don't render as cards
  const streamNoRenderCategories = new Set(["post_tool"]);

  function getGroupState(sessionId) {
    if (!sessionGroups.has(sessionId)) {
      sessionGroups.set(sessionId, {
        tasks: [],
        currentTask: null,
        currentQuery: null,
        agentStack: [],   // stack of { agentEntry, children: [], el: null, childrenEl: null }
        topicCounter: 0,  // per-session topic numbering
      });
    }
    return sessionGroups.get(sessionId);
  }

  function assignToGroup(entry) {
    // Stream-hidden entries and session boundaries don't go into groups
    if (streamHiddenCategories.has(entry.category)) return;
    if (entry.category === "session_start" || entry.category === "session_end") {
      return; // don't assign to any group — rendered directly in the pane
    }

    const sid = entry.sessionId || "default";
    const gs = getGroupState(sid);

    // user_query or thinking with userQuery = new query boundary
    // But skip if the current query already has the same userQuery (dedup)
    // Also skip if we're inside an agent stack — sub-agent thinking/queries
    // should nest as agent children, not create new top-level queries
    const insideAgent = gs.agentStack.length > 0;
    const isDuplicate = gs.currentQuery && entry.userQuery &&
      gs.currentQuery.userQuery === entry.userQuery;
    const isSystemPrompt = entry.userQuery && (entry.userQuery.includes("<task-notification>") || entry.userQuery.includes("<system-reminder>"));
    const isQueryBoundary = !insideAgent && !isDuplicate && !isSystemPrompt && (
      (entry.category === "user_query" && entry.userQuery) ||
      (entry.category === "thinking" && entry.userQuery)
    );
    if (isQueryBoundary) {
      // Close current agent stack (shouldn't happen, but defensive)
      gs.agentStack = [];

      // If current query is a preamble (no userQuery), absorb its items into the new query
      // BUT only if the preamble items are temporally close (< 10s gap).
      // Otherwise they belong to the previous turn and should stay as a separate group.
      let preambleItems = null;
      if (gs.currentQuery && !gs.currentQuery.userQuery && gs.currentQuery.items.length > 0) {
        const lastPreambleTs = gs.currentQuery.endTs || 0;
        const gap = entry.ts - lastPreambleTs;
        if (gap < 10000) {
          // Close enough — absorb into new query
          preambleItems = gs.currentQuery.items;
        }
      }
      if (preambleItems && gs.currentTask) {
        // Remove the preamble query from the task
        const idx = gs.currentTask.queries.indexOf(gs.currentQuery);
        if (idx !== -1) gs.currentTask.queries.splice(idx, 1);
        // If the task is now empty and this is the only task, reuse it
        if (gs.currentTask.queries.length === 0) {
          gs.currentTask.startTs = entry.ts;
        }
      }

      const prevEndTs = gs.currentQuery ? gs.currentQuery.endTs : 0;
      const gap = entry.ts - prevEndTs;

      // New topic if first query or gap > 5 min
      if (!gs.currentTask || (gs.currentTask.queries.length === 0 && gs.tasks.length === 0) || gap > TASK_GAP_MS) {
        if (!gs.currentTask || gs.currentTask.queries.length > 0) {
          gs.topicCounter++;
          gs.currentTask = { id: gs.topicCounter, seqNum: gs.topicCounter, startTs: entry.ts, endTs: entry.ts, queries: [], el: null, bodyEl: null, headerEl: null };
          gs.tasks.push(gs.currentTask);
        }
      }

      // New query — include absorbed preamble items
      gs.currentQuery = { id: ++queryIdCounter, userQuery: entry.userQuery, thinkingEntry: entry.category === "thinking" ? entry : null, startTs: entry.ts, endTs: entry.ts, items: preambleItems || [], el: null, actionsEl: null, headerEl: null, collapsed: true };
      gs.currentTask.queries.push(gs.currentQuery);
      gs.currentTask.endTs = entry.ts;
      return;
    }

    // If thinking arrives after user_query already set the boundary, attach it as the thinkingEntry
    if (entry.category === "thinking" && entry.userQuery && gs.currentQuery && gs.currentQuery.userQuery === entry.userQuery) {
      gs.currentQuery.thinkingEntry = entry;
      // Don't return — let it fall through to be added as an item so the thinking text is accessible
    }

    // Ensure we have a current query (preamble)
    if (!gs.currentQuery) {
      if (!gs.currentTask) {
        gs.topicCounter++;
        gs.currentTask = { id: gs.topicCounter, seqNum: gs.topicCounter, startTs: entry.ts, endTs: entry.ts, queries: [], el: null, bodyEl: null, headerEl: null };
        gs.tasks.push(gs.currentTask);
      }
      gs.currentQuery = { id: ++queryIdCounter, userQuery: null, thinkingEntry: null, startTs: entry.ts, endTs: entry.ts, items: [], el: null, actionsEl: null, headerEl: null, collapsed: true };
      gs.currentTask.queries.push(gs.currentQuery);
    }

    // Sub-agent spawn: always add as top-level sibling under the query.
    // Subagents cannot spawn subagents, so nesting is never correct.
    if (entry.category === "sub_agent") {
      const ag = { agentEntry: entry, children: [], resultEntry: null, el: null, childrenEl: null };
      gs.agentStack = [ag]; // replace stack — only one active agent at a time
      gs.currentQuery.items.push(ag);
      gs.currentQuery.endTs = entry.ts;
      gs.currentTask.endTs = entry.ts;
      return;
    }

    // Sub-agent result: find the matching agent without a result yet
    if (entry.category === "sub_agent_result") {
      // Search all query items for an unresolved agent (no resultEntry yet)
      let matched = false;
      function findUnresolved(items) {
        for (const item of items) {
          if (item.agentEntry && !item.resultEntry) {
            item.resultEntry = entry;
            // Remove from agentStack if present
            const idx = gs.agentStack.indexOf(item);
            if (idx !== -1) gs.agentStack.splice(idx, 1);
            return true;
          }
          if (item.agentEntry && item.children) {
            if (findUnresolved(item.children)) return true;
          }
        }
        return false;
      }
      if (gs.currentQuery) matched = findUnresolved(gs.currentQuery.items);
      if (!matched) {
        // Orphan result, treat as regular item
        gs.currentQuery.items.push(entry);
      }
      gs.currentQuery.endTs = entry.ts;
      gs.currentTask.endTs = entry.ts;
      return;
    }

    // Regular entry: add to top-of-stack agent or current query
    // user_query should never nest inside agents — skip it as an agent child
    if (gs.agentStack.length > 0 && entry.category !== "user_query") {
      gs.agentStack[gs.agentStack.length - 1].children.push(entry);
    } else {
      gs.currentQuery.items.push(entry);
    }
    gs.currentQuery.endTs = entry.ts;
    gs.currentTask.endTs = entry.ts;
  }

  function reset() {
    sessionGroups.clear();
    queryIdCounter = 0;
  }

  return {
    TASK_GAP_MS,
    sessionGroups,
    streamHiddenCategories,
    streamNoRenderCategories,
    getGroupState,
    assignToGroup,
    reset,
  };
})();
