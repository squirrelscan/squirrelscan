// The interactive Entities viewer (#2091): one force-directed graph plus a
// sortable table, inlined into the HTML report and into the standalone
// entity-map document.
//
// Lives in the report package because that is the only package both consumers
// can reach: `audit-engine` depends on `@squirrelscan/report`, never the other
// way round. One implementation, so the embedded section and the standalone
// page can never drift.
//
// Hard constraints:
//   - No network requests. No CDN, no external stylesheet, no runtime loads.
//     The report HTML is opened from disk and emailed around.
//   - Every id and class is `em-`-prefixed and the CSS is scoped under
//     `#em-root`, because this is injected into a page that already has its own
//     global stylesheet and its own `table`, `canvas` and `select` rules.
//   - Everything in the map comes from audited pages. The map reaches the page
//     as escaped JSON and reaches the DOM only through `textContent`.

import type { EntityMap } from "./types";

/** Nodes drawn in the force graph before it stops being readable (or fast). */
export const ENTITY_GRAPH_NODE_CAP = 400;

/**
 * Escape a JSON payload for embedding inside a `<script>` element.
 *
 * `</script`, `<!--` and the two JSON-legal-but-JS-illegal line separators all
 * end or corrupt the block; escaping `<`, `>` and `&` as `\uXXXX` is valid JSON
 * and neutralises every one of them.
 */
export function escapeEntityJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The map as the escaped JSON body of the viewer's data script. */
export function entityViewerData(map: EntityMap): string {
  return escapeEntityJsonForScript(JSON.stringify(map));
}

/** Scoped CSS for the viewer. Safe to inline next to any other stylesheet. */
export const ENTITY_VIEWER_STYLES = `
#em-root {
  --em-panel: #ffffff;
  --em-ink: #1c1c1a;
  --em-muted: #6b6b64;
  --em-line: #e2e2dc;
  --em-warn: #b3541e;
  --em-danger: #a32020;
  color: var(--em-ink);
  font-size: 14px;
}
#em-root * { box-sizing: border-box; }
#em-root .em-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
#em-root .em-card {
  background: var(--em-panel);
  border: 1px solid var(--em-line);
  border-radius: 8px;
  padding: 12px 14px;
}
#em-root .em-n { font-size: 22px; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
#em-root .em-l { color: var(--em-muted); font-size: 12px; margin-top: 2px; }
#em-root .em-shell { position: relative; }
#em-root canvas#em-graph {
  width: 100%;
  height: 560px;
  display: block;
  background: var(--em-panel);
  border: 1px solid var(--em-line);
  border-radius: 8px;
  cursor: grab;
  touch-action: none;
}
#em-root canvas#em-graph.em-dragging { cursor: grabbing; }
#em-root .em-legend { display: flex; flex-wrap: wrap; gap: 6px 8px; margin-top: 10px; }
#em-root .em-legend button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  font-size: 12px;
  color: var(--em-muted);
  background: var(--em-panel);
  border: 1px solid var(--em-line);
  border-radius: 999px;
  padding: 2px 10px 2px 8px;
  cursor: pointer;
}
#em-root .em-legend button:hover { color: var(--em-ink); }
#em-root .em-legend button[aria-pressed="false"] { opacity: 0.45; text-decoration: line-through; }
#em-root .em-swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
#em-root .em-note { color: var(--em-muted); font-size: 12px; margin-top: 8px; }
#em-root .em-action {
  font: inherit;
  font-size: 13px;
  padding: 5px 12px;
  border: 1px solid var(--em-line);
  border-radius: 6px;
  background: var(--em-panel);
  color: inherit;
  cursor: pointer;
}
#em-root .em-action:hover { border-color: var(--em-muted); }
#em-root .em-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
#em-root #em-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 330px;
  max-height: calc(100% - 24px);
  overflow: auto;
  background: var(--em-panel);
  border: 1px solid var(--em-line);
  border-radius: 8px;
  padding: 14px 16px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.09);
  font-size: 13px;
}
#em-root #em-panel h3 { margin: 0 8px 2px 0; font-size: 15px; word-break: break-word; }
#em-root #em-panel .em-close {
  float: right;
  border: 0;
  background: none;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  color: var(--em-muted);
}
#em-root #em-panel dt { color: var(--em-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 10px; }
#em-root #em-panel dd { margin: 2px 0 0; word-break: break-word; }
#em-root #em-panel ul { margin: 4px 0 0; padding-left: 16px; }
#em-root #em-panel li { word-break: break-all; margin-bottom: 2px; }
#em-root .em-pill {
  display: inline-block;
  border: 1px solid var(--em-line);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  margin: 0 4px 4px 0;
  background: #fbfbf9;
}
#em-root .em-conflict { border-left: 3px solid var(--em-warn); padding-left: 8px; margin-top: 6px; }
#em-root .em-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 10px 0; }
#em-root select, #em-root input[type="search"] {
  font: inherit;
  padding: 5px 8px;
  border: 1px solid var(--em-line);
  border-radius: 6px;
  background: var(--em-panel);
  color: inherit;
}
#em-root .em-scroll { overflow-x: auto; border: 1px solid var(--em-line); border-radius: 8px; background: var(--em-panel); }
#em-root .em-scroll table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 0; }
#em-root .em-scroll th, #em-root .em-scroll td {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--em-line);
  vertical-align: top;
}
#em-root .em-scroll th { cursor: pointer; user-select: none; white-space: nowrap; font-size: 12px; color: var(--em-muted); background: none; }
#em-root .em-scroll th:hover { color: var(--em-ink); }
#em-root .em-arrow { opacity: 0.45; }
#em-root .em-scroll tbody tr { cursor: pointer; }
#em-root .em-scroll tbody tr:hover { background: #fbfaf7; }
#em-root .em-num { text-align: right; font-variant-numeric: tabular-nums; }
#em-root .em-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--em-muted); word-break: break-all; max-width: 320px; }
#em-root .em-flag { color: var(--em-danger); font-weight: 600; }
#em-root .em-flag.em-warn { color: var(--em-warn); }
#em-root .em-empty { padding: 24px; text-align: center; color: var(--em-muted); }
`;

