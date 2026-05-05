"use strict";

// LoupeRender — DOM rendering for grouped entries (tasks, queries, agents).

const LoupeRender = (() => {

  // Cross-module refs set via init()
  let _openModal = null;
  let _getContainerFor = null;
  let _shouldAutoScroll = null;
  let _scrollPaneToBottom = null;
  let _matchesFilter = null;
  let _matchesSearch = null;
  let _scheduleIntegrityRebuild = null;

  const esc = LoupeUtils.esc;
  const formatTime = LoupeUtils.formatTime;

  function badgeLabel(cat) {
    return LoupeModal.badgeLabel(cat);
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } catch (err) {
      console.warn("Fallback copy failed:", err);
    }
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  function formatTimeRange(startTs, endTs) {
    const s = formatTime(startTs);
    const e = formatTime(endTs);
    return s === e ? s : `${s}\u2013${e}`;
  }

  function countItemActions(items) {
    let count = 0;
    for (const item of items) {
      if (item.agentEntry) {
        count += 1 + item.children.length + (item.resultEntry ? 1 : 0);
      } else {
        count++;
      }
    }
    return count;
  }

  function renderEntry(entry) {
    const div = document.createElement("div");
    div.className = "log-entry";
    div.dataset.id = entry.id;
    div.dataset.category = entry.category;
    if (entry.sessionId) div.dataset.session = entry.sessionId;

    div.innerHTML = `
      <div class="entry-row">
        <span class="entry-badge cat-${entry.category}">${badgeLabel(entry.category)}</span>
        ${entry.title ? `<span class="entry-tool">${esc(entry.title)}</span>` : ""}
        <span class="entry-summary">${esc(entry.summary)}</span>
        <span class="entry-time">${formatTime(entry.ts)}</span>
      </div>
    `;

    div.addEventListener("click", () => _openModal(entry.id));
    return div;
  }

  function renderTaskHeader(task, displayNum) {
    const div = document.createElement("div");
    div.className = "task-header";
    const qCount = task.queries.length;
    const chevron = task.collapsed ? "\u25B6" : "\u25BC";
    const num = displayNum || task.seqNum;
    const label = task.topicTitle ? esc(task.topicTitle) : `Topic ${num}`;
    div.innerHTML = `<span class="task-chevron">${chevron}</span><span class="task-label">${label}</span><span class="task-time">${formatTimeRange(task.startTs, task.endTs)}</span><span class="task-qcount">${qCount} ${qCount === 1 ? "query" : "queries"}</span>`;
    return div;
  }

  function bindTaskHeaderClick(task) {
    task.headerEl.addEventListener("click", () => {
      const isCollapsed = task.bodyEl.classList.toggle("collapsed");
      task.headerEl.querySelector(".task-chevron").textContent = isCollapsed ? "\u25B6" : "\u25BC";
      task.collapsed = isCollapsed;
    });
  }

  function renderQueryHeader(query) {
    const div = document.createElement("div");
    div.className = "query-header";
    const actionCount = countItemActions(query.items);
    const qText = query.userQuery ? esc(query.userQuery) : "No user query found";
    const chevron = query.collapsed === false ? "\u25BC" : "\u25B6";
    div.innerHTML = `<span class="query-chevron">${chevron}</span><span class="query-badge">Q</span><span class="query-text-wrap"><span class="query-text">${qText}</span>${query.userQuery ? `<span class="query-tooltip">${esc(query.userQuery)}</span>` : ""}<span class="query-copied">Copied!</span></span><span class="query-count">${actionCount}</span><span class="query-time">${formatTimeRange(query.startTs, query.endTs)}</span>`;

    // Click on query text copies the full query
    if (query.userQuery) {
      const wrapEl = div.querySelector(".query-text-wrap");
      wrapEl.addEventListener("click", (e) => {
        e.stopPropagation();
        copyToClipboard(query.userQuery).then(() => {
          const copiedEl = wrapEl.querySelector(".query-copied");
          copiedEl.classList.add("visible");
          wrapEl.classList.add("just-copied");
          setTimeout(() => {
            copiedEl.classList.remove("visible");
            wrapEl.classList.remove("just-copied");
          }, 1000);
        });
      });
    }

    return div;
  }

  function renderAgentHeader(agentEntry) {
    const div = document.createElement("div");
    div.className = "agent-header";
    div.innerHTML = `<span class="agent-chevron">\u25B6</span><span class="entry-badge cat-sub_agent">AGENT</span><span class="agent-desc">${esc(agentEntry.title || agentEntry.summary || "Agent")}</span><span class="entry-time">${formatTime(agentEntry.ts)}</span>`;
    return div;
  }

  function renderAgentGroup(ag, matchFn) {
    const wrap = document.createElement("div");
    wrap.className = "agent-group";

    const header = renderAgentHeader(ag.agentEntry);
    wrap.appendChild(header);

    const childrenEl = document.createElement("div");
    childrenEl.className = "agent-children collapsed";

    for (const child of ag.children) {
      if (child.agentEntry) {
        // Nested agent
        const nested = renderAgentGroup(child, matchFn);
        if (nested) childrenEl.appendChild(nested);
      } else {
        if (matchFn && !matchFn(child)) continue;
        const el = renderEntry(child);
        childrenEl.appendChild(el);
        child.el = el;
      }
    }
    if (ag.resultEntry) {
      if (!matchFn || matchFn(ag.resultEntry)) {
        const resEl = renderEntry(ag.resultEntry);
        childrenEl.appendChild(resEl);
        ag.resultEntry.el = resEl;
      }
    }

    wrap.appendChild(childrenEl);

    // Chevron click: toggle collapse
    const chevronEl = header.querySelector(".agent-chevron");
    chevronEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const isCollapsed = childrenEl.classList.toggle("collapsed");
      chevronEl.textContent = isCollapsed ? "\u25B6" : "\u25BC";
    });

    // Click on badge/desc: open modal to see the agent prompt
    header.addEventListener("click", (e) => {
      e.stopPropagation();
      // If clicking the chevron, let its own handler deal with it
      if (e.target === chevronEl || e.target.closest(".agent-chevron")) return;
      _openModal(ag.agentEntry.id);
    });

    ag.el = wrap;
    ag.childrenEl = childrenEl;
    return wrap;
  }

  function renderQueryGroup(query, matchFn) {
    const wrap = document.createElement("div");
    wrap.className = "query-group";

    // Search filtering: check if this query or any of its items match
    const searchActive = _matchesSearch && !_matchesSearch({ raw: "", title: "", summary: "", userQuery: "" });
    let queryHit = false;
    if (searchActive) {
      // Check query text
      if (query.userQuery && _matchesSearch({ raw: "", title: "", summary: "", userQuery: query.userQuery })) queryHit = true;
      // Check items (title = tool name, summary = file/command)
      if (!queryHit) {
        for (const item of query.items) {
          if (item.agentEntry) {
            if (item.children.some(c => _matchesSearch(c))) { queryHit = true; break; }
          } else {
            if (_matchesSearch(item)) { queryHit = true; break; }
          }
        }
      }
    }

    // When search is active, hide non-matching queries entirely
    if (searchActive && !queryHit) {
      wrap.style.display = "none";
      query.el = wrap; query.actionsEl = null; query.headerEl = null;
      return wrap;
    }

    const isCollapsed = query.collapsed !== false;

    const header = renderQueryHeader(query);
    wrap.appendChild(header);

    const actionsEl = document.createElement("div");
    actionsEl.className = isCollapsed ? "query-actions collapsed" : "query-actions";

    for (const item of query.items) {
      if (item.agentEntry) {
        const agEl = renderAgentGroup(item, queryHit ? null : matchFn);
        if (agEl) actionsEl.appendChild(agEl);
      } else {
        if (!queryHit && matchFn && !matchFn(item)) continue;
        const el = renderEntry(item);
        actionsEl.appendChild(el);
        item.el = el;
      }
    }

    wrap.appendChild(actionsEl);


    header.addEventListener("click", (e) => {
      e.stopPropagation();
      const nowCollapsed = actionsEl.classList.toggle("collapsed");
      header.querySelector(".query-chevron").textContent = nowCollapsed ? "\u25B6" : "\u25BC";
      query.collapsed = nowCollapsed;
    });

    // Double-click opens thinking entry modal
    if (query.thinkingEntry) {
      header.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        _openModal(query.thinkingEntry.id);
      });
    }

    query.el = wrap;
    query.actionsEl = actionsEl;
    query.headerEl = header;
    return wrap;
  }

  function renderTaskGroup(task, matchFn, prevTask) {
    const wrap = document.createElement("div");
    wrap.className = "task-group";
    // Add separator when untitled task follows a titled one
    if (!task.topicTitle && prevTask?.topicTitle) {
      wrap.style.marginTop = "12px";
      wrap.style.borderTop = "1px solid rgba(128,128,128,0.15)";
      wrap.style.paddingTop = "8px";
    }

    // Render topic header if this task has a topic title
    if (task.topicTitle) {
      const headerEl = renderTaskHeader(task, task._displayNum);
      wrap.appendChild(headerEl);
      task.headerEl = headerEl;

      // Click header to toggle collapse
      headerEl.addEventListener("click", () => {
        task.collapsed = !task.collapsed;
        const chevron = headerEl.querySelector(".task-chevron");
        if (chevron) chevron.textContent = task.collapsed ? "\u25B6" : "\u25BC";
        bodyEl.style.display = task.collapsed ? "none" : "";
      });
    }

    const bodyEl = document.createElement("div");
    bodyEl.className = "task-body";

    for (const query of task.queries) {
      const qEl = renderQueryGroup(query, matchFn);
      bodyEl.appendChild(qEl);
    }

    wrap.appendChild(bodyEl);

    task.el = wrap;
    task.bodyEl = bodyEl;
    return wrap;
  }

  // Render all grouped entries for a given session into a container
  // topicOffset: starting topic number (for multi-session rendering in same container)
  function renderGroupedEntries(container, sessionId, topicOffset) {
    const gs = LoupeGrouping.sessionGroups.get(sessionId);
    if (!gs) return { matchCount: 0, topicCount: 0 };

    const matchFn = (entry) => _matchesFilter(entry) && _matchesSearch(entry);
    let matchCount = 0;
    const base = topicOffset || 0;

    for (let i = 0; i < gs.tasks.length; i++) {
      const task = gs.tasks[i];
      task._displayNum = base + i + 1; // sequential display number
      const prevTask = i > 0 ? gs.tasks[i - 1] : null;
      const taskEl = renderTaskGroup(task, matchFn, prevTask);
      container.appendChild(taskEl);
      // Count matching queries
      if (_matchesSearch) {
        for (const query of task.queries) {
          let hit = false;
          if (query.userQuery && _matchesSearch({ raw: "", title: "", summary: "", userQuery: query.userQuery })) hit = true;
          if (!hit) {
            for (const item of query.items) {
              if (item.agentEntry) { if (item.children.some(c => _matchesSearch(c))) { hit = true; break; } }
              else { if (_matchesSearch(item)) { hit = true; break; } }
            }
          }
          if (hit) matchCount++;
        }
      }
    }

    return { matchCount, topicCount: gs.tasks.length };
  }

  // Real-time append: insert entry into its correct grouped DOM position
  function appendEntryGrouped(entry) {
    const container = _getContainerFor(entry);
    if (!container || !container.isConnected) {
      // Container missing or detached — schedule a full pane rebuild to recover
      _scheduleIntegrityRebuild();
      return;
    }

    const empty = container.querySelector(".empty-state");
    if (empty) empty.remove();

    // Session boundaries are rendered directly, not inside query groups
    if (entry.category === "session_start" || entry.category === "session_end") {
      const el = renderEntry(entry);
      el.classList.add("session-divider");
      el.classList.add("flash");
      entry.el = el;
      container.appendChild(el);
      if (_shouldAutoScroll(entry)) _scrollPaneToBottom(entry);
      return;
    }

    const sid = entry.sessionId || "default";
    const gs = LoupeGrouping.sessionGroups.get(sid);
    if (!gs) return;

    const task = gs.currentTask;
    const query = gs.currentQuery;
    if (!task || !query) return;

    // Detect stale DOM: task.el or query.actionsEl detached from the live document
    if ((task.el && !task.el.isConnected) || (query.actionsEl && !query.actionsEl.isConnected)) {
      _scheduleIntegrityRebuild();
      return;
    }

    // Compute display number: count tasks in all prior sessions + index in current session
    if (!task._displayNum) {
      let offset = 0;
      for (const [otherSid, otherGs] of LoupeGrouping.sessionGroups) {
        if (otherSid === sid) break;
        offset += otherGs.tasks.length;
      }
      task._displayNum = offset + gs.tasks.indexOf(task) + 1;
    }

    // Ensure task DOM exists (no topic header — queries render directly)
    if (!task.el) {
      const taskEl = document.createElement("div");
      taskEl.className = "task-group";
      const bodyEl = document.createElement("div");
      bodyEl.className = "task-body";
      taskEl.appendChild(bodyEl);
      task.el = taskEl;
      task.bodyEl = bodyEl;
      task.headerEl = null;
      container.appendChild(taskEl);
    }

    // Ensure query DOM exists
    if (!query.el) {
      const matchFn = (e) => _matchesFilter(e) && _matchesSearch(e);
      const qEl = renderQueryGroup(query, matchFn);
      task.bodyEl.appendChild(qEl);
    } else {
      // Update query header (action count may have changed)
      const newQHeader = renderQueryHeader(query);
      // Preserve collapse state in new header
      if (!query.collapsed) {
        newQHeader.querySelector(".query-chevron").textContent = "\u25BC";
      }
      // Re-bind click handler
      newQHeader.addEventListener("click", (e) => {
        e.stopPropagation();
        const isCollapsed = query.actionsEl.classList.toggle("collapsed");
        newQHeader.querySelector(".query-chevron").textContent = isCollapsed ? "\u25B6" : "\u25BC";
        query.collapsed = isCollapsed;
      });
      if (query.thinkingEntry) {
        newQHeader.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          _openModal(query.thinkingEntry.id);
        });
      }
      if (query.headerEl && query.el.contains(query.headerEl)) {
        query.el.replaceChild(newQHeader, query.headerEl);
      } else {
        query.el.insertBefore(newQHeader, query.el.firstChild);
      }
      query.headerEl = newQHeader;
    }

    // user_query and thinking entries that started a new query are represented by the query header
    if (entry.category === "user_query") {
      if (_shouldAutoScroll(entry)) _scrollPaneToBottom(entry);
      return;
    }
    if (entry.category === "thinking" && entry.userQuery && query.thinkingEntry === entry && query.items.length === 0) {
      if (_shouldAutoScroll(entry)) _scrollPaneToBottom(entry);
      return;
    }

    // For sub_agent and sub_agent_result, the agent group rendering handles it
    if (entry.category === "sub_agent") {
      // Find the agent group just created by assignToGroup
      const ag = findAgentGroupForEntry(gs, entry);
      if (ag) {
        const agEl = renderAgentGroup(ag, (e) => _matchesFilter(e) && _matchesSearch(e));
        if (agEl) {
          // Insert into correct parent
          if (gs.agentStack.length > 1) {
            // Nested: parent agent's childrenEl
            const parentAg = gs.agentStack[gs.agentStack.length - 2];
            if (parentAg && parentAg.childrenEl) parentAg.childrenEl.appendChild(agEl);
          } else {
            query.actionsEl.appendChild(agEl);
          }
        }
      }
      if (_shouldAutoScroll(entry)) _scrollPaneToBottom(entry);
      return;
    }

    if (entry.category === "sub_agent_result") {
      // Result was already attached to agent group by assignToGroup
      // Re-render the agent group or just append result entry
      // Find the agent group that just got its result
      const ag = findAgentGroupForResult(gs, entry);
      if (ag && ag.childrenEl) {
        if (_matchesFilter(entry) && _matchesSearch(entry)) {
          const resEl = renderEntry(entry);
          resEl.classList.add("flash");
          ag.childrenEl.appendChild(resEl);
          entry.el = resEl;
        }
      }
      if (_shouldAutoScroll(entry)) _scrollPaneToBottom(entry);
      return;
    }

    // Regular entry
    if (!_matchesFilter(entry) || !_matchesSearch(entry)) return;

    const el = renderEntry(entry);
    el.classList.add("flash");

    // Append to top-of-stack agent or query actions
    if (gs.agentStack.length > 0) {
      const topAg = gs.agentStack[gs.agentStack.length - 1];
      if (topAg.childrenEl) topAg.childrenEl.appendChild(el);
      else query.actionsEl.appendChild(el);
    } else {
      query.actionsEl.appendChild(el);
    }

    entry.el = el;
    if (_shouldAutoScroll(entry)) _scrollPaneToBottom(entry);
  }

  function findAgentGroupForEntry(gs, entry) {
    // The entry was just pushed as the last item on the agent stack
    if (gs.agentStack.length > 0) {
      const top = gs.agentStack[gs.agentStack.length - 1];
      if (top.agentEntry === entry) return top;
    }
    return null;
  }

  function findAgentGroupForResult(gs, entry) {
    // The result was just popped off the stack — search recent query items
    const query = gs.currentQuery;
    if (!query) return null;
    function searchItems(items) {
      for (const item of items) {
        if (item.agentEntry && item.resultEntry === entry) return item;
        if (item.agentEntry) {
          const found = searchItems(item.children);
          if (found) return found;
        }
      }
      return null;
    }
    return searchItems(query.items);
  }

  function init({ openModal, getContainerFor, shouldAutoScroll, scrollPaneToBottom, matchesFilter, matchesSearch, scheduleIntegrityRebuild }) {
    _openModal = openModal;
    _getContainerFor = getContainerFor;
    _shouldAutoScroll = shouldAutoScroll;
    _scrollPaneToBottom = scrollPaneToBottom;
    _matchesFilter = matchesFilter;
    _matchesSearch = matchesSearch;
    _scheduleIntegrityRebuild = scheduleIntegrityRebuild;
  }

  return {
    copyToClipboard,
    fallbackCopy,
    formatTimeRange,
    countItemActions,
    renderEntry,
    renderTaskHeader,
    bindTaskHeaderClick,
    renderQueryHeader,
    renderAgentHeader,
    renderAgentGroup,
    renderQueryGroup,
    renderTaskGroup,
    renderGroupedEntries,
    appendEntryGrouped,
    findAgentGroupForEntry,
    findAgentGroupForResult,
    init,
  };
})();
