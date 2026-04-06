"use strict";

// LoupeModal — Detail modal for inspecting individual entries.

const LoupeModal = (() => {

  let _getEntry = null;  // function(id) => entry, set via init()
  let _els = {};         // DOM element references, set via init()
  let modalEntryId = null;

  const esc = LoupeUtils.esc;
  const formatTime = LoupeUtils.formatTime;

  function badgeLabel(cat) {
    return {
      tool_use: "USE", tool_result: "RESULT", post_tool: "POST", error: "ERROR",
      thinking: "THINK", text: "TEXT", sub_agent: "AGENT", sub_agent_result: "AGENT DONE",
      user_query: "PROMPT",
      session_start: "SESSION", session_end: "SESSION",
      compact: "COMPACT",
      permission_request: "APPROVE", permission_denied: "DENIED",
      tool_failure: "FAILED", stop_failure: "API ERROR",
      task_created: "TASK", task_completed: "TASK \u2713",
    }[cat] || cat.toUpperCase();
  }

  function openModal(id) {
    const entry = _getEntry(id);
    if (!entry) return;
    modalEntryId = id;

    _els.modalBadge.className = `modal-badge cat-${entry.category}`;
    _els.modalBadge.textContent = badgeLabel(entry.category);
    _els.modalTool.textContent = entry.title || "";
    _els.modalTime.textContent = formatTime(entry.ts);

    // Apply thinking variant to panel
    _els.modalPanel.classList.toggle("modal-thinking", entry.category === "thinking");

    _els.modalBody.innerHTML = "";

    if (entry.category === "thinking") {
      // Thinking modal: user query + thinking content
      if (entry.userQuery) {
        const queryWrap = document.createElement("div");
        queryWrap.className = "modal-user-query-inline";
        queryWrap.innerHTML = `<span class="modal-user-query-label">Q</span><span class="modal-user-query-text">${esc(entry.userQuery)}</span>`;
        queryWrap.style.cursor = "pointer";
        queryWrap.addEventListener("click", () => {
          const isExpanded = queryWrap.classList.toggle("expanded");
          queryWrap.title = isExpanded ? "Click to collapse" : "Click to expand";
        });
        queryWrap.title = "Click to expand";
        _els.modalBody.appendChild(queryWrap);
      }
      // Image thumbnails
      if (entry.userImages && entry.userImages.length > 0) {
        const imgRow = document.createElement("div");
        imgRow.className = "modal-image-row";
        for (const imgPath of entry.userImages) {
          const thumb = document.createElement("img");
          thumb.className = "modal-image-thumb";
          thumb.src = `/image?path=${encodeURIComponent(imgPath)}`;
          thumb.alt = "User image";
          thumb.addEventListener("click", () => {
            thumb.classList.toggle("modal-image-expanded");
          });
          imgRow.appendChild(thumb);
        }
        _els.modalBody.appendChild(imgRow);
      }
      const thinkCode = document.createElement("div");
      thinkCode.className = "modal-code modal-thinking-body";
      const bodyText = String(entry.body || "");
      thinkCode.textContent = bodyText;
      _els.modalBody.appendChild(thinkCode);

      // If thinking text was truncated by backlog, add expand button to fetch full content
      if (bodyText.match(/\.\.\.\(\d+ more chars\)$/)) {
        const expandBtn = document.createElement("button");
        expandBtn.className = "modal-expand-btn";
        expandBtn.textContent = "Load full thinking";
        expandBtn.addEventListener("click", async () => {
          expandBtn.textContent = "Loading...";
          expandBtn.disabled = true;
          try {
            const resp = await fetch("/api/full-entry", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ts: entry.ts, category: "thinking" }),
            });
            if (resp.ok) {
              const fullObj = await resp.json();
              const inner = fullObj.data || fullObj;
              const fullText = inner.thinking || inner.content || inner.text || "";
              if (fullText) {
                thinkCode.textContent = fullText;
                expandBtn.remove();
              } else {
                expandBtn.textContent = "Full text not found";
              }
            } else {
              expandBtn.textContent = "Failed to load";
            }
          } catch {
            expandBtn.textContent = "Failed to load";
          }
        });
        _els.modalBody.insertBefore(expandBtn, thinkCode.nextSibling);
      }

      // Collapsible metadata
      if (entry.meta) {
        const metaToggle = document.createElement("div");
        metaToggle.className = "modal-meta-toggle";
        metaToggle.innerHTML = `<span class="modal-meta-arrow">\u25b6</span> Metadata`;
        const metaContent = document.createElement("div");
        metaContent.className = "modal-meta-content";
        metaContent.style.display = "none";
        const m = entry.meta;
        const rows = [];
        if (m.model) rows.push(["Model", m.model]);
        if (m.input_tokens) rows.push(["Input tokens", m.input_tokens.toLocaleString()]);
        if (m.output_tokens) rows.push(["Output tokens", m.output_tokens.toLocaleString()]);
        if (m.cache_read) rows.push(["Cache read", m.cache_read.toLocaleString()]);
        if (m.cache_create) rows.push(["Cache create", m.cache_create.toLocaleString()]);
        if (m.cwd) rows.push(["Working dir", m.cwd]);
        if (m.git_branch) rows.push(["Branch", m.git_branch]);
        if (m.version) rows.push(["Version", m.version]);
        metaContent.innerHTML = rows.map(([k, v]) =>
          `<div class="modal-meta-row"><span class="modal-meta-key">${esc(k)}</span><span class="modal-meta-val">${esc(String(v))}</span></div>`
        ).join("");
        metaToggle.addEventListener("click", () => {
          const open = metaContent.style.display !== "none";
          metaContent.style.display = open ? "none" : "";
          metaToggle.querySelector(".modal-meta-arrow").textContent = open ? "\u25b6" : "\u25bc";
        });
        _els.modalBody.appendChild(metaToggle);
        _els.modalBody.appendChild(metaContent);
      }
    } else if (entry.category === "sub_agent" || entry.category === "sub_agent_result") {
      const content = entry.body;
      if (content && typeof content === "object") {
        // Prompt section
        const prompt = content.prompt || content.description;
        if (prompt) {
          const lbl = document.createElement("div");
          lbl.className = "modal-section-label";
          lbl.textContent = "Prompt";
          _els.modalBody.appendChild(lbl);
          const code = document.createElement("div");
          code.className = "modal-code";
          code.textContent = prompt;
          _els.modalBody.appendChild(code);
        }
        // Content blocks
        const blocks = content.content || [];
        if (Array.isArray(blocks) && blocks.length > 0) {
          const lbl = document.createElement("div");
          lbl.className = "modal-section-label";
          lbl.textContent = "Response";
          _els.modalBody.appendChild(lbl);
          for (const block of blocks) {
            const blockDiv = document.createElement("div");
            blockDiv.className = "modal-code modal-agent-block";
            if (block.type && block.type !== "text") {
              const tag = document.createElement("span");
              tag.className = "modal-agent-block-type";
              tag.textContent = block.type;
              blockDiv.appendChild(tag);
            }
            const text = block.text || block.content || (typeof block === "string" ? block : JSON.stringify(block));
            const textNode = document.createTextNode(text);
            blockDiv.appendChild(textNode);
            _els.modalBody.appendChild(blockDiv);
          }
        }
        // Status if present
        if (content.status && content.status !== "completed") {
          const lbl = document.createElement("div");
          lbl.className = "modal-section-label";
          lbl.textContent = "Status";
          _els.modalBody.appendChild(lbl);
          const code = document.createElement("div");
          code.className = "modal-code";
          code.textContent = content.status;
          _els.modalBody.appendChild(code);
        }
      } else if (content) {
        const code = document.createElement("div");
        code.className = "modal-code";
        code.textContent = String(content);
        _els.modalBody.appendChild(code);
      }
    } else {
      const content = entry.body;
      if (content && typeof content === "object") {
        if (content.tool_input || content.command || content.file_path) {
          addModalSection("Input", content);
        } else if (content.tool_response) {
          addModalSection("Input", { ...content, tool_response: undefined });
          addModalSection("Response", content.tool_response);
        } else {
          addModalSection("Detail", content);
        }
      } else if (content) {
        const code = document.createElement("div");
        code.className = "modal-code";
        code.textContent = String(content);
        _els.modalBody.appendChild(code);
      }
    }

    _els.modalOverlay.classList.add("visible");
  }

  function addModalSection(label, obj) {
    const lbl = document.createElement("div");
    lbl.className = "modal-section-label";
    lbl.textContent = label;
    _els.modalBody.appendChild(lbl);

    const code = document.createElement("div");
    code.className = "modal-code";
    if (typeof obj === "object" && obj !== null) {
      code.appendChild(renderJsonTree(obj));
    } else {
      code.textContent = String(obj || "");
    }
    _els.modalBody.appendChild(code);
  }

  function closeModal() {
    _els.modalOverlay.classList.remove("visible");
    _els.modalOverlay.classList.remove("modal-replay");
    modalEntryId = null;
  }

  // ===== JSON Tree =====
  function renderJsonTree(obj, depth) {
    depth = depth || 0;
    const wrap = document.createElement("div");
    wrap.className = "json-tree";
    if (typeof obj !== "object" || obj === null) { wrap.innerHTML = renderPrimitive(obj); return wrap; }

    const isArr = Array.isArray(obj);
    const keys = Object.keys(obj);
    const open = isArr ? "[" : "{";
    const close = isArr ? "]" : "}";
    if (keys.length === 0) { wrap.innerHTML = `<span class="json-bracket">${open}${close}</span>`; return wrap; }

    const collapsed = depth > 1;
    const toggle = document.createElement("span");
    toggle.className = "json-toggle";
    toggle.textContent = collapsed ? "\u25b6 " : "\u25bc ";
    toggle.onclick = (e) => {
      e.stopPropagation();
      const c = wrap.querySelector(".json-content");
      const ind = wrap.querySelector(".json-collapsed-indicator");
      if (c.style.display === "none") { c.style.display = ""; if (ind) ind.style.display = "none"; toggle.textContent = "\u25bc "; }
      else { c.style.display = "none"; if (ind) ind.style.display = ""; toggle.textContent = "\u25b6 "; }
    };
    wrap.appendChild(toggle);
    wrap.appendChild(spanOf(open, "json-bracket"));

    const indicator = document.createElement("span");
    indicator.className = "json-collapsed-indicator";
    indicator.textContent = ` ${keys.length} items `;
    indicator.style.display = collapsed ? "" : "none";
    wrap.appendChild(indicator);

    const content = document.createElement("div");
    content.className = "json-content";
    content.style.paddingLeft = "14px";
    content.style.display = collapsed ? "none" : "";

    keys.forEach((key, i) => {
      const line = document.createElement("div");
      if (!isArr) { line.appendChild(spanOf(`"${key}"`, "json-key")); line.appendChild(spanOf(": ", "json-bracket")); }
      const val = obj[key];
      if (typeof val === "object" && val !== null) line.appendChild(renderJsonTree(val, depth + 1));
      else line.innerHTML += renderPrimitive(val);
      if (i < keys.length - 1) line.appendChild(spanOf(",", "json-bracket"));
      content.appendChild(line);
    });

    wrap.appendChild(content);
    wrap.appendChild(spanOf(close, "json-bracket"));
    return wrap;
  }

  let truncId = 0;
  function renderPrimitive(val) {
    if (val === null) return `<span class="json-null">null</span>`;
    if (typeof val === "boolean") return `<span class="json-bool">${val}</span>`;
    if (typeof val === "number") return `<span class="json-number">${val}</span>`;
    const str = String(val);
    if (str.length <= 800) return `<span class="json-string">"${esc(str)}"</span>`;
    const id = "trunc-" + (truncId++);
    return `<span class="json-string" id="${id}">"${esc(str.slice(0, 800))}<span class="trunc-fade">...</span>"<button class="trunc-btn" onclick="event.stopPropagation(); expandTruncated('${id}', this)" data-full="${esc(str).replace(/"/g, '&quot;')}">${str.length.toLocaleString()} chars</button></span>`;
  }

  function spanOf(text, cls) { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; }

  // Legacy replay modal fallback (kept for non-popover contexts)
  function showReplayModal(html) {
    _els.modalOverlay.classList.add("modal-replay");
    _els.modalBadge.className = "modal-badge cat-thinking";
    _els.modalBadge.textContent = "REPLAY";
    _els.modalTool.textContent = "Session Analysis";
    _els.modalTime.textContent = formatTime(Date.now());
    _els.modalPanel.classList.remove("modal-thinking");
    _els.modalBody.innerHTML = html;
    _els.modalOverlay.classList.add("visible");
  }

  function init({ getEntry, elements }) {
    _getEntry = getEntry;
    _els = elements;

    // Bind close handlers
    _els.modalClose.addEventListener("click", closeModal);
    _els.modalOverlay.addEventListener("click", (e) => { if (e.target === _els.modalOverlay) closeModal(); });

    document.getElementById("modal-copy").addEventListener("click", () => {
      const text = _els.modalBody.innerText || _els.modalBody.textContent || "";
      LoupeRender.copyToClipboard(text);
      const btn = document.getElementById("modal-copy");
      btn.textContent = "\u2713";
      setTimeout(() => { btn.innerHTML = "&#x2398;"; }, 1000);
    });

    // Keep expandTruncated on window
    window.expandTruncated = (id, btn) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `"${btn.dataset.full}"`;
    };
  }

  return {
    openModal,
    closeModal,
    badgeLabel,
    showReplayModal,
    init,
  };
})();
