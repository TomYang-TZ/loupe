"use strict";

// ===== Tiling Window Manager =====
// Binary tree layout: each leaf is a pane, each split is horizontal or vertical.
// Drag a pane header onto another pane to create splits.
// Drag dividers to resize.

const Tiling = (() => {
  // Tree node: either a leaf { type: "leaf", sessionId, pane } or
  // a split { type: "split", direction: "h"|"v", ratio: 0-1, children: [a, b] }
  let root = null;
  let container = null;
  let onPaneCreated = null; // callback(sessionId) → paneElement
  let onBeforeRebuild = null; // callback() — clear panes map before rebuild
  let onRebuild = null; // callback() — repopulate content after user-initiated rebuild
  let userAction = false;

  // --- Tree operations ---

  function makeLeaf(sessionId) {
    return { type: "leaf", sessionId };
  }

  function makeSplit(direction, a, b, ratio = 0.5) {
    return { type: "split", direction, ratio, children: [a, b] };
  }

  function findLeaf(node, sessionId) {
    if (!node) return null;
    if (node.type === "leaf") return node.sessionId === sessionId ? node : null;
    return findLeaf(node.children[0], sessionId) || findLeaf(node.children[1], sessionId);
  }

  function findParent(node, target) {
    if (!node || node.type === "leaf") return null;
    if (node.children[0] === target || node.children[1] === target) return node;
    return findParent(node.children[0], target) || findParent(node.children[1], target);
  }

  function removeLeaf(sessionId) {
    if (!root) return;
    if (root.type === "leaf") {
      if (root.sessionId === sessionId) root = null;
      return;
    }
    const leaf = findLeaf(root, sessionId);
    if (!leaf) return;
    const parent = findParent(root, leaf);
    if (!parent) return;
    const sibling = parent.children[0] === leaf ? parent.children[1] : parent.children[0];
    // Replace parent with sibling
    const grandparent = findParent(root, parent);
    if (!grandparent) {
      root = sibling;
    } else {
      if (grandparent.children[0] === parent) grandparent.children[0] = sibling;
      else grandparent.children[1] = sibling;
    }
  }

  function insertAt(targetSessionId, draggedSessionId, zone) {
    // Remove dragged from tree first (if it exists)
    removeLeaf(draggedSessionId);

    const target = findLeaf(root, targetSessionId);
    if (!target) return;

    const newLeaf = makeLeaf(draggedSessionId);
    const parent = findParent(root, target);

    let split;
    if (zone === "left") {
      split = makeSplit("h", newLeaf, makeLeaf(targetSessionId));
    } else if (zone === "right") {
      split = makeSplit("h", makeLeaf(targetSessionId), newLeaf);
    } else if (zone === "top") {
      split = makeSplit("v", newLeaf, makeLeaf(targetSessionId));
    } else { // bottom
      split = makeSplit("v", makeLeaf(targetSessionId), newLeaf);
    }

    if (!parent) {
      root = split;
    } else {
      if (parent.children[0] === target) parent.children[0] = split;
      else parent.children[1] = split;
    }
  }

  function countLeaves(node) {
    if (!node) return 0;
    if (node.type === "leaf") return 1;
    return countLeaves(node.children[0]) + countLeaves(node.children[1]);
  }

  function getAllSessionIds(node) {
    if (!node) return [];
    if (node.type === "leaf") return [node.sessionId];
    return [...getAllSessionIds(node.children[0]), ...getAllSessionIds(node.children[1])];
  }

  // --- Rendering ---

  function renderTree(node) {
    if (!node) return document.createElement("div");

    if (node.type === "leaf") {
      const wrapper = document.createElement("div");
      wrapper.className = "tile-leaf";
      wrapper.dataset.session = node.sessionId;
      wrapper.style.flex = "1";
      wrapper.style.minWidth = "0";
      wrapper.style.minHeight = "0";
      wrapper.style.position = "relative";
      wrapper.style.overflow = "hidden";

      // Pane content gets mounted here by callback
      if (onPaneCreated) {
        const paneEl = onPaneCreated(node.sessionId);
        if (paneEl) wrapper.appendChild(paneEl);
      }

      // Drop zones for drag-to-split
      setupDropZones(wrapper, node.sessionId);

      return wrapper;
    }

    // Split node
    const splitEl = document.createElement("div");
    splitEl.className = "tile-split";
    splitEl.style.display = "flex";
    splitEl.style.flexDirection = node.direction === "h" ? "row" : "column";
    splitEl.style.flex = "1";
    splitEl.style.minWidth = "0";
    splitEl.style.minHeight = "0";
    splitEl.style.overflow = "hidden";

    const childA = renderTree(node.children[0]);
    const childB = renderTree(node.children[1]);

    // Apply ratio via flex-basis
    const pctA = (node.ratio * 100).toFixed(1);
    const pctB = ((1 - node.ratio) * 100).toFixed(1);
    childA.style.flex = `0 0 calc(${pctA}% - 1.5px)`;
    childB.style.flex = `0 0 calc(${pctB}% - 1.5px)`;

    // Divider
    const divider = document.createElement("div");
    divider.className = `tile-divider tile-divider-${node.direction}`;
    setupDividerDrag(divider, node, splitEl);

    splitEl.appendChild(childA);
    splitEl.appendChild(divider);
    splitEl.appendChild(childB);

    return splitEl;
  }

  function setupDividerDrag(divider, splitNode, splitEl) {
    divider.addEventListener("mousedown", (e) => {
      e.preventDefault();
      document.body.style.userSelect = "none";
      document.body.style.cursor = splitNode.direction === "h" ? "col-resize" : "row-resize";

      const rect = splitEl.getBoundingClientRect();
      const isH = splitNode.direction === "h";
      const totalSize = isH ? rect.width : rect.height;
      const startPos = isH ? e.clientX : e.clientY;
      const startRatio = splitNode.ratio;

      function onMove(ev) {
        const delta = (isH ? ev.clientX : ev.clientY) - startPos;
        const newRatio = Math.max(0.1, Math.min(0.9, startRatio + delta / totalSize));
        splitNode.ratio = newRatio;
        // Update flex-basis directly without full rebuild
        const children = splitEl.children;
        const pctA = (newRatio * 100).toFixed(1);
        const pctB = ((1 - newRatio) * 100).toFixed(1);
        children[0].style.flex = `0 0 calc(${pctA}% - 1.5px)`;
        children[2].style.flex = `0 0 calc(${pctB}% - 1.5px)`;
      }

      function onUp() {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function setupDropZones(wrapper, sessionId) {
    // Drop zone overlay appears during drag
    wrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      showDropIndicator(wrapper, e);
    });
    wrapper.addEventListener("dragleave", (e) => {
      // Only hide if actually leaving the wrapper
      if (!wrapper.contains(e.relatedTarget)) {
        hideDropIndicator(wrapper);
      }
    });
    wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      hideDropIndicator(wrapper);
      const draggedId = e.dataTransfer.getData("text/session-id");
      if (!draggedId || draggedId === sessionId) return;
      const zone = getDropZone(wrapper, e);
      if (zone) {
        insertAt(sessionId, draggedId, zone);
        userAction = true;
        rebuild();
        userAction = false;
      }
    });
  }

  function getDropZone(wrapper, e) {
    const rect = wrapper.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    // Edges: 30% from each side
    const threshold = 0.3;
    if (x < threshold) return "left";
    if (x > 1 - threshold) return "right";
    if (y < threshold) return "top";
    if (y > 1 - threshold) return "bottom";
    return "right"; // default
  }

  function showDropIndicator(wrapper, e) {
    let indicator = wrapper.querySelector(".tile-drop-indicator");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "tile-drop-indicator";
      wrapper.appendChild(indicator);
    }

    const zone = getDropZone(wrapper, e);
    indicator.style.position = "absolute";
    indicator.style.zIndex = "20";
    indicator.style.pointerEvents = "none";
    indicator.style.transition = "all 0.1s ease";

    // Highlight the zone where the pane would land
    if (zone === "left") {
      Object.assign(indicator.style, { top: "0", left: "0", width: "50%", height: "100%", right: "", bottom: "" });
    } else if (zone === "right") {
      Object.assign(indicator.style, { top: "0", right: "0", width: "50%", height: "100%", left: "", bottom: "" });
    } else if (zone === "top") {
      Object.assign(indicator.style, { top: "0", left: "0", width: "100%", height: "50%", right: "", bottom: "" });
    } else {
      Object.assign(indicator.style, { bottom: "0", left: "0", width: "100%", height: "50%", top: "", right: "" });
    }
  }

  function hideDropIndicator(wrapper) {
    const indicator = wrapper.querySelector(".tile-drop-indicator");
    if (indicator) indicator.remove();
  }

  // --- Public API ---

  function init(containerEl, paneCallback, opts = {}) {
    container = containerEl;
    onPaneCreated = paneCallback;
    onBeforeRebuild = opts.onBeforeRebuild || null;
    onRebuild = opts.onRebuild || null;
  }

  function addSession(sessionId, autoRebuild = true, direction = "h", ratio = 0.5) {
    if (!root) {
      root = makeLeaf(sessionId);
    } else if (findLeaf(root, sessionId)) {
      return; // already in tree
    } else {
      root = makeSplit(direction, root, makeLeaf(sessionId), ratio);
    }
    if (autoRebuild) rebuild();
  }

  function removeSession(sessionId, autoRebuild = true) {
    removeLeaf(sessionId);
    if (autoRebuild) rebuild();
  }

  function rebuild() {
    if (!container) return;
    if (userAction && onBeforeRebuild) onBeforeRebuild();
    container.innerHTML = "";
    if (!root) return;

    // Ensure multi-pane styling
    const leafCount = countLeaves(root);
    container.classList.toggle("multi-pane", leafCount > 1);

    const tree = renderTree(root);
    tree.style.display = "flex";
    tree.style.width = "100%";
    tree.style.height = "100%";
    container.appendChild(tree);

    // Only call onRebuild for user-initiated actions (drag-to-split),
    // not for programmatic rebuilds from rebuildPanes which handles content itself
    if (userAction && onRebuild) onRebuild();
  }

  function getSessionIds() {
    return getAllSessionIds(root);
  }

  function getTree() { return root; }
  function setTree(t) { root = t; rebuild(); }

  function clear() { root = null; }

  return { init, addSession, removeSession, rebuild, getSessionIds, getTree, setTree, clear, countLeaves };
})();
