// Standalone HTML visualisation of an entity map (#2061).
//
// One self-contained file: no network requests, no CDN, no build step. The map
// is inlined as JSON in a `<script type="application/json">` block and the page
// builds its own DOM from it.
//
// Everything in the map comes from audited pages. The only server-side escaping
// here is the inlined JSON and the `<title>`; every other untrusted value
// reaches the DOM through `textContent`, never `innerHTML`, so the page cannot
// be made to execute a site's markup.

import type { EntityMap } from "@squirrelscan/core-contracts/entity-map";

/**
 * Escape a JSON payload for embedding inside a `<script>` element.
 *
 * `</script`, `<!--` and the two JSON-legal-but-JS-illegal line separators all
 * end or corrupt the block; escaping `<`, `>` and `&` as `\uXXXX` is valid JSON
 * and neutralises every one of them.
 */
function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Nodes drawn in the force graph before it stops being readable (or fast). */
const GRAPH_NODE_CAP = 400;

/**
 * Types that describe one page rather than a thing the site is about.
 *
 * A 60-page site emits one BreadcrumbList and one WebPage per page and a
 * Question per FAQ entry, so these crowd out the Organization and Person nodes
 * the map exists to show. The graph can hide them; the table never does. Unnamed
 * ImageObject nodes join them at runtime, since an image with no name is a URL,
 * not an entity a reader can reason about.
 */
const PAGE_LOCAL_TYPES = [
  "Question",
  "BreadcrumbList",
  "ListItem",
  "WebPage",
  "Answer",
] as const;

const STYLES = `
:root {
  --bg: #f7f7f5;
  --panel: #ffffff;
  --ink: #1c1c1a;
  --muted: #6b6b64;
  --line: #e2e2dc;
  --accent: #9a4b1f;
  --warn: #b3541e;
  --danger: #a32020;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 28px 20px 64px; }
h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 32px 0 10px; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; margin: 0 0 20px; word-break: break-all; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 14px;
}
.card .n { font-size: 22px; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.card .l { color: var(--muted); font-size: 12px; margin-top: 2px; }
.graph-shell { position: relative; }
canvas {
  width: 100%;
  height: 560px;
  display: block;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: grab;
  touch-action: none;
}
canvas.dragging { cursor: grabbing; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 8px; margin-top: 10px; }
.legend button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  font-size: 12px;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 10px 2px 8px;
  cursor: pointer;
}
.legend button:hover { color: var(--ink); }
.legend button[aria-pressed="false"] { opacity: 0.45; text-decoration: line-through; }
.swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
.note { color: var(--muted); font-size: 12px; margin-top: 8px; }
button.action {
  font: inherit;
  font-size: 13px;
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: inherit;
  cursor: pointer;
}
button.action:hover { border-color: var(--muted); }
label.check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
#panel {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 330px;
  max-height: calc(100% - 24px);
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px 16px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.09);
  font-size: 13px;
}
#panel h3 { margin: 0 8px 2px 0; font-size: 15px; word-break: break-word; }
#panel .close {
  float: right;
  border: 0;
  background: none;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  color: var(--muted);
}
#panel dt { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 10px; }
#panel dd { margin: 2px 0 0; word-break: break-word; }
#panel ul { margin: 4px 0 0; padding-left: 16px; }
#panel li { word-break: break-all; margin-bottom: 2px; }
.pill {
  display: inline-block;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  margin: 0 4px 4px 0;
  background: #fbfbf9;
}
.conflict { border-left: 3px solid var(--warn); padding-left: 8px; margin-top: 6px; }
.controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 10px 0; }
select, input[type="search"] {
  font: inherit;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: inherit;
}
.table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { cursor: pointer; user-select: none; white-space: nowrap; font-size: 12px; color: var(--muted); }
th:hover { color: var(--ink); }
th .arrow { opacity: 0.45; }
tbody tr:hover { background: #fbfaf7; }
tbody tr { cursor: pointer; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--muted); word-break: break-all; max-width: 320px; }
.flag { color: var(--danger); font-weight: 600; }
.flag.warn { color: var(--warn); }
.empty { padding: 28px; text-align: center; color: var(--muted); }
`;

