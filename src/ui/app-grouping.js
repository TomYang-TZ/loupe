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
        agentSessionMap: new Map(),  // childSessionId → agent node (for parallel agent routing)
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
    // Topic clear — reset all topic state, merge tasks back into one
    if (entry.category === "topic_clear") {
      const sid = entry.sessionId || "default";
      const gs = getGroupState(sid);
      if (gs.tasks.length > 1) {
        // Merge all tasks into one
        const allQueries = [];
        for (const task of gs.tasks) {
          for (const q of task.queries) allQueries.push(q);
        }
        gs.topicCounter++;
        gs.currentTask = { id: gs.topicCounter, seqNum: gs.topicCounter, startTs: allQueries[0]?.startTs || 0, endTs: allQueries[allQueries.length - 1]?.endTs || 0, queries: allQueries, el: null, bodyEl: null, headerEl: null };
        gs.tasks = [gs.currentTask];
      } else if (gs.tasks.length === 1) {
        gs.tasks[0].topicTitle = null;
        gs.tasks[0].el = null; gs.tasks[0].bodyEl = null; gs.tasks[0].headerEl = null;
      }
      delete gs._lastTopicQueryTs;
      return;
    }
    // Topic shift — retroactively split tasks at the topic boundary
    if (entry.category === "topic_shift") {
      const sid = entry.sessionId || "default";
      const gs = getGroupState(sid);
      // Skip topics for sessions with no queries (e.g., outside backlog window)
      const hasQueries = gs.tasks.some(t => t.queries.length > 0);
      if (!hasQueries) return;
      const title = entry.summary || entry.title || null;
      const splitTs = entry.ts;
      let handled = false;
      for (let ti = 0; ti < gs.tasks.length; ti++) {
        const task = gs.tasks[ti];
        const splitIdx = task.queries.findIndex(q => q.startTs >= splitTs);
        if (splitIdx > 0) {
          // Split: queries before splitIdx stay, queries from splitIdx go to new task
          const newQueries = task.queries.splice(splitIdx);
          task.endTs = task.queries.length > 0 ? task.queries[task.queries.length - 1].endTs : task.startTs;
          task.el = null; task.bodyEl = null; task.headerEl = null;
          gs.topicCounter++;
          const newTask = { id: gs.topicCounter, seqNum: gs.topicCounter, startTs: splitTs, endTs: newQueries.length > 0 ? newQueries[newQueries.length - 1].endTs : splitTs, queries: newQueries, el: null, bodyEl: null, headerEl: null, topicTitle: title };
          for (const q of newQueries) { q.el = null; q.actionsEl = null; q.headerEl = null; }
          gs.tasks.splice(ti + 1, 0, newTask);
          if (gs.currentTask === task && newQueries.includes(gs.currentQuery)) {
            gs.currentTask = newTask;
          }
          handled = true;
          break;
        } else if (splitIdx === 0) {
          // Topic starts at or before this task's first query
          if (task.topicTitle) {
            // Previous topic already claimed this task — push it to an empty task, reassign title
            gs.topicCounter++;
            const emptyTask = { id: gs.topicCounter, seqNum: gs.topicCounter, startTs: task.topicTitle === title ? splitTs : (task.startTs || splitTs), endTs: task.startTs || splitTs, queries: [], el: null, bodyEl: null, headerEl: null, topicTitle: task.topicTitle };
            task.topicTitle = title;
            task.el = null; task.bodyEl = null; task.headerEl = null;
            gs.tasks.splice(ti, 0, emptyTask);
          } else {
            task.topicTitle = title;
            task.el = null; task.bodyEl = null; task.headerEl = null;
          }
          handled = true;
          break;
        }
        // splitIdx === -1: all queries in this task are before splitTs, continue to next task
      }
      if (!handled && gs.tasks.length > 0) {
        // Topic starts after all existing queries — append empty task
        gs.topicCounter++;
        const emptyTask = { id: gs.topicCounter, seqNum: gs.topicCounter, startTs: splitTs, endTs: splitTs, queries: [], el: null, bodyEl: null, headerEl: null, topicTitle: title };
        gs.tasks.push(emptyTask);
      }

      // Track the last_query_ts so we can split out post-topic queries later
      const inner = (entry.json?._logstream_type && entry.json?.data) ? entry.json.data : entry.json;
      if (inner?.last_query_ts) gs._lastTopicQueryTs = inner.last_query_ts;
      return;
    }

    const sid = entry.sessionId || "default";
    const gs = getGroupState(sid);

    // user_query or thinking with userQuery = new query boundary
    // user_query always creates a boundary (new user prompt = previous turn done)
    // thinking only creates a boundary when NOT inside an agent (subagents think too)
    const insideAgent = gs.agentStack.length > 0;
    const isDuplicate = gs.currentQuery && entry.userQuery &&
      gs.currentQuery.userQuery === entry.userQuery;
    const isSystemPrompt = entry.userQuery && (entry.userQuery.includes("<task-notification>") || entry.userQuery.includes("<system-reminder>"));
    const isQueryBoundary = !isDuplicate && !isSystemPrompt && (
      (entry.category === "user_query" && entry.userQuery) ||
      (!insideAgent && entry.category === "thinking" && entry.userQuery)
    );
    if (isQueryBoundary) {
      // Close current agent stack (shouldn't happen, but defensive)
      gs.agentStack = [];
      gs.agentSessionMap.clear();

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

      // New task if: first query, gap > 5 min, or current task is a titled topic and query is after the topic boundary
      const afterTopicBoundary = gs.currentTask?.topicTitle && gs._lastTopicQueryTs && entry.ts > gs._lastTopicQueryTs;
      if (!gs.currentTask || (gs.currentTask.queries.length === 0 && gs.tasks.length === 0) || gap > TASK_GAP_MS || afterTopicBoundary) {
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
      gs.agentStack.push(ag);
      // Don't map agentSessionMap here — sub_agent fires from parent session.
      // Mapping happens lazily when the first child event arrives (see regular routing below).
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
            // Remove from session map
            for (const [sid, ag] of gs.agentSessionMap) {
              if (ag === item) { gs.agentSessionMap.delete(sid); break; }
            }
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

    // Regular entry: route to matching agent (by session_id), fallback to top-of-stack, then query
    // user_query should never nest inside agents
    if (gs.agentStack.length > 0 && entry.category !== "user_query") {
      const childSid = entry._originalSessionId;
      const isChildSession = childSid && childSid !== entry.sessionId;
      // Try session_id match first (handles parallel agents)
      let matchedAgent = isChildSession ? gs.agentSessionMap.get(childSid) : null;
      if (matchedAgent && !matchedAgent.resultEntry) {
        matchedAgent.children.push(entry);
      } else if (isChildSession && !matchedAgent) {
        // Lazy mapping: first event from a new child session → assign to first unmapped agent on stack
        let target = null;
        const mappedAgents = new Set(gs.agentSessionMap.values());
        for (const ag of gs.agentStack) {
          if (!mappedAgents.has(ag) && !ag.resultEntry) { target = ag; break; }
        }
        if (!target && gs.agentStack.length > 0) target = gs.agentStack[gs.agentStack.length - 1];
        if (target) {
          gs.agentSessionMap.set(childSid, target);
          target.children.push(entry);
        } else {
          gs.currentQuery.items.push(entry);
        }
      } else {
        gs.agentStack[gs.agentStack.length - 1].children.push(entry);
      }
    } else {
      gs.currentQuery.items.push(entry);
    }
    gs.currentQuery.endTs = entry.ts;
    gs.currentTask.endTs = entry.ts;
  }

  // Split post-topic queries into a standalone untitled task.
  // Called after backlog replay or after live topic_shift events.
  function finalizeTopics() {
    for (const [, gs] of sessionGroups) {
      if (!gs._lastTopicQueryTs) continue;
      const lastTask = gs.tasks[gs.tasks.length - 1];
      if (!lastTask || !lastTask.topicTitle) continue;
      const postIdx = lastTask.queries.findIndex(q => q.startTs > gs._lastTopicQueryTs);
      if (postIdx > 0) {
        const postQueries = lastTask.queries.splice(postIdx);
        lastTask.endTs = lastTask.queries.length > 0 ? lastTask.queries[lastTask.queries.length - 1].endTs : lastTask.startTs;
        lastTask.el = null; lastTask.bodyEl = null; lastTask.headerEl = null;
        gs.topicCounter++;
        const postTask = { id: gs.topicCounter, seqNum: gs.topicCounter, startTs: postQueries[0].startTs, endTs: postQueries[postQueries.length - 1].endTs, queries: postQueries, el: null, bodyEl: null, headerEl: null };
        for (const q of postQueries) { q.el = null; q.actionsEl = null; q.headerEl = null; }
        gs.tasks.push(postTask);
        if (gs.currentTask === lastTask && postQueries.includes(gs.currentQuery)) {
          gs.currentTask = postTask;
        }
      }
      // Keep _lastTopicQueryTs for afterTopicBoundary check on live queries
    }
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
    finalizeTopics,
    reset,
  };
})();