const SCRIPT = String.raw`
(function () {
  "use strict";
  var host = document.getElementById("em-data");
  if (!host) return;
  var map = JSON.parse(host.textContent);
  var GRAPH_NODE_CAP = __GRAPH_NODE_CAP__;

  var PALETTE = [
    "#9a4b1f", "#2f6f4f", "#2d5d86", "#7a3d78", "#8a7318",
    "#3f6d6d", "#8d3b4a", "#4a5a2c", "#6b5b8a", "#a15c2a"
  ];
  var DANGLING_COLOR = "#a32020";
  var MIN_ZOOM = 0.15, MAX_ZOOM = 6;
  // Labelling every visible node at fit scale makes the dense centre
  // unreadable, and a plain zoom threshold is all-or-nothing: at 49 nodes every
  // label appears at once. So the budget is a COUNT, not a switch — the N
  // best-connected entities get a label, and N grows with the square of the
  // zoom because the readable area does too. The hovered node, its neighbours
  // and the selected node are always labelled, at any zoom.
  var LABEL_BUDGET_AT_FIT = 12;

  // Neighbours of the hovered node that get a label, beyond the hovered node
  // itself. Highlighting is unbounded — every neighbour stays bright, which is
  // what makes the shape of the relationship readable — but labels are not.
  // Matches the dashboard.
  var HOVER_LABEL_BUDGET = 12;

  function el(id) { return document.getElementById(id); }
  function setText(id, value) { var node = el(id); if (node) node.textContent = value; }

  // Present only in the standalone document; the report has its own header.
  setText("em-site", map.site);
  setText("em-generated", map.generatedAt);

  function primaryType(node) { return (node.types && node.types[0]) || "Thing"; }

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
    var node = document.createElement(tag);
    node.textContent = value == null ? "" : String(value);
    if (className) node.className = className;
    return node;
  }

  // ---------- summary cards ----------
  var s = map.summary;
  var cards = [
    ["Entities", s.nodeCount],
    ["References", s.edgeCount],
    ["Conflicts", s.conflictCount],
    ["Dangling refs", s.danglingCount],
    ["No @id", s.nodesWithoutIdCount],
    ["Stable @id", Math.round(s.stableIdShare * 100) + "%"]
  ];
  var cardHost = el("em-cards");
  if (cardHost) {
    cards.forEach(function (card) {
      var box = document.createElement("div");
      box.className = "em-card";
      box.appendChild(text("div", card[1], "em-n"));
      box.appendChild(text("div", card[0], "em-l"));
      cardHost.appendChild(box);
    });
  }

  // ---------- graph model ----------
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
      pageLocal: !!node.pageLocal,
      dangling: false,
      // Drives both the radius and the label budget below.
      occurrences: node.occurrences,
      labelRank: Infinity,
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
          // An undeclared target has no occurrences of its own, so it never
          // wins a label on reach — only by being hovered or selected.
          occurrences: 0,
          labelRank: Infinity,
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

  var canvas = el("em-graph");
  var panel = el("em-panel");
  var ctx = canvas ? canvas.getContext("2d") : null;
  var width = 0, height = 0, dpr = 1;
  var hovered = -1, selected = -1, dragging = -1, panning = null;

  // ---------- visibility ----------
  var hiddenTypes = Object.create(null);
  // Dangling placeholders get their own flag rather than a key in hiddenTypes:
  // type names come from audited pages, so any sentinel string could collide
  // with a real @type.
  var danglingHidden = false;
  // Page-local entities (per-page types and unnamed images) outnumber the
  // site's actual subject matter, so the graph starts without them.
  var showPageLocal = false;
  var visibleIdx = [], visibleLinks = [], neighbours = null, neighbourFocus = -2;
  // The subset of neighbours that also earns a label. Separate because
  // highlighting and labelling answer different questions: one is "what is
  // connected to this", the other is "what can you read without it turning to
  // soup". No backticks in here: this whole script is a template literal and
  // one would close it, with the syntax error reported far from this line.
  var neighbourLabels = null;

  function nodeVisible(n) {
    if (n.dangling) return !danglingHidden;
    if (hiddenTypes[n.legendType]) return false;
    if (!showPageLocal && n.pageLocal) return false;
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

    // Rank among what is ACTUALLY drawn, not among all nodes: hiding the
    // page-local entities should promote the site's real subjects into the
    // label budget rather than leave them ranked behind hidden furniture.
    var byReach = visibleIdx.slice().sort(function (a, b) {
      return sim[b].occurrences - sim[a].occurrences ||
        (sim[a].key < sim[b].key ? -1 : sim[a].key > sim[b].key ? 1 : 0);
    });
    // A node with no name labels as its bare @type, so a site with 40 unnamed
    // Offers would spend the whole budget drawing the word "Offer" forty times.
    // Reach still decides the order; a repeated label just yields its turn to
    // the next distinct one and takes a rank behind every unique label.
    var usedLabels = Object.create(null);
    var unique = [], repeated = [];
    for (var i = 0; i < byReach.length; i++) {
      var label = sim[byReach[i]].label;
      if (usedLabels[label]) repeated.push(byReach[i]);
      else { usedLabels[label] = true; unique.push(byReach[i]); }
    }
    var ordered = unique.concat(repeated);
    for (var r = 0; r < ordered.length; r++) sim[ordered[r]].labelRank = r;

    neighbourFocus = -2;
    if (hovered >= 0 && !shown[hovered]) hovered = -1;
    if (selected >= 0 && !shown[selected]) { selected = -1; if (panel) panel.hidden = true; }
    updateCounts();
  }

  function updateCounts() {
    var hiddenCount = sim.length - visibleIdx.length;
    setText("em-count", visibleIdx.length + " of " + sim.length + " drawn" +
      (hiddenCount > 0 ? " · " + hiddenCount + " hidden" : ""));
    var pageLocalTotal = 0;
    for (var i = 0; i < sim.length; i++) if (sim[i].pageLocal) pageLocalTotal++;
    setText("em-table-note", showPageLocal
      ? "Showing all " + map.nodes.length + " entities, including the " + pageLocalTotal + " page-local ones (per-page types and unnamed images)."
      : pageLocalTotal + " page-local entities (per-page types and unnamed images) are hidden from both the graph and the table. Tick the box to include them.");
  }

  // ---------- view transform ----------
  var view = { scale: 1, tx: 0, ty: 0 };
  // The scale the last Fit settled on, and the anchor the label budget is
  // measured against. Updated by fit(), so hiding a type or toggling the
  // page-local filter re-anchors it too.
  var fitScale = 1;
  function toScreenX(x) { return x * view.scale + view.tx; }
  function toScreenY(y) { return y * view.scale + view.ty; }
  function toWorldX(sx) { return (sx - view.tx) / view.scale; }
  function toWorldY(sy) { return (sy - view.ty) / view.scale; }

  function fit() {
    if (visibleIdx.length === 0) {
      view.scale = 1; view.tx = 0; view.ty = 0; fitScale = 1;
      return;
    }
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
    fitScale = view.scale;
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
    var list = [];
    if (focus >= 0) {
      set[focus] = true;
      for (var k = 0; k < visibleLinks.length; k++) {
        var link = visibleLinks[k];
        var other = link.a === focus ? link.b : link.b === focus ? link.a : -1;
        if (other >= 0 && !set[other]) {
          set[other] = true;
          list.push(other);
        }
      }
    }
    neighbours = set;
    // Highlighting every neighbour is right; LABELLING every neighbour is not.
    // Hovering a hub — a WebSite referenced by all 60 pages, an Organization on
    // 39 — granted sixty labels at once and reproduced exactly the unreadable
    // centre the label budget exists to prevent, just triggered by the pointer
    // instead of by zoom. Cap the granted labels at the best-connected few.
    //
    // labelRank is the occurrences ordering computed once per filter, so this
    // sorts a small array of indices rather than re-ranking anything.
    list.sort(function (a, b) {
      return sim[a].labelRank - sim[b].labelRank;
    });
    var labelled = Object.create(null);
    if (focus >= 0) labelled[focus] = true;
    for (var j = 0; j < list.length && j < HOVER_LABEL_BUDGET; j++) {
      labelled[list[j]] = true;
    }
    neighbourLabels = labelled;
    neighbourFocus = focus;
    return set;
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    var focus = focusIndex();
    var near = neighboursOf(focus);
    // RELATIVE to the fit scale, not to 1: "fit" is whatever zoom made the
    // graph fill the canvas, which is well above 1 for a small graph and below
    // it for a large one. Anchoring here is what makes the budget exactly
    // LABEL_BUDGET_AT_FIT on first paint for every site. Squared, because
    // zooming in grows BOTH dimensions of the readable area: 12 at fit, 27 at
    // 1.5x fit, 48 at 2x.
    var zoom = view.scale / fitScale;
    var labelBudget = Math.round(LABEL_BUDGET_AT_FIT * zoom * zoom);
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
      // A label is EARNED by reach, or GRANTED outright to whatever the reader
      // is pointing at: the focus, the selection, and the best-connected
      // HOVER_LABEL_BUDGET of its neighbours. Every neighbour stays bright
      // regardless; only the labels are capped, because sixty of them at once
      // is the unreadable centre this budget exists to prevent.
      // An earned label is dropped while its node is dimmed — a bright label on
      // a faded dot reads as noise, and dimmed means "not relevant right now".
      var granted =
        index === focus ||
        index === selected ||
        (focus >= 0 && neighbourLabels !== null && neighbourLabels[index]);
      if (granted || (n.labelRank < labelBudget && !dim)) {
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
    if (!panel) return;
    panel.hidden = false;
    panel.textContent = "";
    var close = document.createElement("button");
    close.className = "em-close";
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
    node.types.forEach(function (type) { types.appendChild(text("span", type, "em-pill")); });
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
        box.className = "em-conflict";
        box.appendChild(text("strong", conflict.property));
        conflict.values.forEach(function (entry) {
          box.appendChild(text("div", entry.value));
          var where = entry.pages.slice(0, 3).join(", ");
          var extra = entry.pages.length - 3 + entry.morePages;
          box.appendChild(text("div", "on " + where + (extra > 0 ? " +" + extra + " more" : ""), "em-note"));
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

  // ---------- canvas interaction ----------
  if (canvas && ctx) {
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
      canvas.classList.add("em-dragging");
    });

    window.addEventListener("mouseup", function () {
      if (dragging >= 0) sim[dragging].fixed = false;
      dragging = -1;
      panning = null;
      canvas.classList.remove("em-dragging");
    });

    canvas.addEventListener("mouseleave", function () { hovered = -1; });

    canvas.addEventListener("click", function (event) {
      var found = hit(event);
      selected = found.index;
      if (found.index < 0) { if (panel) panel.hidden = true; return; }
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
  }

  var fitButton = el("em-fit");
  if (fitButton) fitButton.addEventListener("click", fit);

  var pageLocalToggle = el("em-show-page-local");
  if (pageLocalToggle) {
    pageLocalToggle.addEventListener("change", function (event) {
      showPageLocal = event.target.checked;
      recomputeVisible();
      // One control for the whole section: the table filters with the graph.
      renderTable();
      alpha = Math.max(alpha, 0.7);
      fit();
    });
  }

  // ---------- legend ----------
  var legend = el("em-legend");
  function legendChip(key, labelText, color, dashed) {
    if (!legend) return;
    var chip = document.createElement("button");
    chip.type = "button";
    chip.setAttribute("aria-pressed", "true");
    var swatch = document.createElement("i");
    swatch.className = "em-swatch";
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

  // ---------- table ----------
  var COLUMNS = [
    { label: "Type", get: function (n) { return n.types.join(", "); }, cls: "" },
    { label: "Name", get: function (n) { return n.name || ""; }, cls: "" },
    { label: "@id", get: function (n) { return n.id || ""; }, cls: "em-id" },
    { label: "Occurrences", get: function (n) { return n.occurrences; }, cls: "em-num", numeric: true },
    { label: "Pages", get: function (n) { return n.pages.length + n.morePages; }, cls: "em-num", numeric: true },
    { label: "Conflicts", get: function (n) { return n.conflicts.length; }, cls: "em-num", numeric: true },
    { label: "Dangling", get: function (n) { return n.danglingRefs; }, cls: "em-num", numeric: true }
  ];
  var sortIndex = 3, sortDesc = true;
  var tableExpanded = false;
  var TABLE_LIMIT = __TABLE_LIMIT__;

  var filter = el("em-type-filter");
  if (filter) {
    var allOption = text("option", "All types");
    allOption.value = "";
    filter.appendChild(allOption);
    typeList.forEach(function (type) {
      var option = text("option", type);
      option.value = type;
      filter.appendChild(option);
    });
  }
  var search = el("em-search");
  var head = el("em-thead-row");
  var body = el("em-tbody");

  if (head) {
    COLUMNS.forEach(function (column, index) {
      var th = text("th", column.label);
      th.appendChild(text("span", "", "em-arrow"));
      th.addEventListener("click", function () {
        if (sortIndex === index) { sortDesc = !sortDesc; }
        else { sortIndex = index; sortDesc = !!column.numeric; }
        renderTable();
      });
      head.appendChild(th);
    });
  }

  function renderTable() {
    if (!body) return;
    var wantedType = filter ? filter.value : "";
    var needle = search ? search.value.trim().toLowerCase() : "";
    // Same page-local filter as the graph, so the section reads as one thing.
    // A site with 188 entities is 139 unnamed images and per-page furniture;
    // printing all of them into the report buries the 49 that matter.
    var rows = map.nodes.filter(function (node) {
      if (!showPageLocal && node.pageLocal) return false;
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

    // Capped by default: the report is a document, not a database browser.
    // The standalone squirrel entities command is the full table (#2092).
    var shown = tableExpanded ? rows : rows.slice(0, TABLE_LIMIT);
    var showAll = el("em-show-all");
    if (showAll) {
      showAll.hidden = rows.length <= TABLE_LIMIT;
      showAll.textContent = tableExpanded
        ? "Show top " + TABLE_LIMIT
        : "Show all " + rows.length;
    }

    body.textContent = "";
    shown.forEach(function (node) {
      var tr = document.createElement("tr");
      COLUMNS.forEach(function (col, index) {
        var value = col.get(node);
        var td = text("td", value === 0 && col.numeric && index >= 5 ? "" : value, col.cls);
        if (index === 5 && node.conflicts.length > 0) td.className += " em-flag em-warn";
        if (index === 6 && node.danglingRefs > 0) td.className += " em-flag";
        tr.appendChild(td);
      });
      tr.addEventListener("click", function () {
        var simIndex = indexOf[node.key];
        if (simIndex === undefined) { showPanel({ node: node, label: node.name }); return; }
        selected = simIndex;
        showPanel(sim[simIndex]);
        if (canvas) canvas.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      body.appendChild(tr);
    });
    setText(
      "em-row-count",
      shown.length + " of " + rows.length + " shown · " + map.nodes.length + " total"
    );
    if (head) {
      for (var i = 0; i < COLUMNS.length; i++) {
        head.children[i].querySelector(".em-arrow").textContent =
          i === sortIndex ? (sortDesc ? " ▾" : " ▴") : "";
      }
    }
  }

  if (filter) filter.addEventListener("change", renderTable);
  if (search) search.addEventListener("input", renderTable);
  var showAllButton = el("em-show-all");
  if (showAllButton) {
    showAllButton.addEventListener("click", function () {
      tableExpanded = !tableExpanded;
      renderTable();
    });
  }
  renderTable();

  if (map.nodes.length === 0 || !canvas || !ctx) {
    // An empty graph and an empty table say less than one sentence does.
    var graphSection = el("em-graph-section");
    if (graphSection) graphSection.hidden = true;
    if (map.nodes.length === 0) {
      var tableSection = el("em-table-section");
      if (tableSection) tableSection.hidden = true;
      var empty = el("em-empty");
      if (empty) empty.hidden = false;
    }
    return;
  }

  if (map.nodes.length > GRAPH_NODE_CAP) {
    var note = el("em-note");
    if (note) {
      note.textContent += " Showing the " + GRAPH_NODE_CAP +
        " entities with the most occurrences; the table below lists all " + map.nodes.length + ".";
    }
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
})();
`;