const SCRIPT = String.raw`
(function () {
  "use strict";
  var map = JSON.parse(document.getElementById("entity-map-data").textContent);
  var GRAPH_NODE_CAP = __GRAPH_NODE_CAP__;
  var PAGE_LOCAL_TYPES = __PAGE_LOCAL_TYPES__;

  var PALETTE = [
    "#9a4b1f", "#2f6f4f", "#2d5d86", "#7a3d78", "#8a7318",
    "#3f6d6d", "#8d3b4a", "#4a5a2c", "#6b5b8a", "#a15c2a"
  ];
  var DANGLING_COLOR = "#a32020";
  var MIN_ZOOM = 0.15, MAX_ZOOM = 6;
  // Below this the labels would overlap into mush, so they are hidden until the
  // reader zooms in. Set at 1 so a Fit that had room to zoom in shows them and
  // a graph too big to fit does not. The focused node keeps its label at any
  // zoom, and so does a node the reader has selected.
  var LABEL_ZOOM = 1;

  document.getElementById("site").textContent = map.site;
  document.getElementById("generated").textContent = map.generatedAt;

  function primaryType(node) { return (node.types && node.types[0]) || "Thing"; }

  function isPageLocal(node) {
    if (!node) return false;
    var type = primaryType(node);
    if (PAGE_LOCAL_TYPES.indexOf(type) !== -1) return true;
    // An image with no name is a URL, not something a reader can reason about.
    return type === "ImageObject" && !node.name;
  }

  var typeList = [];
  var seenTypes = Object.create(null);
  map.nodes.forEach(function (node) {
    var type = primaryType(node);
    if (!seenTypes[type]) { seenTypes[type] = true; typeList.push(type); }
  });
  typeList.sort();
  var colorOf = Object.create(null);
  typeList.forEach(function (type, index) { colorOf[type] = PALETTE[index % PALETTE.length]; });

  function text(tag, value, className) {
    var el = document.createElement(tag);
    el.textContent = value == null ? "" : String(value);
    if (className) el.className = className;
    return el;
  }

  // ---------- summary cards ----------
  var s = map.summary;
  var cards = [
    ["Entities", s.nodeCount],
    ["References", s.edgeCount],
    ["Dangling refs", s.danglingCount],
    ["Pages", s.pagesTotal],
    ["Pages w/o entities", s.pagesWithoutEntities],
    ["Stable @id", Math.round(s.stableIdShare * 100) + "%"]
  ];
  var cardHost = document.getElementById("cards");
  cards.forEach(function (card) {
    var box = document.createElement("div");
    box.className = "card";
    box.appendChild(text("div", card[1], "n"));
    box.appendChild(text("div", card[0], "l"));
    cardHost.appendChild(box);
  });

  // ---------- graph model ----------
  // Rank by occurrences so a capped graph keeps the entities that matter.
  var ranked = map.nodes.slice().sort(function (a, b) {
    return b.occurrences - a.occurrences || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
  var included = Object.create(null);
  var sim = [];
  ranked.slice(0, GRAPH_NODE_CAP).forEach(function (node) {
    included[node.key] = true;
    sim.push({
      key: node.key,
      node: node,
      label: node.name || primaryType(node),
      legendType: primaryType(node),
      color: colorOf[primaryType(node)],
      pageLocal: isPageLocal(node),
      dangling: false,
      // Area, not radius, tracks reach: an entity on 160 pages should read as
      // bigger than one on 4 without swallowing the canvas.
      r: 4 + Math.min(18, Math.sqrt(node.occurrences) * 2.6),
      x: 0, y: 0, vx: 0, vy: 0, fixed: false
    });
  });

  var simEdges = [];
  map.edges.forEach(function (edge) {
    if (!included[edge.source]) return;
    if (edge.dangling) {
      if (!included[edge.target]) {
        if (sim.length >= GRAPH_NODE_CAP + 120) return;
        included[edge.target] = true;
        sim.push({
          key: edge.target,
          node: null,
          label: edge.target.indexOf("id:") === 0 ? edge.target.slice(3) : edge.target,
          legendType: null,
          color: DANGLING_COLOR,
          pageLocal: false,
          dangling: true,
          r: 5, x: 0, y: 0, vx: 0, vy: 0, fixed: false
        });
      }
    } else if (!included[edge.target]) {
      return;
    }
    simEdges.push(edge);
  });

  var indexOf = Object.create(null);
  sim.forEach(function (n, i) { indexOf[n.key] = i; });
  var links = [];
  simEdges.forEach(function (edge) {
    var a = indexOf[edge.source], b = indexOf[edge.target];
    if (a === undefined || b === undefined) return;
    links.push({ a: a, b: b, predicate: edge.predicate, dangling: edge.dangling });
  });

  var canvas = document.getElementById("graph");
  var panel = document.getElementById("panel");
  var ctx = canvas.getContext("2d");
  var width = 0, height = 0, dpr = 1;
  var hovered = -1, selected = -1, dragging = -1, panning = null;

  // ---------- visibility ----------
  var hiddenTypes = Object.create(null);
  // Dangling placeholders get their own flag rather than a key in hiddenTypes:
  // type names come from audited pages, so any sentinel string could collide
  // with a real @type.
  var danglingHidden = false;
  var hidePageLocal = false;
  var visibleIdx = [], visibleLinks = [], neighbours = null, neighbourFocus = -2;

  function nodeVisible(n) {
    if (n.dangling) return !danglingHidden;
    if (hiddenTypes[n.legendType]) return false;
    if (hidePageLocal && n.pageLocal) return false;
    return true;
  }

  function recomputeVisible() {
    visibleIdx = [];
    var shown = Object.create(null);
    for (var i = 0; i < sim.length; i++) {
      if (!nodeVisible(sim[i])) continue;
      visibleIdx.push(i);
      shown[i] = true;
    }
    visibleLinks = links.filter(function (link) { return shown[link.a] && shown[link.b]; });
    neighbourFocus = -2;
    if (hovered >= 0 && !shown[hovered]) hovered = -1;
    if (selected >= 0 && !shown[selected]) { selected = -1; panel.hidden = true; }
    updateGraphCount();
  }

  function updateGraphCount() {
    var hiddenCount = sim.length - visibleIdx.length;
    document.getElementById("graph-count").textContent =
      visibleIdx.length + " of " + sim.length + " drawn" +
      (hiddenCount > 0 ? " · " + hiddenCount + " hidden" : "");
    var pageLocalTotal = 0;
    for (var i = 0; i < sim.length; i++) if (sim[i].pageLocal) pageLocalTotal++;
    document.getElementById("table-note").textContent = hidePageLocal
      ? "The graph is hiding " + pageLocalTotal + " page-local entities (per-page types and unnamed images). Every entity is listed below."
      : "Every entity is listed below, including the ones the graph can hide.";
  }

  // ---------- view transform ----------
  var view = { scale: 1, tx: 0, ty: 0 };
  function toScreenX(x) { return x * view.scale + view.tx; }
  function toScreenY(y) { return y * view.scale + view.ty; }
  function toWorldX(sx) { return (sx - view.tx) / view.scale; }
  function toWorldY(sy) { return (sy - view.ty) / view.scale; }

  function fit() {
    if (visibleIdx.length === 0) { view.scale = 1; view.tx = 0; view.ty = 0; return; }
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < visibleIdx.length; i++) {
      var n = sim[visibleIdx[i]];
      if (n.x - n.r < minX) minX = n.x - n.r;
      if (n.x + n.r > maxX) maxX = n.x + n.r;
      if (n.y - n.r < minY) minY = n.y - n.r;
      if (n.y + n.r > maxY) maxY = n.y + n.r;
    }
    var pad = 34;
    var scale = Math.min(
      (width - pad * 2) / Math.max(1, maxX - minX),
      (height - pad * 2) / Math.max(1, maxY - minY)
    );
    view.scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
    view.tx = width / 2 - ((minX + maxX) / 2) * view.scale;
    view.ty = height / 2 - ((minY + maxY) / 2) * view.scale;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Deterministic phyllotaxis seeding around the canvas centre: same map, same
  // starting layout, every reload.
  function seed() {
    sim.forEach(function (n, i) {
      var angle = i * 2.399963;
      var radius = 20 + 11 * Math.sqrt(i);
      n.x = width / 2 + Math.cos(angle) * radius;
      n.y = height / 2 + Math.sin(angle) * radius;
    });
  }

  var alpha = 1;
  // The cloud settles where total repulsion balances the centering pull, so a
  // fixed repulsion constant makes a 100-node graph blow past the canvas edge
  // and pile up against the clamp. Dividing by sqrt(n) keeps the equilibrium
  // radius roughly constant from 10 nodes to the cap.
  var REPULSION = 9000 / Math.sqrt(Math.max(1, sim.length));
  var CENTERING = 0.02;

  // The simulation runs in a fixed world the size of the canvas at scale 1;
  // zoom and pan are a view on top of it, so the physics never change.
  function step() {
    var cx = width / 2, cy = height / 2;
    var i, j, k, n;
    for (i = 0; i < visibleIdx.length; i++) {
      for (j = i + 1; j < visibleIdx.length; j++) {
        var p = sim[visibleIdx[i]], q = sim[visibleIdx[j]];
        var dx = q.x - p.x, dy = q.y - p.y;
        var d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i - j) * 0.1 + 0.1; dy = 0.1; d2 = dx * dx + dy * dy; }
        if (d2 > 90000) continue;
        var d = Math.sqrt(d2);
        var force = (REPULSION + (p.r + q.r) * 20) / d2;
        var fx = (dx / d) * force, fy = (dy / d) * force;
        p.vx -= fx; p.vy -= fy;
        q.vx += fx; q.vy += fy;
      }
    }
    for (k = 0; k < visibleLinks.length; k++) {
      var link = visibleLinks[k];
      var u = sim[link.a], v = sim[link.b];
      var ex = v.x - u.x, ey = v.y - u.y;
      var len = Math.sqrt(ex * ex + ey * ey) || 0.01;
      var target = 90 + u.r + v.r;
      var pull = (len - target) * 0.012;
      var ux = (ex / len) * pull, uy = (ey / len) * pull;
      u.vx += ux; u.vy += uy;
      v.vx -= ux; v.vy -= uy;
    }
    for (var m = 0; m < visibleIdx.length; m++) {
      n = sim[visibleIdx[m]];
      if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
      var ox = cx - n.x, oy = cy - n.y;
      // A node flung out early otherwise stays pinned in a corner once alpha
      // has cooled, with one long edge back to the cloud. Past the readable
      // radius the pull ramps up until it comes back.
      var away = Math.sqrt(ox * ox + oy * oy);
      var limit = Math.min(width, height) * 0.42;
      var centering = away > limit ? CENTERING * (1 + (away - limit) / 30) : CENTERING;
      n.vx += ox * centering;
      n.vy += oy * centering;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx * alpha;
      n.y += n.vy * alpha;
      n.x = Math.max(n.r + 4, Math.min(width - n.r - 4, n.x));
      n.y = Math.max(n.r + 4, Math.min(height - n.r - 4, n.y));
    }
    // Cools to a resting layout instead of jittering forever; a drag reheats it.
    if (alpha > 0.08) alpha *= 0.992;
  }

  function focusIndex() { return hovered >= 0 ? hovered : selected; }

  function neighboursOf(focus) {
    if (neighbourFocus === focus) return neighbours;
    var set = Object.create(null);
    if (focus >= 0) {
      set[focus] = true;
      for (var k = 0; k < visibleLinks.length; k++) {
        var link = visibleLinks[k];
        if (link.a === focus) set[link.b] = true;
        if (link.b === focus) set[link.a] = true;
      }
    }
    neighbours = set;
    neighbourFocus = focus;
    return set;
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    var focus = focusIndex();
    var near = neighboursOf(focus);
    var showLabels = view.scale >= LABEL_ZOOM;
    var k, i;

    for (k = 0; k < visibleLinks.length; k++) {
      var link = visibleLinks[k];
      var u = sim[link.a], v = sim[link.b];
      var lit = focus >= 0 && (link.a === focus || link.b === focus);
      ctx.globalAlpha = focus >= 0 && !lit ? 0.12 : 1;
      ctx.beginPath();
      ctx.moveTo(toScreenX(u.x), toScreenY(u.y));
      ctx.lineTo(toScreenX(v.x), toScreenY(v.y));
      ctx.strokeStyle = link.dangling
        ? "rgba(163,32,32,0.55)"
        : lit ? "rgba(28,28,26,0.6)" : "rgba(28,28,26,0.14)";
      ctx.lineWidth = lit ? 1.8 : 1;
      ctx.setLineDash(link.dangling ? [4, 3] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      if (lit) {
        ctx.fillStyle = "#6b6b64";
        ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          link.predicate,
          (toScreenX(u.x) + toScreenX(v.x)) / 2,
          (toScreenY(u.y) + toScreenY(v.y)) / 2 - 3
        );
      }
    }

    for (i = 0; i < visibleIdx.length; i++) {
      var index = visibleIdx[i];
      var n = sim[index];
      var dim = focus >= 0 && !near[index];
      ctx.globalAlpha = dim ? 0.18 : 1;
      var px = toScreenX(n.x), py = toScreenY(n.y), pr = Math.max(1.5, n.r * view.scale);
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      if (n.dangling) {
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = DANGLING_COLOR;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = n.color;
        ctx.fill();
        if (index === selected) {
          ctx.strokeStyle = "#1c1c1a";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      if ((showLabels && !dim) || index === focus) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#1c1c1a";
        ctx.font = (index === focus ? "600 11px " : "11px ") + "ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        var label = n.label.length > 30 ? n.label.slice(0, 29) + "…" : n.label;
        ctx.fillText(label, px, py + pr + 11);
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame() { step(); draw(); requestAnimationFrame(frame); }

  function pointer(event) {
    var rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hit(event) {
    var at = pointer(event);
    // Topmost first, and in screen space so the grab radius stays usable at any
    // zoom.
    for (var i = visibleIdx.length - 1; i >= 0; i--) {
      var n = sim[visibleIdx[i]];
      var dx = at.x - toScreenX(n.x), dy = at.y - toScreenY(n.y);
      var reach = Math.max(1.5, n.r * view.scale) + 4;
      if (dx * dx + dy * dy <= reach * reach) return { index: visibleIdx[i], x: at.x, y: at.y };
    }
    return { index: -1, x: at.x, y: at.y };
  }

  canvas.addEventListener("mousemove", function (event) {
    var at = pointer(event);
    if (panning) {
      view.tx = panning.tx + (at.x - panning.x);
      view.ty = panning.ty + (at.y - panning.y);
      return;
    }
    if (dragging >= 0) {
      sim[dragging].x = toWorldX(at.x);
      sim[dragging].y = toWorldY(at.y);
      sim[dragging].vx = 0;
      sim[dragging].vy = 0;
      return;
    }
    hovered = hit(event).index;
  });

  canvas.addEventListener("mousedown", function (event) {
    var found = hit(event);
    if (found.index >= 0) {
      dragging = found.index;
      sim[dragging].fixed = true;
      alpha = Math.max(alpha, 0.6);
    } else {
      panning = { x: found.x, y: found.y, tx: view.tx, ty: view.ty };
    }
    canvas.classList.add("dragging");
  });

  window.addEventListener("mouseup", function () {
    if (dragging >= 0) sim[dragging].fixed = false;
    dragging = -1;
    panning = null;
    canvas.classList.remove("dragging");
  });

  canvas.addEventListener("mouseleave", function () { hovered = -1; });

  canvas.addEventListener("click", function (event) {
    // A pan ends in a click; only treat it as a selection when it landed on a node.
    var found = hit(event);
    selected = found.index;
    if (found.index < 0) { panel.hidden = true; return; }
    showPanel(sim[found.index]);
  });

  canvas.addEventListener("wheel", function (event) {
    event.preventDefault();
    var at = pointer(event);
    var wx = toWorldX(at.x), wy = toWorldY(at.y);
    var next = view.scale * Math.exp(-event.deltaY * 0.0015);
    view.scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    // Keep the point under the cursor pinned to the cursor.
    view.tx = at.x - wx * view.scale;
    view.ty = at.y - wy * view.scale;
  }, { passive: false });

  document.getElementById("fit").addEventListener("click", fit);

  document.getElementById("hide-page-local").addEventListener("change", function (event) {
    hidePageLocal = event.target.checked;
    recomputeVisible();
    alpha = Math.max(alpha, 0.7);
    fit();
  });

  // ---------- legend ----------
  var legend = document.getElementById("legend");
  function legendChip(key, labelText, color, dashed) {
    var chip = document.createElement("button");
    chip.type = "button";
    chip.setAttribute("aria-pressed", "true");
    var swatch = document.createElement("i");
    swatch.className = "swatch";
    if (dashed) {
      swatch.style.border = "2px dashed " + color;
      swatch.style.background = "transparent";
    } else {
      swatch.style.background = color;
    }
    chip.appendChild(swatch);
    chip.appendChild(text("span", labelText));
    chip.addEventListener("click", function () {
      var on = chip.getAttribute("aria-pressed") === "true";
      chip.setAttribute("aria-pressed", on ? "false" : "true");
      if (key === null) danglingHidden = on;
      else if (on) hiddenTypes[key] = true;
      else delete hiddenTypes[key];
      recomputeVisible();
      alpha = Math.max(alpha, 0.7);
    });
    legend.appendChild(chip);
  }
  typeList.slice(0, 24).forEach(function (type) { legendChip(type, type, colorOf[type]); });
  if (map.summary.danglingCount > 0) {
    legendChip(null, "undeclared (dangling)", DANGLING_COLOR, true);
  }

  // ---------- detail panel ----------
  function listBlock(dl, label, values) {
    if (!values || values.length === 0) return;
    dl.appendChild(text("dt", label));
    var dd = document.createElement("dd");
    var ul = document.createElement("ul");
    values.forEach(function (value) { ul.appendChild(text("li", value)); });
    dd.appendChild(ul);
    dl.appendChild(dd);
  }

  function showPanel(simNode) {
    panel.hidden = false;
    panel.textContent = "";
    var close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "×";
    close.addEventListener("click", function () { panel.hidden = true; selected = -1; });
    panel.appendChild(close);

    if (!simNode.node) {
      panel.appendChild(text("h3", "Undeclared entity"));
      panel.appendChild(text("p", "Referenced by @id, but no crawled page declares it."));
      var dlMissing = document.createElement("dl");
      dlMissing.appendChild(text("dt", "@id"));
      dlMissing.appendChild(text("dd", simNode.label));
      panel.appendChild(dlMissing);
      return;
    }

    var node = simNode.node;
    panel.appendChild(text("h3", node.name || primaryType(node)));
    var types = document.createElement("div");
    node.types.forEach(function (type) { types.appendChild(text("span", type, "pill")); });
    panel.appendChild(types);

    var dl = document.createElement("dl");
    dl.appendChild(text("dt", "@id"));
    dl.appendChild(text("dd", node.id || "none — synthetic identity"));
    dl.appendChild(text("dt", "Occurrences"));
    dl.appendChild(text("dd", node.occurrences + " on " + (node.pages.length + node.morePages) + " page(s)"));

    ["url", "logo", "telephone", "email", "address", "description"].forEach(function (key) {
      if (node.properties[key] === undefined) return;
      dl.appendChild(text("dt", key));
      dl.appendChild(text("dd", node.properties[key]));
    });
    listBlock(dl, "image", node.properties.image);
    listBlock(dl, "sameAs", node.properties.sameAs);
    panel.appendChild(dl);

    if (node.conflicts.length > 0) {
      panel.appendChild(text("dt", "Conflicts"));
      node.conflicts.forEach(function (conflict) {
        var box = document.createElement("div");
        box.className = "conflict";
        box.appendChild(text("strong", conflict.property));
        conflict.values.forEach(function (entry) {
          box.appendChild(text("div", entry.value));
          var where = entry.pages.slice(0, 3).join(", ");
          var extra = entry.pages.length - 3 + entry.morePages;
          box.appendChild(text("div", "on " + where + (extra > 0 ? " +" + extra + " more" : ""), "note"));
        });
        panel.appendChild(box);
      });
    }

    var pages = node.pages.slice(0, 12);
    var dlPages = document.createElement("dl");
    listBlock(dlPages, "Declared on", pages.concat(
      node.pages.length + node.morePages > pages.length
        ? ["+" + (node.pages.length + node.morePages - pages.length) + " more"]
        : []
    ));
    panel.appendChild(dlPages);
  }

  // ---------- table ----------
  var COLUMNS = [
    { label: "Type", get: function (n) { return n.types.join(", "); }, cls: "" },
    { label: "Name", get: function (n) { return n.name || ""; }, cls: "" },
    { label: "@id", get: function (n) { return n.id || ""; }, cls: "id" },
    { label: "Occurrences", get: function (n) { return n.occurrences; }, cls: "num", numeric: true },
    { label: "Pages", get: function (n) { return n.pages.length + n.morePages; }, cls: "num", numeric: true },
    { label: "Conflicts", get: function (n) { return n.conflicts.length; }, cls: "num", numeric: true },
    { label: "Dangling", get: function (n) { return n.danglingRefs; }, cls: "num", numeric: true }
  ];
  var sortIndex = 3, sortDesc = true;

  var filter = document.getElementById("type-filter");
  var allOption = text("option", "All types");
  allOption.value = "";
  filter.appendChild(allOption);
  typeList.forEach(function (type) {
    var option = text("option", type);
    option.value = type;
    filter.appendChild(option);
  });
  var search = document.getElementById("search");

  var head = document.getElementById("thead-row");
  COLUMNS.forEach(function (column, index) {
    var th = text("th", column.label);
    var arrow = text("span", "", "arrow");
    th.appendChild(arrow);
    th.addEventListener("click", function () {
      if (sortIndex === index) { sortDesc = !sortDesc; }
      else { sortIndex = index; sortDesc = !!column.numeric; }
      renderTable();
    });
    head.appendChild(th);
  });

  var body = document.getElementById("tbody");
  var countLabel = document.getElementById("row-count");

  function renderTable() {
    var wantedType = filter.value;
    var needle = search.value.trim().toLowerCase();
    // The table is the complete list on purpose: whatever the graph is hiding,
    // every entity stays findable here.
    var rows = map.nodes.filter(function (node) {
      if (wantedType && node.types.indexOf(wantedType) === -1) return false;
      if (!needle) return true;
      return (node.name || "").toLowerCase().indexOf(needle) !== -1 ||
        (node.id || "").toLowerCase().indexOf(needle) !== -1 ||
        node.types.join(" ").toLowerCase().indexOf(needle) !== -1;
    });
    var column = COLUMNS[sortIndex];
    rows.sort(function (a, b) {
      var x = column.get(a), y = column.get(b);
      var cmp = column.numeric ? x - y : (x < y ? -1 : x > y ? 1 : 0);
      if (cmp === 0) cmp = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      return sortDesc ? -cmp : cmp;
    });

    body.textContent = "";
    rows.forEach(function (node) {
      var tr = document.createElement("tr");
      COLUMNS.forEach(function (col, index) {
        var value = col.get(node);
        var td = text("td", value === 0 && col.numeric && index >= 5 ? "" : value, col.cls);
        if (index === 5 && node.conflicts.length > 0) td.className += " flag warn";
        if (index === 6 && node.danglingRefs > 0) td.className += " flag";
        tr.appendChild(td);
      });
      tr.addEventListener("click", function () {
        var simIndex = indexOf[node.key];
        if (simIndex === undefined) { showPanel({ node: node, label: node.name }); return; }
        selected = simIndex;
        showPanel(sim[simIndex]);
        canvas.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      body.appendChild(tr);
    });
    countLabel.textContent = rows.length + " of " + map.nodes.length + " entities";
    for (var i = 0; i < COLUMNS.length; i++) {
      head.children[i].querySelector(".arrow").textContent =
        i === sortIndex ? (sortDesc ? " ▾" : " ▴") : "";
    }
  }

  filter.addEventListener("change", renderTable);
  search.addEventListener("input", renderTable);
  renderTable();

  if (map.nodes.length === 0) {
    // An empty graph and an empty table say less than one sentence does.
    document.getElementById("graph-section").hidden = true;
    document.getElementById("table-section").hidden = true;
    document.getElementById("empty").hidden = false;
  } else {
    if (map.nodes.length > GRAPH_NODE_CAP) {
      document.getElementById("graph-note").textContent +=
        " Showing the " + GRAPH_NODE_CAP + " entities with the most occurrences; the table below lists all " + map.nodes.length + ".";
    }
    window.addEventListener("resize", resize);
    resize();
    seed();
    recomputeVisible();
    // Settle the layout before the first paint, so the opening view is a graph
    // rather than an expanding spiral, and Fit has a real bounding box to use.
    for (var warm = 0; warm < 150; warm++) step();
    fit();
    frame();
  }
})();
`;

/**
 * Render a standalone, offline HTML view of an entity map.
 *
 * Returns a complete document. Nothing is fetched at runtime and the map is the
 * page's only data source.
 */
export function renderEntityMapHtml(map: EntityMap): string {
  const payload = escapeJsonForScript(JSON.stringify(map));
  const title = `Entity map: ${map.site}`;
  const script = SCRIPT.replace("__GRAPH_NODE_CAP__", String(GRAPH_NODE_CAP)).replace(
    "__PAGE_LOCAL_TYPES__",
    JSON.stringify(PAGE_LOCAL_TYPES),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <h1>Entity map</h1>
  <p class="sub"><span id="site"></span> &middot; generated <span id="generated"></span></p>

  <div class="cards" id="cards"></div>

  <section id="graph-section">
    <h2>Graph</h2>
    <div class="controls">
      <button type="button" class="action" id="fit">Fit</button>
      <label class="check"><input type="checkbox" id="hide-page-local"> Hide page-local entities</label>
      <span class="note" id="graph-count"></span>
    </div>
    <div class="graph-shell">
      <canvas id="graph"></canvas>
      <div id="panel" hidden></div>
    </div>
    <div class="legend" id="legend"></div>
    <p class="note" id="graph-note">Scroll to zoom, drag the background to pan, drag a node to pin it. Hover to highlight what a node references. Click for detail. Legend chips toggle a type.</p>
  </section>

  <div class="empty" id="empty" hidden>This site declares no JSON-LD entities.</div>

  <section id="table-section">
    <h2>Entities</h2>
    <div class="controls">
      <select id="type-filter" aria-label="Filter by type"></select>
      <input type="search" id="search" placeholder="Search name, @id or type" aria-label="Search entities">
      <span class="note" id="row-count"></span>
    </div>
    <div class="table-scroll">
      <table>
        <thead><tr id="thead-row"></tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
    <p class="note" id="table-note"></p>
  </section>
</div>

<script type="application/json" id="entity-map-data">${payload}</script>
<script>${script}</script>
</body>
</html>
`;
}