/** Rows the embedded table shows before "Show all N" is pressed. */
export const ENTITY_TABLE_ROW_CAP = 25;

/** The viewer's JavaScript, with its compile-time constants substituted. */
export function entityViewerScript(): string {
  return SCRIPT.replace("__GRAPH_NODE_CAP__", String(ENTITY_GRAPH_NODE_CAP)).replace(
    "__TABLE_LIMIT__",
    String(ENTITY_TABLE_ROW_CAP),
  );
}

/**
 * The viewer's markup, without the data or the script.
 *
 * Returned as a string rather than JSX so the standalone document and the React
 * report can both use it. The report wraps it in `dangerouslySetInnerHTML`; the
 * content here is a fixed literal with nothing interpolated into it, and every
 * site-controlled value is written by the script through `textContent`.
 *
 * `standaloneHeader` adds the site and timestamp line the standalone document
 * needs and the report does not, since the report already has its own header.
 */
export function entityViewerMarkup(standaloneHeader = false): string {
  const header = standaloneHeader
    ? `  <p class="em-note" id="em-header"><span id="em-site"></span> &middot; generated <span id="em-generated"></span></p>\n`
    : "";
  return `<div id="em-root">
${header}  <div class="em-cards" id="em-cards"></div>

  <div id="em-graph-section">
    <div class="em-controls">
      <button type="button" class="em-action" id="em-fit">Fit</button>
      <label class="em-check"><input type="checkbox" id="em-show-page-local"> Show page-local entities</label>
      <span class="em-note" id="em-count"></span>
    </div>
    <div class="em-shell">
      <canvas id="em-graph"></canvas>
      <div id="em-panel" hidden></div>
    </div>
    <div class="em-legend" id="em-legend"></div>
    <p class="em-note" id="em-note">Scroll to zoom, drag the background to pan, drag a node to pin it. Hover to highlight what a node references. Click for detail. Legend chips toggle a type.</p>
  </div>

  <div class="em-empty" id="em-empty" hidden>This site declares no JSON-LD entities.</div>

  <div id="em-table-section">
    <div class="em-controls">
      <select id="em-type-filter" aria-label="Filter entities by type"></select>
      <input type="search" id="em-search" placeholder="Search name, @id or type" aria-label="Search entities">
      <button type="button" class="em-action" id="em-show-all" hidden></button>
      <span class="em-note" id="em-row-count"></span>
    </div>
    <div class="em-scroll">
      <table>
        <thead><tr id="em-thead-row"></tr></thead>
        <tbody id="em-tbody"></tbody>
      </table>
    </div>
    <p class="em-note" id="em-table-note"></p>
  </div>
</div>`;
}
