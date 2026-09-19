const roleLabels = {
  site_header: "Header",
  footer: "Footer",
  sidebar: "Sidebar",
  aside: "Sidebar",
  main_content: "Main content",
  article_header: "Article header",
  hero: "Hero",
  top_banner: "Top banner",
  bottom_banner: "Bottom banner",
  overlay: "Overlay",
  article_body: "Article body",
  advertisement: "Advertisement",
  product_gallery: "Product gallery",
  product_buy_box: "Product buy box",
  product_details: "Product details",
  product_reviews: "Product reviews",
  author_bio: "Author bio",
  related_content: "Related content",
  comments: "Comments",
  card: "Card",
  form: "Form",
  consent_banner: "Consent",
  navigation: "Navigation",
  content: "Main content",
  input: "Form",
  consent: "Consent",
  promotion: "Promotion",
  announcement: "Announcement",
  authentication: "Sign-in / authentication",
  subscription: "Subscription",
  feedback: "Feedback",
  support: "Support",
  advertising: "Advertising",
  purchase: "Purchase",
  media_playback: "Media playback",
  review: "Reviews",
  information: "Information",
  editorial: "Editorial",
  instruction: "Instruction",
  product_information: "Product information",
  comparison: "Comparison",
  social_proof: "Social proof",
  decorative: "Decorative",
  unknown: "Unsure",
};
const fallbackRegions = [
  "site_header",
  "footer",
  "sidebar",
  "main_content",
  "article_header",
  "hero",
  "top_banner",
  "bottom_banner",
  "overlay",
  "article_body",
  "advertisement",
  "product_gallery",
  "product_buy_box",
  "product_details",
  "product_reviews",
  "author_bio",
  "related_content",
  "comments",
  "unknown",
];
const fallbackFunctions = [
  "navigation",
  "submit",
  "search",
  "filter",
  "consent",
  "share",
  "account",
  "dismiss",
  "download",
  "toggle",
  "promotion",
  "announcement",
  "authentication",
  "subscription",
  "feedback",
  "support",
  "advertising",
  "purchase",
  "media_playback",
  "review",
  "information",
  "editorial",
  "instruction",
  "product_information",
  "comparison",
  "social_proof",
  "unknown",
];
const componentGroups = {
  Primitive: [
    "button",
    "link",
    "input",
    "checkbox",
    "radio",
    "select",
    "toggle",
    "heading",
    "text",
    "icon",
    "image",
  ],
  "Composed controls": ["search", "dropdown", "tabs", "accordion", "pagination"],
  Content: [
    "card",
    "form",
    "list",
    "table",
    "article",
    "media",
    "hero",
    "navigation_menu",
    "content_section",
    "media_gallery",
    "purchase_panel",
    "specification_list",
    "rating_summary",
    "review_list",
    "video_player",
    "audio_player",
    "author_card",
    "comment_thread",
  ],
  "Structure & overlays": [
    "layout_container",
    "dialog",
    "drawer",
    "tooltip",
    "notification",
    "banner",
    "popover",
    "ad_unit",
    "unknown",
  ],
};
const subtypeOptions = {
  button: ["primary", "secondary", "icon"],
  input: ["text", "search", "email", "password", "number"],
  card: ["product", "article", "result"],
  navigation_menu: ["main", "footer", "breadcrumb"],
  form: ["search", "sign_in", "contact", "newsletter", "checkout"],
  dialog: ["modal", "non_modal"],
  banner: ["announcement", "promotional", "cookie_consent"],
  ad_unit: ["display", "sponsored_content"],
  media_gallery: ["product", "editorial", "portfolio"],
  purchase_panel: ["product", "subscription"],
  drawer: ["navigation", "cart", "preferences"],
  popover: ["menu", "help"],
  content_section: [
    "features",
    "benefits",
    "pricing",
    "testimonials",
    "faq",
    "logo_cloud",
    "team",
    "contact",
    "related_content",
    "call_to_action",
  ],
};
const stateTypes = ["visible", "disabled", "expanded", "selected", "open", "sticky", "unknown"];
const fallbackPageTypes = [
  "homepage",
  "about",
  "contact",
  "pricing",
  "product_detail",
  "listing",
  "features",
  "services",
  "solutions",
  "use_cases",
  "integrations",
  "download",
  "docs",
  "tutorial",
  "api",
  "blog_index",
  "post",
  "news_index",
  "article",
  "changelog",
  "careers",
  "job",
  "events",
  "community",
  "search",
  "account",
  "auth",
  "checkout",
  "legal",
  "support",
  "faq",
  "status",
  "case_study",
  "directory",
  "profile",
  "dashboard",
  "other",
  "unknown",
];
const fallbackContentKinds = [
  "article",
  "product",
  "person",
  "event",
  "review",
  "offer",
  "job",
  "software",
  "service",
  "organization",
  "reference",
  "other",
  "unknown",
];
const fallbackContexts = ["site", "article", "main", "header", "footer", "unknown"];
const boundaryOptions = ["correct", "too_broad", "too_narrow", "mixed", "unsure"];
const state = {
  pages: [],
  roles: [],
  regions: [],
  functions: [],
  purposes: [],
  contexts: [],
  componentSubtypes: {},
  statefulComponentTypes: {},
  pageTypes: [],
  pageTypeGroups: [],
  contentKinds: [],
  page: null,
  currentPageIndex: 0,
  nodes: [],
  annotations: [],
  pageAnnotations: [],
  modelSuggestions: [],
  modelReviews: [],
  stats: null,
  selectedId: null,
  hoverId: null,
  saving: false,
  dirty: false,
  pageDirty: false,
  pageDraft: { pageTypes: [], contentKinds: [], comment: "" },
  pendingAction: null,
  pagePendingAction: null,
  modelReview: null,
  pageModelReview: null,
  // Blind review hides annotator names and shuffles the comparison columns, so
  // a reviewer cannot systematically favour one annotator.
  blind: new URLSearchParams(location.search).get("blind") === "1",
  autoModelDraft: false,
  autoPageModelDraft: false,
  // Start in the fast review queue when this capture has model sidecars.
  advanceModelOnLoad: true,
  advancePageModelOnLoad: false,
  skippedModelSuggestionIds: new Set(),
  lastFocusedModelSuggestionId: null,
  lastUndoableReview: null,
  undoRestoring: false,
  labelMode: "element",
  zoom: "fit",
  loadGeneration: 0,
  pickerMode: "sections",
  queueQuery: "",
};
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
};
function csrfToken() {
  return (
    document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("labeler_csrf="))
      ?.slice("labeler_csrf=".length) || ""
  );
}
function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method && options.method !== "GET") headers.set("x-labeler-csrf", csrfToken());
  return fetch(path, { ...options, headers, credentials: "same-origin" }).then(async (response) => {
    if (!response.ok) throw new Error((await response.text()) || "Request failed");
    return response.json();
  });
}
function safeImageUrl(value) {
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin ? url.href : null;
  } catch {
    return null;
  }
}
function selectedNode() {
  return state.nodes.find((node) => node.id === state.selectedId) || null;
}
function nodeById(id) {
  return state.nodes.find((node) => node.id === id) || null;
}
function isVisibleCaptureNode(node) {
  const rect = node?.rect;
  return Boolean(
    rect &&
    state.page &&
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x < state.page.width &&
    rect.y < state.page.height &&
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0,
  );
}
function annotationFor(id) {
  return [...state.annotations].reverse().find((annotation) => annotation.nodeId === id) || null;
}
function modelSuggestionFor(id) {
  return (
    [...state.modelSuggestions]
      .reverse()
      .find(
        (suggestion) =>
          suggestion.pageId === state.page?.id &&
          suggestion.nodeId === id &&
          suggestion.captureHash === state.page?.captureHash,
      ) || null
  );
}
function pageModelSuggestionFor() {
  return (
    [...state.modelSuggestions]
      .reverse()
      .find(
        (suggestion) =>
          suggestion.pageId === state.page?.id &&
          !suggestion.nodeId &&
          suggestion.captureHash === state.page?.captureHash,
      ) || null
  );
}
function savedModelReviewFor(suggestion) {
  return state.modelReviews.find((review) => review.modelSuggestionId === suggestion?.id) || null;
}
function isSkippedModelSuggestion(suggestion) {
  return Boolean(suggestion && state.skippedModelSuggestionIds.has(suggestion.id));
}
function latestModelSuggestionsForCurrentPage() {
  const seen = new Set();
  const latest = [];
  for (let index = state.modelSuggestions.length - 1; index >= 0; index -= 1) {
    const suggestion = state.modelSuggestions[index];
    if (!suggestion.nodeId || !nodeById(suggestion.nodeId) || seen.has(suggestion.nodeId)) continue;
    seen.add(suggestion.nodeId);
    latest.push(suggestion);
  }
  return latest.reverse();
}
function modelName(suggestion) {
  return suggestion?.modelId === "jev" ? "Jev" : suggestion?.modelId || "Model";
}
/** Every suggestion for this node on the current capture, in sidecar order. */
function modelSuggestionsFor(id) {
  return state.modelSuggestions.filter(
    (suggestion) =>
      suggestion.pageId === state.page?.id &&
      suggestion.nodeId === id &&
      suggestion.captureHash === state.page?.captureHash,
  );
}
/** Stable 32-bit hash, so blind ordering is reproducible for a given node. */
function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
/**
 * Two or more competing suggestions for one node, in display order.
 *
 * In blind mode the left/right order is flipped by a hash of the node id: the
 * reviewer cannot learn which annotator sits on which side, and the order is
 * the same every time the same item is shown. Nothing extra is stored, because
 * each saved review names the real suggestion id.
 */
function comparisonSuggestions(node) {
  if (!node || !isVisibleCaptureNode(node)) return null;
  // Two rows from the SAME model are a superseded version plus its latest, which
  // the queue already resolves to the latest. Only rows from different sources
  // are a disagreement, so keep the latest per source and compare those.
  const latestBySource = new Map();
  for (const suggestion of modelSuggestionsFor(node.id))
    latestBySource.set(suggestion.modelId, suggestion);
  if (latestBySource.size < 2) return null;
  const ordered = [...latestBySource.values()].slice(0, 2);
  return state.blind && stableHash(node.id) % 2 === 1 ? [ordered[1], ordered[0]] : ordered;
}
/** Axis values that differ between the two suggestions, for highlighting. */
function comparisonDifferences(suggestions) {
  const [first, second] = suggestions.map(mappedModelLabels);
  const set = (values) => (values || []).slice().sort().join("|");
  return {
    regions: set(first.regions) !== set(second.regions),
    componentType: (first.componentType || "") !== (second.componentType || ""),
    purposes: set(first.purposes) !== set(second.purposes),
  };
}
function roleText(role) {
  return roleLabels[role] || role || "Unsure";
}
function selectedValues(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(
    (input) => input.value,
  );
}
function hintLabels(role) {
  const normalized = role === "aside" ? "sidebar" : role;
  if (fallbackRegions.includes(normalized)) return { regions: [normalized], functions: [] };
  if (normalized === "consent_banner")
    return { regions: [], functions: ["consent_banner"], purposes: ["consent"] };
  return {
    regions: [],
    functions: ["navigation", "card", "form", "unknown"].includes(normalized) ? [normalized] : [],
    purposes: fallbackFunctions.includes(normalized) ? [normalized] : [],
  };
}
function hintComponentType(role) {
  return role === "consent_banner" ? "banner" : ["card", "form"].includes(role) ? role : "";
}
function legacyFunctionProjection(annotation) {
  const functions = Array.isArray(annotation.functions) ? annotation.functions : [];
  return {
    functions,
    purposes: functions.flatMap((value) =>
      value === "navigation"
        ? ["navigation"]
        : value === "consent_banner"
          ? ["consent"]
          : value === "unknown"
            ? ["unknown"]
            : [],
    ),
    componentType: functions.includes("card")
      ? "card"
      : functions.includes("form")
        ? "form"
        : functions.includes("consent_banner")
          ? "banner"
          : "",
  };
}
function mergeHint(selected, hint) {
  if (!hint.length) return selected;
  const concrete = hint.filter((value) => value !== "unknown");
  return [
    ...new Set([...selected.filter((value) => !(concrete.length && value === "unknown")), ...hint]),
  ];
}
function setChecked(name, values) {
  for (const input of document.querySelectorAll(`input[name="${name}"]`))
    input.checked = values.includes(input.value);
}
function showStatus(message, kind = "") {
  const target = $("save-status");
  target.textContent = message;
  target.dataset.kind = kind;
}
function renderUndoAction() {
  const button = $("undo-last-review");
  button.disabled = !state.lastUndoableReview || state.saving || state.undoRestoring;
}
function rememberUndoableReview(action) {
  state.lastUndoableReview = {
    pageId: state.page.id,
    pageIndex: state.currentPageIndex,
    nodeId: action.nodeId ?? null,
    captureHash: state.page.captureHash,
    labelMode: action.nodeId ? "element" : "page",
    summaryDelta: action.summaryDelta || 0,
    action: { kind: action.kind, id: action.id },
  };
  renderUndoAction();
}
async function undoLastReview() {
  const last = state.lastUndoableReview;
  if (!last || state.saving || state.undoRestoring) return;
  if (state.dirty || state.pageDirty) {
    showStatus("Finish or discard the current draft before undoing", "error");
    return;
  }
  state.saving = true;
  state.undoRestoring = true;
  renderUndoAction();
  showStatus("Undoing last review…");
  try {
    const response = await api("/api/review-actions/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageId: last.pageId,
        nodeId: last.nodeId,
        captureHash: last.captureHash,
        action: last.action,
      }),
    });
    state.saving = false;
    if (response.stats) {
      state.stats = response.stats;
      renderStats();
    }
    const restore = () => {
      const summary = state.pages[last.pageIndex];
      if (summary && last.summaryDelta) {
        if (last.action.kind === "annotation")
          summary.reviewedCount = Math.max(0, (summary.reviewedCount || 0) - last.summaryDelta);
        if (last.action.kind === "page_annotation")
          summary.pageReviewedCount = Math.max(
            0,
            (summary.pageReviewedCount || 0) - last.summaryDelta,
          );
      }
      state.annotations = response.annotations || [];
      state.pageAnnotations = response.pageAnnotations || [];
      state.modelReviews = response.modelReviews || [];
      if (last.labelMode === "page") {
        setLabelMode("page");
        renderPageLabel();
      } else {
        setLabelMode("element");
        if (last.nodeId) selectNode(last.nodeId);
      }
      renderQueue();
      renderSelection();
      syncNodeStates();
    };
    if (state.page?.id === last.pageId) restore();
    else {
      state.advanceModelOnLoad = false;
      state.advancePageModelOnLoad = false;
      await loadPage(last.pageIndex);
      if (state.page?.id !== last.pageId) throw new Error("Undo target did not reload");
      restore();
    }
    state.lastUndoableReview = null;
    showStatus("Last review undone", "success");
  } catch {
    showStatus("Couldn’t undo the last review. Try again.", "error");
  } finally {
    state.saving = false;
    state.undoRestoring = false;
    renderUndoAction();
  }
}
function renderStats() {
  const details = $("queue-stats"),
    summary = $("stats-summary"),
    human = $("stats-human-labels"),
    actions = $("stats-model-actions"),
    note = $("stats-model-note");
  const stats = state.stats;
  details.hidden = !stats;
  if (!stats) return;
  const reviewed =
    Number(stats.suggestions?.reviewed?.accepted || 0) +
    Number(stats.suggestions?.reviewed?.corrected || 0) +
    Number(stats.suggestions?.reviewed?.rejected || 0);
  const pending = Number(stats.suggestions?.pending || 0);
  summary.textContent = `${reviewed} reviewed · ${pending} pending`;
  human.textContent = `Human labels: ${Number(stats.pages?.currentPageLabels || 0)} / ${Number(stats.pages?.total || 0)} pages · ${Number(stats.elements?.currentHumanLabels || 0)} / ${Number(stats.elements?.total || 0)} elements`;
  const parts = [
    `${reviewed} reviewed`,
    `${Number(stats.suggestions?.reviewed?.accepted || 0)} accepted`,
    `${Number(stats.suggestions?.reviewed?.corrected || 0)} corrected`,
    `${Number(stats.suggestions?.reviewed?.rejected || 0)} rejected`,
    `${pending} pending`,
  ];
  actions.textContent = `Suggestions: ${Number(stats.suggestions?.total || 0)} (${Number(stats.suggestions?.page || 0)} page · ${Number(stats.suggestions?.element || 0)} element) · ${parts.join(" · ")}`;
  if (!reviewed)
    note.textContent =
      "No model-review percentages yet. Provisional suggestions are not human labels.";
  else {
    const accepted = Number(stats.suggestions?.reviewed?.accepted || 0),
      corrected = Number(stats.suggestions?.reviewed?.corrected || 0),
      rejected = Number(stats.suggestions?.reviewed?.rejected || 0);
    note.textContent = `Of reviewed suggestions: ${Math.round((accepted / reviewed) * 100)}% accepted · ${Math.round((corrected / reviewed) * 100)}% corrected · ${Math.round((rejected / reviewed) * 100)}% rejected. Provisional suggestions are not human labels.`;
  }
}
async function refreshStats() {
  try {
    state.stats = await api("/api/stats");
    renderStats();
  } catch {
    /* Stats are supplemental; labelling remains available while they load. */
  }
}
function setFormError(message = "") {
  const target = $("form-error");
  target.textContent = message;
  target.hidden = !message;
}
function setPageFormError(message = "") {
  const target = $("page-form-error");
  target.textContent = message;
  target.hidden = !message;
}
function pageAnnotationFor() {
  return [...state.pageAnnotations].reverse()[0] || null;
}
function markModelLabelsEdited() {
  state.dirty = true;
  state.autoModelDraft = false;
  if (state.modelReview?.review === "accept") {
    state.modelReview.review = "correct";
    renderModelSuggestion(selectedNode());
  }
}
function markPageModelLabelsEdited() {
  state.pageDirty = true;
  state.autoPageModelDraft = false;
  if (state.pageModelReview?.review === "accept") {
    state.pageModelReview.review = "correct";
    renderPageModelSuggestion();
  }
}
function updatePageDraftAxis(name, value, checked) {
  const values = new Set(state.pageDraft[name] || []);
  if (checked) {
    if (value === "unknown") {
      values.clear();
      values.add(value);
    } else {
      values.delete("unknown");
      values.add(value);
    }
  } else values.delete(value);
  state.pageDraft[name] = [...values];
  markPageModelLabelsEdited();
  setPageFormError();
}

function renderLabelOptions() {
  const addOptions = (gridId, name, values) => {
    const grid = $(gridId);
    grid.replaceChildren();
    for (const value of values) {
      const input = el("input", { type: "checkbox", name, value, id: `${name}-${value}` });
      input.addEventListener("change", () => {
        if (input.checked) {
          const siblings = [...document.querySelectorAll(`input[name="${name}"]`)];
          if (input.value === "unknown")
            siblings
              .filter((item) => item !== input)
              .forEach((item) => {
                item.checked = false;
              });
          else
            siblings
              .filter((item) => item.value === "unknown")
              .forEach((item) => {
                item.checked = false;
              });
        }
        $("save-button").disabled = !selectedNode();
        setFormError();
      });
      grid.append(
        el("label", { className: "role-option", for: input.id }, [
          input,
          el("span", { text: roleText(value) }),
        ]),
      );
    }
  };
  addOptions("regions-grid", "regions", state.regions.length ? state.regions : fallbackRegions);
  addOptions(
    "functions-grid",
    "purposes",
    state.purposes.length ? state.purposes : fallbackFunctions,
  );
  const context = $("context-select");
  context.replaceChildren(el("option", { value: "", text: "Choose context…" }));
  for (const item of state.contexts.length ? state.contexts : fallbackContexts)
    context.append(
      el("option", {
        value: item,
        text: item === "unknown" ? "Unsure" : item[0].toUpperCase() + item.slice(1),
      }),
    );
  const boundaries = $("boundary-options");
  boundaries.replaceChildren();
  for (const boundary of boundaryOptions) {
    const input = el("input", {
      type: "radio",
      name: "boundary",
      value: boundary,
      id: `boundary-${boundary}`,
    });
    if (boundary === "correct") input.checked = true;
    boundaries.append(
      el("label", { for: input.id }, [input, el("span", { text: boundary.replace("_", " ") })]),
    );
  }
}
function pageTypeLabel(value) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function subtypeLabel(value) {
  return (
    {
      modal: "Modal",
      non_modal: "Non-modal",
      cookie_consent: "Cookie consent",
      logo_cloud: "Customer / partner logos",
      related_content: "Related content",
      call_to_action: "Call to action",
    }[value] || pageTypeLabel(value)
  );
}
function renderPageCheckboxes(gridId, name, values) {
  const grid = $(gridId);
  grid.replaceChildren();
  for (const value of values) {
    const input = el("input", { type: "checkbox", name, value, id: `${name}-${value}` });
    input.checked = (state.pageDraft[name] || []).includes(value);
    input.addEventListener("change", () => {
      updatePageDraftAxis(name, value, input.checked);
      renderPageLabelDraft(name);
    });
    grid.append(
      el("label", { className: "role-option", for: input.id }, [
        input,
        el("span", { text: pageTypeLabel(value) }),
      ]),
    );
  }
}
function renderPageTypes(query = "") {
  const needle = query.trim().toLowerCase();
  const groups = state.pageTypeGroups.length
    ? state.pageTypeGroups
    : [
        {
          label: "Page types",
          values: state.pageTypes.length ? state.pageTypes : fallbackPageTypes,
        },
      ];
  const grid = $("page-types-grid");
  grid.replaceChildren();
  for (const group of groups) {
    const matches = (group.values || []).filter(
      (value) => value.includes(needle) || pageTypeLabel(value).toLowerCase().includes(needle),
    );
    if (!matches.length) continue;
    grid.append(el("p", { className: "component-group", text: group.label }));
    const row = el("div", { className: "role-grid" });
    for (const value of matches) {
      const input = el("input", {
        type: "checkbox",
        name: "pageTypes",
        value,
        id: `pageTypes-${value}`,
      });
      input.checked = state.pageDraft.pageTypes.includes(value);
      input.addEventListener("change", () => {
        updatePageDraftAxis("pageTypes", value, input.checked);
        renderPageLabelDraft("pageTypes");
      });
      row.append(
        el("label", { className: "role-option", for: input.id }, [
          input,
          el("span", { text: pageTypeLabel(value) }),
        ]),
      );
    }
    grid.append(row);
  }
  renderPageLabelDraft("pageTypes");
}
function renderPageLabelDraft(axis) {
  for (const input of document.querySelectorAll(`input[name="${axis}"]`))
    input.checked = (state.pageDraft[axis] || []).includes(input.value);
}
function applyAutomaticPageModelDraft() {
  const suggestion = pageModelSuggestionFor();
  if (!suggestion || savedModelReviewFor(suggestion) || !hasApplicableModelLabels(suggestion, true))
    return;
  const labels = mappedModelLabels(suggestion);
  state.pageDraft.pageTypes = [...(labels.pageTypes || [])];
  state.pageDraft.contentKinds = [...(labels.contentKinds || [])];
  state.pageModelReview = { suggestionId: suggestion.id, review: "accept" };
  state.autoPageModelDraft = true;
}
function renderPageLabel() {
  const annotation = pageAnnotationFor();
  state.pageDraft = {
    pageTypes: [...(annotation?.pageTypes || [])],
    contentKinds: [...(annotation?.contentKinds || [])],
    comment: annotation?.comment || "",
  };
  state.pageModelReview =
    annotation?.modelSuggestionId && annotation?.modelReview
      ? { suggestionId: annotation.modelSuggestionId, review: annotation.modelReview }
      : null;
  state.autoPageModelDraft = false;
  if (!annotation) applyAutomaticPageModelDraft();
  $("page-annotation-form").reset();
  renderPageTypes($("page-type-search").value);
  renderPageCheckboxes(
    "content-kinds-grid",
    "contentKinds",
    state.contentKinds.length ? state.contentKinds : fallbackContentKinds,
  );
  $("page-comment").value = state.pageDraft.comment;
  state.pageDirty = false;
  state.pagePendingAction = null;
  $("page-unsaved-notice").hidden = true;
  const review = $("page-review-state");
  review.hidden = !annotation;
  if (annotation)
    review.textContent = annotation.comment
      ? "Page label saved · comment saved"
      : "Page label saved";
  renderPageModelSuggestion();
}
function componentLabel(type) {
  const labels = {
    button: "Button",
    link: "Link",
    input: "Input",
    checkbox: "Checkbox",
    radio: "Radio",
    select: "Select",
    toggle: "Toggle",
    heading: "Heading",
    text: "Text",
    icon: "Icon",
    image: "Image",
    search: "Search",
    dropdown: "Dropdown",
    tabs: "Tabs",
    accordion: "Accordion",
    pagination: "Pagination",
    card: "Card",
    form: "Form",
    list: "List",
    table: "Table",
    article: "Article",
    media: "Media",
    hero: "Hero",
    navigation_menu: "Navigation menu",
    content_section: "Content section",
    layout_container: "Layout container",
    dialog: "Dialog (modal/popup)",
    drawer: "Drawer",
    tooltip: "Tooltip",
    notification: "Notification",
    banner: "Banner",
    popover: "Popover",
    ad_unit: "Ad unit",
    media_gallery: "Media gallery",
    purchase_panel: "Purchase panel",
    specification_list: "Specification list",
    rating_summary: "Rating summary",
    review_list: "Review list",
    video_player: "Video player",
    audio_player: "Audio player",
    author_card: "Author card",
    comment_thread: "Comment thread",
    unknown: "Unknown",
  };
  return labels[type] || type.replaceAll("_", " ");
}
function renderComponentOptions(query = "") {
  const container = $("component-options");
  container.replaceChildren();
  const needle = query.trim().toLowerCase();
  for (const [group, types] of Object.entries(componentGroups)) {
    const matches = types.filter(
      (type) => type.includes(needle) || componentLabel(type).toLowerCase().includes(needle),
    );
    if (!matches.length) continue;
    container.append(el("p", { className: "component-group", text: group }));
    const row = el("div", { className: "component-option-row" });
    for (const type of matches)
      row.append(
        el("button", {
          type: "button",
          className: `component-option${$("component-type").value === type ? " selected" : ""}`,
          text: componentLabel(type),
          onClick: () => setComponentType(type, true),
        }),
      );
    container.append(row);
  }
}
function setComponentType(type = "", userChanged = false) {
  $("component-type").value = type;
  $("component-trigger").textContent = type ? componentLabel(type) : "Choose a component type…";
  $("component-trigger").classList.toggle("chosen", Boolean(type));
  const subtype = $("component-subtype"),
    subtypeWrap = $("subtype-wrap");
  subtype.replaceChildren(el("option", { value: "", text: "No specific variant" }));
  const availableSubtypes = state.componentSubtypes[type] || subtypeOptions[type] || [];
  for (const value of availableSubtypes)
    subtype.append(el("option", { value, text: subtypeLabel(value) }));
  subtypeWrap.hidden = !availableSubtypes.length;
  const stateWrap = $("state-wrap"),
    stateOptions = $("state-options");
  stateOptions.replaceChildren();
  const applicable = Object.entries(state.statefulComponentTypes)
    .filter(([, types]) => Array.isArray(types) && types.includes(type))
    .map(([value]) => value);
  for (const value of applicable) {
    const input = el("input", {
      type: "checkbox",
      name: "observedState",
      value,
      id: `state-${value}`,
    });
    input.addEventListener("change", () => {
      if (input.checked) {
        const all = [...document.querySelectorAll('input[name="observedState"]')];
        if (value === "unknown")
          all
            .filter((item) => item !== input)
            .forEach((item) => {
              item.checked = false;
            });
        else
          all
            .filter((item) => item.value === "unknown")
            .forEach((item) => {
              item.checked = false;
            });
      }
      markModelLabelsEdited();
      setFormError();
    });
    stateOptions.append(el("label", { for: input.id }, [input, el("span", { text: value })]));
  }
  stateWrap.hidden = !applicable.length;
  if (userChanged) markModelLabelsEdited();
  renderComponentOptions($("component-search").value);
}
function componentTypeForLegacy(annotation) {
  if (annotation.componentType) return annotation.componentType;
  if (typeof annotation.componentProjection === "string") return annotation.componentProjection;
  if (annotation.componentProjection?.componentType)
    return annotation.componentProjection.componentType;
  return ["card", "form", "button", "link", "input"].includes(annotation.role)
    ? annotation.role
    : "";
}
function renderQueue() {
  const list = $("page-list");
  list.replaceChildren();
  const total = state.pages.length;
  const reviewed = state.pages.filter((page) => (page.pageReviewedCount || 0) > 0).length;
  $("queue-count").textContent = `${total} pages`;
  $("reviewed-progress").textContent = `${reviewed} / ${total}`;
  $("progress-bar").style.width = `${total ? Math.round((reviewed / total) * 100) : 0}%`;
  $("progress-copy").textContent = reviewed
    ? `${total - reviewed} pages waiting for a page label`
    : "Page labels have not started";
  state.pages.forEach((page, index) => {
    if (
      !`${page.title || ""} ${page.url || ""} ${page.sourceKind || ""}`
        .toLowerCase()
        .includes(state.queueQuery)
    )
      return;
    const item = el("button", {
      type: "button",
      className: `page-item${index === state.currentPageIndex ? " active" : ""}`,
      "aria-current": index === state.currentPageIndex ? "page" : "false",
      onClick: () => loadPage(index),
    });
    let title = page.title || "Captured page";
    if (!page.title) {
      try {
        title = new URL(page.url || location.href).hostname;
      } catch {
        /* use the safe fallback */
      }
    }
    item.append(
      el("span", { className: "page-item-title", text: title }),
      el("span", {
        className: "page-item-meta",
        text: `${page.pageReviewedCount || 0} page · ${page.reviewedCount || 0} elements · ${formatDate(page.capturedAt)}`,
      }),
    );
    list.append(item);
  });
}
function formatDate(value) {
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
      new Date(value),
    );
  } catch {
    return "Captured";
  }
}
function renderStage() {
  // The screenshot's onload can fire after the page was cleared or replaced,
  // and this dereferences state.page. Without the guard that throws
  // "Cannot read properties of null (reading 'width')" and the node layer is
  // never drawn, so nothing on the capture is selectable.
  if (!state.page) return;
  $("screenshot-stage").style.width =
    state.zoom === "fit"
      ? "100%"
      : `${Math.round((state.page.width * Number(state.zoom)) / 100)}px`;
  const layer = $("node-layer");
  layer.replaceChildren();
  for (const node of state.nodes) {
    if (!isVisibleCaptureNode(node)) continue;
    const region = el("div", {
      className: "node-region",
      "data-node-id": node.id,
      "data-node-tag": `<${node.tag || "div"}>`,
    });
    region.style.left = `${(node.rect.x / state.page.width) * 100}%`;
    region.style.top = `${(node.rect.y / state.page.height) * 100}%`;
    region.style.width = `${(node.rect.width / state.page.width) * 100}%`;
    region.style.height = `${(node.rect.height / state.page.height) * 100}%`;
    layer.append(region);
  }
  syncNodeStates();
  focusSelectedNode();
}
function syncNodeStates() {
  for (const region of $("node-layer").children) {
    const id = region.dataset.nodeId;
    const isCurrentTarget = state.labelMode === "element" && id === state.selectedId;
    const reviewingModel = Boolean(
      state.labelMode === "element" && modelSuggestionFor(state.selectedId),
    );
    region.classList.toggle("selected", isCurrentTarget);
    region.classList.toggle("model-target", isCurrentTarget && reviewingModel);
    region.classList.toggle(
      "hovered",
      state.labelMode === "element" && !reviewingModel && id === state.hoverId && !isCurrentTarget,
    );
    region.classList.toggle(
      "labeled",
      !reviewingModel && !isCurrentTarget && Boolean(annotationFor(id)),
    );
  }
}
function centerSelectedNode(nodeId, suggestionId, pageId) {
  if (
    state.labelMode !== "element" ||
    state.selectedId !== nodeId ||
    state.page?.id !== pageId ||
    modelSuggestionFor(nodeId)?.id !== suggestionId
  )
    return;
  const region = $("node-layer").querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
  const canvas = $("canvas-scroll");
  if (!region || !canvas) return;
  const target = region.getBoundingClientRect();
  const viewport = canvas.getBoundingClientRect();
  canvas.scrollTo({
    left: Math.max(
      0,
      canvas.scrollLeft + target.left - viewport.left - (canvas.clientWidth - target.width) / 2,
    ),
    top: Math.max(
      0,
      canvas.scrollTop + target.top - viewport.top - (canvas.clientHeight - target.height) / 2,
    ),
    behavior: "instant",
  });
}
function focusSelectedNode() {
  if (state.labelMode !== "element") return;
  const node = selectedNode();
  const suggestion = node && modelSuggestionFor(node.id);
  if (!node || !suggestion || !isVisibleCaptureNode(node)) return;
  const region = $("node-layer").querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
  const image = $("page-image");
  if (!region || !image.clientWidth || !image.clientHeight) return;
  const isNewModelTarget = state.lastFocusedModelSuggestionId !== suggestion.id;
  if (isNewModelTarget) {
    state.lastFocusedModelSuggestionId = suggestion.id;
    const fitScale = (($("canvas-scroll").clientWidth * 0.85) / state.page.width) * 100;
    const shortestSide = Math.min(node.rect.width, node.rect.height);
    const targetPercent = Math.min(200, Math.max(50, (32 / shortestSide) * 100));
    if (shortestSide * (fitScale / 100) < 32) {
      const zoomLevels = [50, 75, 100, 150, 200];
      const zoom = zoomLevels.find((level) => level >= targetPercent) || 200;
      state.zoom = String(zoom);
      $("zoom-select").value = state.zoom;
      renderStage();
      return;
    }
    state.zoom = "fit";
    $("zoom-select").value = state.zoom;
    renderStage();
    return;
  }
  centerSelectedNode(node.id, suggestion.id, state.page.id);
}
function findPointNode(event) {
  const image = $("page-image"),
    rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = ((event.clientX - rect.left) / rect.width) * state.page.width;
  const y = ((event.clientY - rect.top) / rect.height) * state.page.height;
  if (x < 0 || y < 0 || x > state.page.width || y > state.page.height) return null;
  const matches = state.nodes
    .filter(
      (node) =>
        node.rect &&
        x >= node.rect.x &&
        y >= node.rect.y &&
        x <= node.rect.x + node.rect.width &&
        y <= node.rect.y + node.rect.height,
    )
    .sort(
      (a, b) =>
        (b.depth || 0) - (a.depth || 0) ||
        a.rect.width * a.rect.height - b.rect.width * b.rect.height,
    );
  const fine = matches[0];
  if (!fine) return null;
  if (state.pickerMode === "elements") {
    const controls = new Set(["button", "a", "input", "select", "textarea", "summary"]);
    const roles = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem"]);
    let element = fine;
    while (element) {
      if (controls.has(element.tag) || roles.has(element.role)) return element;
      element = nodeById(element.parentId);
    }
    return fine;
  }
  const coherent = new Set([
    "header",
    "footer",
    "nav",
    "main",
    "section",
    "article",
    "aside",
    "form",
    "body",
  ]);
  let candidate = fine;
  while (candidate) {
    if (
      coherent.has(candidate.tag) ||
      (candidate.tag === "div" && state.nodes.some((node) => node.parentId === candidate.id))
    )
      return candidate;
    candidate = nodeById(candidate.parentId);
  }
  return fine;
}
function updateHover(event) {
  const node = findPointNode(event);
  const id = node?.id || null;
  if (state.hoverId !== id) {
    state.hoverId = id;
    syncNodeStates();
  }
}
function showUnsavedNotice(show) {
  $("unsaved-notice").hidden = !show;
}
function attemptTransition(action) {
  if (state.saving) {
    showStatus("Finishing the current save…");
    return false;
  }
  if (state.dirty && selectedNode()) {
    state.pendingAction = action;
    showUnsavedNotice(true);
    return false;
  }
  const result = action();
  return result instanceof Promise ? result : true;
}
function applyClearSelection() {
  state.selectedId = null;
  state.hoverId = null;
  state.dirty = false;
  state.modelReview = null;
  state.autoModelDraft = false;
  $("annotation-form").reset();
  setComponentType();
  $("component-picker").hidden = true;
  $("component-trigger").setAttribute("aria-expanded", "false");
  $("component-projection").hidden = true;
  $("legacy-purpose-projection").hidden = true;
  $("save-button").disabled = true;
  $("advanced-options").open = false;
  setFormError();
  showUnsavedNotice(false);
  renderSelection();
  syncNodeStates();
}
function clearSelection() {
  attemptTransition(applyClearSelection);
}
function applyAutomaticModelDraft(node) {
  const suggestion = modelSuggestionFor(node.id);
  if (!suggestion || savedModelReviewFor(suggestion) || !hasApplicableModelLabels(suggestion))
    return;
  const labels = mappedModelLabels(suggestion);
  setChecked("regions", labels.regions || []);
  setChecked("purposes", labels.purposes || []);
  setComponentType(labels.componentType || "");
  state.modelReview = { suggestionId: suggestion.id, review: "accept" };
  state.autoModelDraft = true;
}
function applySelection(id) {
  state.selectedId = id;
  state.hoverId = null;
  state.dirty = false;
  state.modelReview = null;
  state.autoModelDraft = false;
  const existing = annotationFor(id);
  $("annotation-form").reset();
  setComponentType();
  $("component-picker").hidden = true;
  $("component-trigger").setAttribute("aria-expanded", "false");
  $("component-projection").hidden = true;
  $("legacy-purpose-projection").hidden = true;
  if (existing) hydrateForm(existing);
  else {
    const node = nodeById(id);
    if (node) applyAutomaticModelDraft(node);
  }
  $("save-button").disabled = false;
  setFormError();
  showUnsavedNotice(false);
  renderSelection();
  syncNodeStates();
  focusSelectedNode();
}
function selectNode(id) {
  return attemptTransition(() => applySelection(id));
}
function hydrateForm(annotation) {
  const legacy = hintLabels(annotation.role);
  const functionProjection = legacyFunctionProjection(annotation);
  if (!Array.isArray(annotation.regions) && fallbackRegions.includes(annotation.context))
    legacy.regions = mergeHint(legacy.regions, [annotation.context]);
  setChecked("regions", Array.isArray(annotation.regions) ? annotation.regions : legacy.regions);
  const projectedPurposes = annotation.purposeProjection?.purposes;
  setChecked(
    "purposes",
    Array.isArray(annotation.purposes) && annotation.purposes.length
      ? annotation.purposes
      : Array.isArray(projectedPurposes) && projectedPurposes.length
        ? projectedPurposes
        : mergeHint(legacy.purposes || [], functionProjection.purposes),
  );
  $("context-select").value = annotation.context || "";
  const boundary = [...$("annotation-form").elements.boundary].find(
    (item) => item.value === annotation.boundary,
  );
  if (boundary) boundary.checked = true;
  $("comment").value = annotation.comment || "";
  const componentType = componentTypeForLegacy(annotation) || functionProjection.componentType;
  setComponentType(componentType);
  $("component-projection").hidden = Boolean(annotation.componentType) || !componentType;
  $("component-subtype").value = annotation.componentSubtype || "";
  setChecked(
    "observedState",
    Array.isArray(annotation.observedState) ? annotation.observedState : [],
  );
  state.modelReview =
    annotation.modelSuggestionId && annotation.modelReview
      ? { suggestionId: annotation.modelSuggestionId, review: annotation.modelReview }
      : null;
  const projectionNote = $("legacy-purpose-projection");
  if (functionProjection.functions.length) {
    projectionNote.textContent = `Earlier function label: ${functionProjection.functions.map(roleText).join(" + ")}. It remains in the revision history; this form saves its equivalent under Purpose or Component type.`;
    projectionNote.hidden = false;
  }
}
function renderSelection() {
  const node = selectedNode();
  $("selection-empty").hidden = Boolean(node);
  $("selection-details").hidden = !node;
  $("parent-button").disabled = !node || !node.parentId || !nodeById(node.parentId);
  const children = node ? state.nodes.filter((candidate) => candidate.parentId === node.id) : [];
  $("child-button").disabled = !children.length;
  $("node-depth").textContent = node ? `Depth ${node.depth ?? "—"}` : "";
  const breadcrumbs = $("breadcrumbs");
  breadcrumbs.replaceChildren();
  if (!node) breadcrumbs.append(el("span", { className: "muted", text: "No section selected" }));
  else {
    const chain = [];
    let cursor = node;
    while (cursor && chain.length < 6) {
      chain.unshift(cursor);
      cursor = nodeById(cursor.parentId);
    }
    chain.forEach((item, index) => {
      if (index)
        breadcrumbs.append(
          el("span", { className: "breadcrumb-arrow", text: "›", "aria-hidden": "true" }),
        );
      breadcrumbs.append(
        el("button", {
          type: "button",
          className: `breadcrumb${item.id === node.id ? " current" : ""}`,
          text: item.tag || "div",
          onClick: () => selectNode(item.id),
        }),
      );
    });
    $("selected-tag").textContent = `<${node.tag || "div"}>`;
    $("selected-text").textContent = node.text
      ? truncate(node.text, 145)
      : "No safe text preview for this section.";
    $("observed-semantics").textContent =
      `Captured semantics: <${node.tag || "div"}>${node.role ? ` · ARIA ${node.role}` : ""}`;
  }
  if (!node) $("observed-semantics").textContent = "";
  const childOptions = $("child-options");
  childOptions.replaceChildren();
  for (const child of children.slice(0, 8))
    childOptions.append(
      el("button", {
        type: "button",
        className: "child-option",
        text: `<${child.tag}>`,
        onClick: () => selectNode(child.id),
      }),
    );
  renderSuggestion(node);
  renderModelSuggestion(node);
  const annotation = node && annotationFor(node.id);
  const review = $("review-state");
  review.hidden = !annotation;
  if (annotation) {
    const labels = [
      ...(annotation.regions || []),
      ...(annotation.purposes || annotation.functions || []),
    ];
    const decision =
      annotation.decision === "reject"
        ? "Rule hint set aside"
        : annotation.decision === "accept"
          ? "Rule hint accepted"
          : annotation.decision === "unsure"
            ? "Marked unsure"
            : `Saved as ${labels.map(roleText).join(" + ") || roleText(annotation.role)}`;
    review.textContent = annotation.comment ? `${decision} · comment saved` : decision;
  }
}
function mappedModelLabels(suggestion) {
  return suggestion.mappedLabels || {};
}
function hasApplicableModelLabels(suggestion, pageLevel = false) {
  const labels = mappedModelLabels(suggestion);
  return pageLevel
    ? Boolean(labels.pageTypes?.length || labels.contentKinds?.length)
    : Boolean(labels.regions?.length || labels.purposes?.length || labels.componentType);
}
function modelSuggestionLabels(suggestion) {
  const labels = mappedModelLabels(suggestion),
    result = [];
  for (const value of labels.regions || []) result.push(`Region: ${roleText(value)}`);
  for (const value of labels.purposes || []) result.push(`Purpose: ${roleText(value)}`);
  for (const value of labels.functions || []) result.push(`Legacy function: ${roleText(value)}`);
  if (labels.componentType) result.push(`Component: ${componentLabel(labels.componentType)}`);
  for (const value of labels.pageTypes || []) result.push(`Page type: ${pageTypeLabel(value)}`);
  for (const value of labels.contentKinds || []) result.push(`Content: ${pageTypeLabel(value)}`);
  return result;
}
function renderModelLabelChips(id, suggestion) {
  const target = $(id);
  target.replaceChildren();
  const labels = modelSuggestionLabels(suggestion);
  if (!labels.length) {
    target.append(el("span", { className: "model-label-chip empty", text: "No mapped labels" }));
    return;
  }
  for (const label of labels)
    target.append(el("span", { className: "model-label-chip", text: label }));
}
function savedReviewForTarget(suggestion, annotation) {
  const standalone = savedModelReviewFor(suggestion);
  if (standalone) return standalone;
  if (annotation?.modelSuggestionId === suggestion?.id && annotation.modelReview)
    return { review: annotation.modelReview };
  return null;
}
function proposalText(values, format) {
  const items = (values || []).map(format).filter(Boolean);
  return items.length ? items.join(" · ") : "Not suggested";
}
function renderElementProposal(node, suggestion) {
  const labels = mappedModelLabels(suggestion);
  const regions = proposalText(labels.regions, roleText);
  const component = labels.componentType ? componentLabel(labels.componentType) : "Not suggested";
  const purposes = proposalText(labels.purposes, roleText);
  $("model-proposal-region").textContent = regions;
  $("model-proposal-component").textContent = component;
  $("model-proposal-purpose").textContent = purposes;
  const tag = `<${node.tag || "div"}>`;
  $("model-review-question").textContent =
    component !== "Not suggested" && regions !== "Not suggested"
      ? `Is this a ${component.toLowerCase()} in the ${regions.toLowerCase()}?`
      : component !== "Not suggested"
        ? `Is this selected ${tag} a ${component.toLowerCase()}?`
        : regions !== "Not suggested"
          ? `Is this selected ${tag} in the ${regions.toLowerCase()}?`
          : `Does this selected ${tag} match Jev's proposal?`;
}
function renderPageProposal(suggestion) {
  const labels = mappedModelLabels(suggestion);
  $("page-model-proposal-type").textContent = proposalText(labels.pageTypes, pageTypeLabel);
  $("page-model-proposal-content").textContent = proposalText(labels.contentKinds, pageTypeLabel);
}
/**
 * Side-by-side review for a node two annotators disagreed about.
 *
 * The reviewer approves one or rejects both, so neither suggestion is treated
 * as a default and no agreement between them is implied.
 */
function renderSuggestionComparison(node) {
  const section = $("suggestion-comparison-section");
  const suggestions = comparisonSuggestions(node);
  const list = $("suggestion-comparison-list");
  section.hidden = !suggestions;
  if (!suggestions) {
    // Clear on the way out, or a hidden panel keeps the previous node's options.
    list.replaceChildren();
    return;
  }
  const annotation = node && annotationFor(node.id);
  const settled = suggestions.some((item) => savedReviewForTarget(item, annotation));
  const existingHumanLabel = Boolean(annotation && !settled);
  const differences = comparisonDifferences(suggestions);
  list.replaceChildren();
  suggestions.forEach((suggestion, index) => {
    const saved = savedReviewForTarget(suggestion, annotation);
    const card = el("div", {
      className: `comparison-card${saved?.review === "accept" ? " accepted" : ""}`,
    });
    card.dataset.suggestionId = suggestion.id;
    card.dataset.choice = String(index + 1);
    const labels = mappedModelLabels(suggestion);
    card.append(
      el("div", { className: "comparison-source" }, [
        el("span", {
          className: "comparison-key",
          text: String(index + 1),
        }),
        el("span", {
          className: "comparison-name",
          // Blind mode hides which annotator produced which column.
          text: state.blind ? `Option ${index + 1}` : modelName(suggestion),
        }),
      ]),
    );
    const rows = [
      ["Page region", proposalText(labels.regions, roleText), differences.regions],
      [
        "Element type",
        labels.componentType ? componentLabel(labels.componentType) : "Not suggested",
        differences.componentType,
      ],
      ["Purpose", proposalText(labels.purposes, roleText), differences.purposes],
    ];
    const definition = el("dl", { className: "comparison-axes" });
    for (const [term, value, differs] of rows)
      definition.append(
        el("div", { className: differs ? "comparison-axis differs" : "comparison-axis" }, [
          el("dt", { text: term }),
          el("dd", { text: value }),
        ]),
      );
    card.append(definition);
    const button = el("button", {
      type: "button",
      className: "comparison-accept",
      text: saved?.review === "accept" ? "Accepted" : `Accept (${index + 1})`,
    });
    button.disabled =
      settled || existingHumanLabel || !hasApplicableModelLabels(suggestion);
    button.addEventListener("click", () => acceptComparisonSuggestion(index + 1));
    card.append(button);
    list.append(card);
  });
  const rejectBoth = $("comparison-reject-both");
  rejectBoth.disabled = settled || existingHumanLabel;
  // The container-versus-section boundary is the disagreement these cohorts are
  // mostly made of, so show its rule from LABEL-DEFINITIONS.md right here.
  const choices = new Set(
    suggestions.map((item) => mappedModelLabels(item).componentType).filter(Boolean),
  );
  const boundary =
    choices.size === 2 && choices.has("layout_container") && choices.has("content_section");
  const guidance = $("comparison-guidance");
  guidance.hidden = !boundary;
  if (boundary)
    guidance.textContent =
      "Boundary rule: a content section has one subject of its own; a layout container only groups or positions other things. Site chrome such as a footer or masthead is a layout container. A <main> is a layout container when it wraps several sections, and a content section when it is itself one body of content. If still tied, choose layout container.";
  $("suggestion-comparison-status").textContent = settled
    ? "Human review saved for this element."
    : existingHumanLabel
      ? "A human label is already saved. Open the advanced editor to revise it."
      : state.blind
        ? "Blind review: sources are hidden. Accept one option or reject both."
        : "Two annotators disagree. Accept one or reject both; neither is a default.";
}
function renderModelSuggestion(node) {
  const comparison = comparisonSuggestions(node);
  renderSuggestionComparison(node);
  const section = $("model-suggestion-section"),
    // A disagreement is reviewed in the comparison panel instead, so the
    // single-suggestion panel stays hidden and its behaviour is unchanged.
    suggestion = !comparison && node && isVisibleCaptureNode(node) && modelSuggestionFor(node.id);
  section.hidden = !suggestion;
  if (!suggestion) return;
  $("model-suggestion-model").textContent = [suggestion.modelId, suggestion.modelRevision]
    .filter(Boolean)
    .join(" · ");
  $("model-suggestion-copy").textContent = suggestion.rawClass || "Provisional model output";
  $("model-suggestion-context").textContent =
    `Selected <${node.tag || "div"}>${node.role ? ` · ARIA ${node.role}` : ""}`;
  renderElementProposal(node, suggestion);
  renderModelLabelChips("model-suggestion-chips", suggestion);
  const review = state.modelReview?.suggestionId === suggestion.id ? state.modelReview.review : "";
  const annotation = annotationFor(node.id);
  const saved = savedReviewForTarget(suggestion, annotation);
  const applicable = hasApplicableModelLabels(suggestion);
  const existingHumanLabel = Boolean(annotation && !saved);
  $("model-ok").disabled = !applicable || Boolean(saved) || existingHumanLabel;
  $("model-not-ok").disabled = Boolean(saved) || existingHumanLabel;
  $("model-skip").disabled = Boolean(saved) || existingHumanLabel;
  $("model-ok").textContent = saved?.review === "accept" ? "OK saved" : "OK (Enter)";
  $("model-not-ok").textContent = saved?.review === "reject" ? "Not OK saved" : "Not OK (X)";
  $("model-suggestion-status").textContent = saved
    ? `Human review saved: ${saved.review === "accept" ? "OK" : saved.review === "reject" ? "Not OK" : "edited"}.`
    : existingHumanLabel
      ? "A human label is already saved. Open the advanced editor to revise it."
      : "These are provisional model labels. OK saves these exact labels as a human acceptance; Not OK records a rejection without adding a replacement label.";
  $("use-model-suggestion").disabled = !applicable;
  $("use-model-suggestion").textContent = !applicable
    ? "No applicable labels"
    : review === "accept" && state.autoModelDraft
      ? `${modelName(suggestion)} suggestion preselected`
      : review === "correct"
        ? "Reset to suggestion"
        : "Use suggestion";
  $("use-model-suggestion").title = applicable
    ? ""
    : "This model response has no labels to add to a human draft.";
  $("correct-model-suggestion").textContent =
    review === "correct" ? "Manual correction selected" : "Correct manually";
  $("reject-model-suggestion").textContent = review === "reject" ? "Marked Not OK" : "Mark Not OK";
  $("save-model-rejection").hidden = review !== "reject" || Boolean(saved);
}
function chooseModelReview(review) {
  const node = selectedNode(),
    suggestion = node && modelSuggestionFor(node.id);
  if (!node || !suggestion) return;
  if (review === "accept") {
    if (!hasApplicableModelLabels(suggestion)) {
      setFormError(
        "This model response has no applicable labels to use. You can correct it manually or reject it.",
      );
      return;
    }
    if (
      state.modelReview?.suggestionId === suggestion.id &&
      state.modelReview.review === "accept" &&
      state.autoModelDraft
    )
      return;
    const labels = mappedModelLabels(suggestion);
    setChecked("regions", labels.regions || []);
    setChecked("purposes", labels.purposes || []);
    setComponentType(labels.componentType || "");
    state.autoModelDraft = true;
    state.dirty = false;
  } else if (review === "reject" && state.autoModelDraft) {
    setChecked("regions", []);
    setChecked("purposes", []);
    setChecked("observedState", []);
    setComponentType();
    state.autoModelDraft = false;
  }
  state.modelReview = { suggestionId: suggestion.id, review };
  if (review === "correct") {
    state.autoModelDraft = false;
    state.dirty = true;
    $("advanced-editor").open = true;
  }
  setFormError();
  showStatus(
    review === "accept"
      ? `${modelName(suggestion)} suggestion preselected — save to confirm`
      : review === "correct"
        ? "Choose your correction, then save"
        : "Model suggestion set aside; save the rejection or choose a human label",
  );
  renderModelSuggestion(node);
}
/**
 * Accept the suggestion shown in display position `choice` (1 or 2).
 *
 * The saved annotation carries that suggestion's id, which is what makes
 * agreement-with-human computable per annotator, and is the real identity even
 * in blind mode where the displayed position was shuffled.
 */
function acceptComparisonSuggestion(choice) {
  if (state.saving) return;
  const node = selectedNode();
  const suggestions = comparisonSuggestions(node);
  const suggestion = suggestions?.[choice - 1];
  if (!suggestion) return;
  const annotation = annotationFor(node.id);
  if (suggestions.some((item) => savedReviewForTarget(item, annotation))) return;
  if (annotation && !state.modelReview) return;
  if (!hasApplicableModelLabels(suggestion)) {
    setFormError("This option has no applicable labels. Reject both or edit labels manually.");
    return;
  }
  const action = () => {
    const labels = mappedModelLabels(suggestion);
    setChecked("regions", labels.regions || []);
    setChecked("purposes", labels.purposes || []);
    setComponentType(labels.componentType || "");
    state.autoModelDraft = true;
    state.dirty = false;
    state.modelReview = { suggestionId: suggestion.id, review: "accept" };
    setFormError();
    saveAnnotation("label", { advance: true });
  };
  if (state.dirty && state.modelReview?.review === "correct") attemptTransition(action);
  else action();
}
/** Reject every competing suggestion: no human label is manufactured. */
async function rejectComparisonSuggestions() {
  if (state.saving) return;
  const node = selectedNode();
  const suggestions = comparisonSuggestions(node);
  if (!node || !suggestions) return;
  const annotation = annotationFor(node.id);
  if (suggestions.some((item) => savedReviewForTarget(item, annotation))) return;
  if (annotation && !state.modelReview) return;
  state.saving = true;
  showStatus("Saving rejections…");
  let saved = false;
  try {
    for (const suggestion of suggestions) {
      const response = await api("/api/model-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: state.page.id,
          nodeId: node.id,
          modelSuggestionId: suggestion.id,
          review: "reject",
          comment: $("comment").value.trim(),
          clientRequestId: crypto.randomUUID(),
          captureHash: state.page.captureHash,
        }),
      });
      if (response.modelReview) {
        state.modelReviews.push(response.modelReview);
        // Each rejection is separately undoable, newest first.
        rememberUndoableReview({
          kind: "model_review",
          id: response.modelReview.id,
          nodeId: node.id,
        });
      }
    }
    state.dirty = false;
    state.modelReview = null;
    state.autoModelDraft = false;
    showStatus("Both options rejected", "success");
    renderModelSuggestion(node);
    refreshStats();
    saved = true;
  } catch {
    setFormError("Couldn’t save these rejections. Check your connection and try again.");
    showStatus("Save failed", "error");
  } finally {
    state.saving = false;
    renderUndoAction();
    if (saved) advanceAfterSave();
  }
}
async function saveStandaloneModelRejection(pageLevel = false, { advance = false } = {}) {
  const suggestion = pageLevel ? pageModelSuggestionFor() : modelSuggestionFor(selectedNode()?.id);
  if (!suggestion || state.saving) return;
  let saved = false;
  const review = pageLevel ? state.pageModelReview : state.modelReview;
  if (review?.suggestionId !== suggestion.id || review.review !== "reject") return;
  state.saving = true;
  showStatus("Saving model rejection…");
  try {
    const payload = {
      pageId: state.page.id,
      nodeId: pageLevel ? null : selectedNode().id,
      modelSuggestionId: suggestion.id,
      review: "reject",
      comment: (pageLevel ? state.pageDraft.comment : $("comment").value).trim(),
      clientRequestId: crypto.randomUUID(),
      captureHash: state.page.captureHash,
    };
    const response = await api("/api/model-reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.modelReview) {
      state.modelReviews.push(response.modelReview);
      rememberUndoableReview({
        kind: "model_review",
        id: response.modelReview.id,
        nodeId: pageLevel ? null : selectedNode()?.id,
      });
    }
    if (pageLevel) {
      state.pageDirty = false;
      state.pageModelReview = null;
      state.autoPageModelDraft = false;
    } else {
      state.dirty = false;
      state.modelReview = null;
      state.autoModelDraft = false;
    }
    showStatus("Model rejection saved", "success");
    if (pageLevel) renderPageModelSuggestion();
    else renderModelSuggestion(selectedNode());
    refreshStats();
    saved = true;
  } catch {
    if (pageLevel)
      setPageFormError("Couldn’t save this model rejection. Check your connection and try again.");
    else setFormError("Couldn’t save this model rejection. Check your connection and try again.");
    showStatus("Save failed", "error");
  } finally {
    state.saving = false;
    renderUndoAction();
    if (saved && advance) advanceAfterSave();
  }
}
function renderPageModelSuggestion() {
  const section = $("page-model-suggestion-section"),
    suggestion = pageModelSuggestionFor();
  section.hidden = !suggestion;
  if (!suggestion) return;
  $("page-model-suggestion-model").textContent = [suggestion.modelId, suggestion.modelRevision]
    .filter(Boolean)
    .join(" · ");
  $("page-model-suggestion-copy").textContent = suggestion.rawClass || "Provisional model output";
  $("page-model-suggestion-context").textContent =
    `Captured page: ${state.page?.title || "Untitled page"}`;
  renderPageProposal(suggestion);
  renderModelLabelChips("page-model-suggestion-chips", suggestion);
  const review =
    state.pageModelReview?.suggestionId === suggestion.id ? state.pageModelReview.review : "";
  const annotation = pageAnnotationFor();
  const saved = savedReviewForTarget(suggestion, annotation);
  const applicable = hasApplicableModelLabels(suggestion, true);
  const existingHumanLabel = Boolean(annotation && !saved);
  $("page-model-ok").disabled = !applicable || Boolean(saved) || existingHumanLabel;
  $("page-model-not-ok").disabled = Boolean(saved) || existingHumanLabel;
  $("page-model-skip").disabled = Boolean(saved) || existingHumanLabel;
  $("page-model-ok").textContent = saved?.review === "accept" ? "OK saved" : "OK (Enter)";
  $("page-model-not-ok").textContent = saved?.review === "reject" ? "Not OK saved" : "Not OK (X)";
  $("page-model-suggestion-status").textContent = saved
    ? `Human review saved: ${saved.review === "accept" ? "OK" : saved.review === "reject" ? "Not OK" : "edited"}.`
    : existingHumanLabel
      ? "A human page label is already saved. Open the advanced editor to revise it."
      : "These are provisional model labels. OK saves these exact labels as a human acceptance; Not OK records a rejection without adding a replacement label.";
  $("use-page-model-suggestion").disabled = !applicable;
  $("use-page-model-suggestion").textContent = !applicable
    ? "No applicable labels"
    : review === "accept" && state.autoPageModelDraft
      ? `${modelName(suggestion)} suggestion preselected`
      : review === "correct"
        ? "Reset to suggestion"
        : "Use suggestion";
  $("use-page-model-suggestion").title = applicable
    ? ""
    : "This model response has no labels to add to a human page draft.";
  $("correct-page-model-suggestion").textContent =
    review === "correct" ? "Manual correction selected" : "Correct manually";
  $("reject-page-model-suggestion").textContent =
    review === "reject" ? "Marked Not OK" : "Mark Not OK";
  $("save-page-model-rejection").hidden = review !== "reject" || Boolean(saved);
}
function choosePageModelReview(review) {
  const suggestion = pageModelSuggestionFor();
  if (!suggestion) return;
  const labels = mappedModelLabels(suggestion);
  if (review === "accept") {
    if (!hasApplicableModelLabels(suggestion, true)) {
      setPageFormError(
        "This model response has no applicable page labels to use. You can correct it manually or reject it.",
      );
      return;
    }
    if (
      state.pageModelReview?.suggestionId === suggestion.id &&
      state.pageModelReview.review === "accept" &&
      state.autoPageModelDraft
    )
      return;
    // Reset both axes so this acceptance remains exactly the model's mapped labels.
    state.pageDraft.pageTypes = [...(labels.pageTypes || [])];
    state.pageDraft.contentKinds = [...(labels.contentKinds || [])];
    renderPageTypes($("page-type-search").value);
    renderPageCheckboxes(
      "content-kinds-grid",
      "contentKinds",
      state.contentKinds.length ? state.contentKinds : fallbackContentKinds,
    );
    state.autoPageModelDraft = true;
    state.pageDirty = false;
  } else if (review === "reject" && state.autoPageModelDraft) {
    state.pageDraft.pageTypes = [];
    state.pageDraft.contentKinds = [];
    renderPageTypes($("page-type-search").value);
    renderPageCheckboxes(
      "content-kinds-grid",
      "contentKinds",
      state.contentKinds.length ? state.contentKinds : fallbackContentKinds,
    );
    state.autoPageModelDraft = false;
  }
  state.pageModelReview = { suggestionId: suggestion.id, review };
  if (review === "correct") {
    state.autoPageModelDraft = false;
    state.pageDirty = true;
    $("page-advanced-editor").open = true;
  }
  setPageFormError();
  showStatus(
    review === "accept"
      ? `${modelName(suggestion)} suggestion preselected — save to confirm`
      : review === "correct"
        ? "Choose your page correction, then save"
        : "Model suggestion set aside; save the rejection or choose a human page label",
  );
  renderPageModelSuggestion();
}
function fastModelReview(review) {
  if (state.saving) return;
  const node = selectedNode();
  const suggestion = node && modelSuggestionFor(node.id);
  const existing = node && annotationFor(node.id);
  if (
    !node ||
    !suggestion ||
    savedReviewForTarget(suggestion, existing) ||
    (existing && !state.modelReview)
  )
    return;
  const action = () => {
    chooseModelReview(review === "ok" ? "accept" : "reject");
    if (review === "ok") saveAnnotation("label", { advance: true });
    else saveStandaloneModelRejection(false, { advance: true });
  };
  // A note does not change the model label, so keep it and complete the fast action.
  // Label edits still use the normal keep-or-discard protection.
  if (state.dirty && state.modelReview?.review === "correct") attemptTransition(action);
  else action();
}
function fastPageModelReview(review) {
  if (state.saving) return;
  const suggestion = pageModelSuggestionFor();
  const existing = pageAnnotationFor();
  if (
    !suggestion ||
    savedReviewForTarget(suggestion, existing) ||
    (existing && !state.pageModelReview)
  )
    return;
  const action = () => {
    choosePageModelReview(review === "ok" ? "accept" : "reject");
    if (review === "ok") savePageAnnotation({ advance: true });
    else saveStandaloneModelRejection(true, { advance: true });
  };
  if (state.pageDirty && state.pageModelReview?.review === "correct") {
    state.pagePendingAction = action;
    $("page-unsaved-notice").hidden = false;
    return;
  }
  action();
}
function skipModelReview(pageLevel = false) {
  if (state.saving) return;
  const suggestion = pageLevel ? pageModelSuggestionFor() : modelSuggestionFor(selectedNode()?.id);
  if (!suggestion || savedModelReviewFor(suggestion) || isSkippedModelSuggestion(suggestion))
    return;
  const action = () => {
    state.skippedModelSuggestionIds.add(suggestion.id);
    if (!pageLevel && chooseNextModelSuggestion({ quiet: true })) {
      showStatus("Skipped for this session");
      return;
    }
    advanceToNextModelPage(pageLevel);
  };
  if (pageLevel && state.pageDirty) {
    state.pagePendingAction = action;
    $("page-unsaved-notice").hidden = false;
    return;
  }
  if (!pageLevel && state.dirty) {
    attemptTransition(action);
    return;
  }
  action();
}
function advanceToNextModelPage(pageLevel = false) {
  const nextIndex = state.currentPageIndex + 1;
  if (nextIndex >= state.pages.length) {
    showStatus("No more model labels in this session", "success");
    return false;
  }
  state.advanceModelOnLoad = !pageLevel;
  state.advancePageModelOnLoad = pageLevel;
  loadPage(nextIndex);
  return true;
}
function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
function renderSuggestion(node) {
  const section = $("suggestion-section"),
    hint = $("selected-role-hint");
  const suggestion = node?.suggestion;
  section.hidden = !suggestion;
  hint.hidden = !suggestion;
  if (!suggestion) return;
  const annotation = annotationFor(node.id);
  const confidence = Math.round((Number(suggestion.confidence) || 0) * 100);
  const reason = suggestion.reason ? ` · ${suggestion.reason}` : "";
  const accepted = annotation?.decision === "accept",
    rejected = annotation?.decision === "reject";
  $("suggestion-heading").textContent = rejected
    ? "Rule hint set aside"
    : accepted
      ? "Rule hint accepted"
      : "Rule-based hint";
  $("suggestion-copy").textContent = rejected
    ? `${roleText(suggestion.role)} was set aside. Choose a role if you want to finish this review.`
    : `${roleText(suggestion.role)}${suggestion.context ? ` · ${suggestion.context}` : ""}${confidence ? ` · ${confidence}% confidence` : ""}${reason}`;
  $("accept-button").hidden = accepted || rejected;
  $("reject-button").hidden = accepted || rejected;
}
async function saveAnnotation(decision, { advance = false } = {}) {
  const node = selectedNode();
  if (!node || state.saving) return;
  let saved = false;
  const form = $("annotation-form");
  let regions = selectedValues("regions");
  let purposes = selectedValues("purposes");
  let componentType = $("component-type").value;
  let componentSubtype = $("component-subtype").value;
  let observedState = selectedValues("observedState");
  const beforeRuleLabels = JSON.stringify({
    regions,
    purposes,
    componentType,
    componentSubtype,
    observedState,
  });
  if (decision === "accept") {
    const hint = hintLabels(node.suggestion.role);
    regions = mergeHint(regions, hint.regions);
    purposes = mergeHint(purposes, hint.purposes || []);
    if (!componentType && hintComponentType(node.suggestion.role)) {
      componentType = hintComponentType(node.suggestion.role);
      setComponentType(componentType);
    }
    setChecked("regions", regions);
    setChecked("purposes", purposes);
  }
  if (decision === "reject") {
    const hint = hintLabels(node.suggestion.role);
    regions = regions.filter((value) => !hint.regions.includes(value));
    purposes = purposes.filter((value) => !(hint.purposes || []).includes(value));
    if (componentType === hintComponentType(node.suggestion.role)) {
      componentType = "";
      componentSubtype = "";
      observedState = [];
      setComponentType();
    }
    setChecked("regions", regions);
    setChecked("purposes", purposes);
  }
  if (
    state.modelReview?.review === "accept" &&
    beforeRuleLabels !==
      JSON.stringify({ regions, purposes, componentType, componentSubtype, observedState })
  ) {
    state.modelReview.review = "correct";
    state.autoModelDraft = false;
  }
  if (decision === "label" && !regions.length && !purposes.length && !componentType) {
    setFormError("Choose a page region, a purpose, or a component type before saving.");
    return;
  }
  const previous = annotationFor(node.id);
  const payload = {
    pageId: state.page.id,
    nodeId: node.id,
    decision,
    comment: $("comment").value.trim(),
    boundary: form.elements.boundary.value || "correct",
    clientRequestId: crypto.randomUUID(),
    captureHash: state.page.captureHash,
    ...(previous ? { supersedes: previous.id } : {}),
  };
  if (decision === "label" || decision === "accept" || decision === "reject") {
    payload.regions = regions;
    payload.purposes = purposes;
  }
  if (componentType) payload.componentType = componentType;
  if (componentSubtype) payload.componentSubtype = componentSubtype;
  if (observedState.length) payload.observedState = observedState;
  if (state.modelReview) {
    payload.modelSuggestionId = state.modelReview.suggestionId;
    payload.modelReview = state.modelReview.review;
  }
  if (decision === "accept" && node.suggestion.context) payload.context = node.suggestion.context;
  else if (
    (decision === "label" || decision === "accept" || decision === "reject") &&
    $("context-select").value
  )
    payload.context = $("context-select").value;
  state.saving = true;
  $("save-button").disabled = true;
  showStatus("Saving annotation…");
  try {
    const response = await api("/api/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const next = response.annotation;
    if (next && state.modelReview) {
      rememberUndoableReview({
        kind: "annotation",
        id: next.id,
        nodeId: node.id,
        summaryDelta: previous ? 0 : 1,
      });
    }
    state.annotations = state.annotations.filter((annotation) => annotation.nodeId !== node.id);
    if (next) state.annotations.push(next);
    const summary = state.pages[state.currentPageIndex];
    if (summary && !previous) summary.reviewedCount = (summary.reviewedCount || 0) + 1;
    state.dirty = false;
    state.autoModelDraft = false;
    showUnsavedNotice(false);
    showStatus(decision === "reject" ? "Suggestion set aside" : "Label saved", "success");
    renderQueue();
    renderSelection();
    syncNodeStates();
    refreshStats();
    saved = true;
  } catch (error) {
    setFormError("Couldn’t save this label. Check your connection and try again.");
    showStatus("Save failed", "error");
  } finally {
    state.saving = false;
    renderUndoAction();
    $("save-button").disabled = !selectedNode();
    if (saved && advance) advanceAfterSave();
  }
}
function setLabelMode(mode) {
  if (mode === state.labelMode) return;
  if (state.saving) {
    showStatus("Finishing the current save…");
    return;
  }
  if (state.labelMode === "element" && state.dirty) {
    showUnsavedNotice(true);
    state.pendingAction = () => setLabelMode(mode);
    return;
  }
  if (state.labelMode === "page" && state.pageDirty) {
    state.pagePendingAction = () => setLabelMode(mode);
    $("page-unsaved-notice").hidden = false;
    return;
  }
  state.labelMode = mode;
  $("element-pane").hidden = mode !== "element";
  $("page-pane").hidden = mode !== "page";
  $("element-tab").classList.toggle("active", mode === "element");
  $("page-tab").classList.toggle("active", mode === "page");
  $("element-tab").setAttribute("aria-selected", String(mode === "element"));
  $("page-tab").setAttribute("aria-selected", String(mode === "page"));
  if (mode === "page") renderPageLabel();
}
async function savePageAnnotation({ advance = false } = {}) {
  if (!state.page || state.saving) return;
  let saved = false;
  const pageTypes = state.pageDraft.pageTypes,
    contentKinds = state.pageDraft.contentKinds;
  if (!pageTypes.length && !contentKinds.length) {
    setPageFormError("Choose a page type or content kind before saving.");
    return;
  }
  const previous = pageAnnotationFor();
  const payload = {
    pageId: state.page.id,
    decision: "label",
    pageTypes,
    contentKinds,
    comment: state.pageDraft.comment.trim(),
    clientRequestId: crypto.randomUUID(),
    captureHash: state.page.captureHash,
    ...(previous ? { supersedes: previous.id } : {}),
  };
  if (state.pageModelReview) {
    payload.modelSuggestionId = state.pageModelReview.suggestionId;
    payload.modelReview = state.pageModelReview.review;
  }
  state.saving = true;
  $("page-save-button").disabled = true;
  showStatus("Saving page label…");
  try {
    const response = await api("/api/page-annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.pageAnnotations = [response.annotation];
    if (response.annotation && state.pageModelReview) {
      rememberUndoableReview({
        kind: "page_annotation",
        id: response.annotation.id,
        nodeId: null,
        summaryDelta: previous ? 0 : 1,
      });
    }
    state.pageDirty = false;
    state.autoPageModelDraft = false;
    const summary = state.pages[state.currentPageIndex];
    if (summary && !previous) summary.pageReviewedCount = (summary.pageReviewedCount || 0) + 1;
    showStatus("Page label saved", "success");
    renderPageLabel();
    renderQueue();
    refreshStats();
    saved = true;
  } catch {
    setPageFormError("Couldn’t save this page label. Check your connection and try again.");
    showStatus("Save failed", "error");
  } finally {
    state.saving = false;
    renderUndoAction();
    $("page-save-button").disabled = false;
    if (saved && advance) advanceAfterSave();
  }
}
async function loadPage(index) {
  if (index < 0 || index >= state.pages.length) return;
  if (state.saving) {
    showStatus("Finishing the current save…");
    return false;
  }
  if (state.pageDirty) {
    state.pagePendingAction = () => loadPageNow(index);
    $("page-unsaved-notice").hidden = false;
    return false;
  }
  return attemptTransition(() => loadPageNow(index));
}
async function loadPageNow(index) {
  const generation = ++state.loadGeneration;
  state.currentPageIndex = index;
  applyClearSelection();
  state.page = null;
  state.nodes = [];
  state.annotations = [];
  state.pageAnnotations = [];
  state.modelSuggestions = [];
  state.modelReviews = [];
  state.pageDirty = false;
  state.pageModelReview = null;
  state.autoPageModelDraft = false;
  renderQueue();
  $("empty-canvas").hidden = false;
  $("page-image").removeAttribute("src");
  const summary = state.pages[index];
  showStatus("Loading captured page…");
  try {
    const result = await api(`/api/pages/${encodeURIComponent(summary.id)}`);
    if (generation !== state.loadGeneration) return;
    state.page = result;
    state.nodes = result.nodes || [];
    state.annotations = result.annotations || [];
    state.pageAnnotations = result.pageAnnotations || [];
    state.modelSuggestions = result.modelSuggestions || [];
    state.modelReviews = result.modelReviews || [];
    if (state.labelMode === "page") renderPageLabel();
    const selectPageModelOnLoad = state.advancePageModelOnLoad;
    state.advancePageModelOnLoad = false;
    if (selectPageModelOnLoad) {
      const suggestion = pageModelSuggestionFor();
      const annotation = pageAnnotationFor();
      if (
        !suggestion ||
        savedReviewForTarget(suggestion, annotation) ||
        (annotation && !state.pageModelReview) ||
        isSkippedModelSuggestion(suggestion)
      ) {
        advanceToNextModelPage(true);
        return;
      }
    }
    const selectModelOnLoad = state.advanceModelOnLoad;
    state.advanceModelOnLoad = false;
    if (selectModelOnLoad && !chooseNextModelSuggestion({ quiet: true })) {
      advanceToNextModelPage(false);
      return;
    }
    $("page-title").textContent = result.title || summary.title || "Captured page";
    $("page-url").textContent = result.url || "Private capture";
    const source = safeImageUrl(result.screenshotUrl);
    if (!source) throw new Error("Screenshot must be served from this review workspace.");
    $("page-image").onload = () => {
      if (generation !== state.loadGeneration) return;
      $("empty-canvas").hidden = true;
      renderStage();
      showStatus("Ready to review", "success");
    };
    $("page-image").onerror = () => {
      if (generation === state.loadGeneration)
        $("empty-canvas").textContent = "This screenshot could not be loaded.";
    };
    $("page-image").alt = `Captured page: ${result.title || "webpage"}`;
    $("page-image").src = source;
  } catch (error) {
    if (generation === state.loadGeneration) {
      $("empty-canvas").textContent = "Couldn’t load this page. Choose another page or refresh.";
      showStatus("Page unavailable", "error");
    }
  }
}
function chooseParent() {
  const node = selectedNode();
  if (node?.parentId && nodeById(node.parentId)) selectNode(node.parentId);
}
function chooseChild() {
  const node = selectedNode();
  const child = state.nodes.find((candidate) => candidate.parentId === node?.id);
  if (child) selectNode(child.id);
}
function chooseNextSuggestion() {
  const suggested = state.nodes.filter((node) => node.suggestion && !annotationFor(node.id));
  if (!suggested.length) {
    showStatus("No unreviewed hints on this page");
    return;
  }
  const index = suggested.findIndex((node) => node.id === state.selectedId);
  const target = suggested[(index + 1) % suggested.length];
  selectNode(target.id);
  requestAnimationFrame(() => {
    const region = $("node-layer").querySelector(`[data-node-id="${CSS.escape(target.id)}"]`);
    region?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
function chooseNextModelSuggestion({ quiet = false } = {}) {
  if (state.pageDirty) {
    state.pagePendingAction = () => chooseNextModelSuggestion({ quiet });
    $("page-unsaved-notice").hidden = false;
    return false;
  }
  if (state.labelMode === "page") setLabelMode("element");
  if (state.labelMode !== "element") return false;
  const suggested = latestModelSuggestionsForCurrentPage().filter(
    (suggestion) =>
      suggestion.nodeId &&
      isVisibleCaptureNode(nodeById(suggestion.nodeId)) &&
      !annotationFor(suggestion.nodeId) &&
      !savedModelReviewFor(suggestion) &&
      !isSkippedModelSuggestion(suggestion),
  );
  if (!suggested.length) {
    if (!quiet) showStatus("No unreviewed model suggestions on this page");
    return false;
  }
  const index = suggested.findIndex((suggestion) => suggestion.nodeId === state.selectedId);
  const target = suggested[(index + 1) % suggested.length];
  return selectNode(target.nodeId);
}
function choosePreviousModelSuggestion() {
  if (state.labelMode === "page") {
    loadPage(state.currentPageIndex - 1);
    return false;
  }
  if (state.pageDirty) {
    state.pagePendingAction = choosePreviousModelSuggestion;
    $("page-unsaved-notice").hidden = false;
    return false;
  }
  const targets = latestModelSuggestionsForCurrentPage().filter((suggestion) =>
    isVisibleCaptureNode(nodeById(suggestion.nodeId)),
  );
  if (!targets.length) {
    showStatus("No model suggestions on this page");
    return false;
  }
  const index = targets.findIndex((suggestion) => suggestion.nodeId === state.selectedId);
  const target = targets[(index <= 0 ? targets.length : index) - 1];
  return selectNode(target.nodeId);
}
function advanceAfterSave() {
  if (state.saving) return;
  if (state.labelMode === "element" && chooseNextModelSuggestion({ quiet: true })) return;
  advanceToNextModelPage(state.labelMode === "page");
}
function isEditingTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable
  );
}
function installSwipeReview(card, pageLevel) {
  const hint = card.querySelector(".swipe-review-hint");
  const defaultHint = hint?.textContent || "";
  const swipe = { pointerId: null, startX: 0, startY: 0, suggestionId: null, pageId: null };
  const reset = () => {
    swipe.pointerId = null;
    swipe.suggestionId = null;
    swipe.pageId = null;
    card.dataset.swipeActive = "false";
    card.style.transform = "";
    if (hint) hint.textContent = defaultHint;
  };
  card.addEventListener("pointerdown", (event) => {
    if (
      swipe.pointerId !== null ||
      state.saving ||
      card.hidden ||
      state.labelMode !== (pageLevel ? "page" : "element") ||
      !event.isPrimary ||
      event.button !== 0 ||
      event.target.closest(
        "button, input, textarea, select, summary, label, a, details, [contenteditable='true']",
      )
    )
      return;
    const suggestion = pageLevel
      ? pageModelSuggestionFor()
      : modelSuggestionFor(selectedNode()?.id);
    if (!suggestion) return;
    swipe.pointerId = event.pointerId;
    swipe.startX = event.clientX;
    swipe.startY = event.clientY;
    swipe.suggestionId = suggestion.id;
    swipe.pageId = state.page?.id || null;
    card.dataset.swipeActive = "true";
    card.setPointerCapture(event.pointerId);
  });
  card.addEventListener("pointermove", (event) => {
    if (event.pointerId !== swipe.pointerId) return;
    const deltaX = event.clientX - swipe.startX;
    const deltaY = event.clientY - swipe.startY;
    if (Math.abs(deltaX) <= Math.abs(deltaY)) {
      card.style.transform = "";
      if (hint) hint.textContent = defaultHint;
      return;
    }
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      card.style.transform = `translateX(${Math.max(-24, Math.min(24, deltaX * 0.16))}px)`;
    if (!hint) return;
    hint.textContent =
      Math.abs(deltaX) >= 96
        ? deltaX > 0
          ? "Release to approve"
          : "Release to mark Not OK"
        : defaultHint;
  });
  card.addEventListener("pointercancel", reset);
  card.addEventListener("lostpointercapture", reset);
  card.addEventListener("pointerup", (event) => {
    if (event.pointerId !== swipe.pointerId) return;
    const deltaX = event.clientX - swipe.startX;
    const deltaY = event.clientY - swipe.startY;
    const suggestion = pageLevel
      ? pageModelSuggestionFor()
      : modelSuggestionFor(selectedNode()?.id);
    const matchesStart = suggestion?.id === swipe.suggestionId && state.page?.id === swipe.pageId;
    reset();
    if (
      !matchesStart ||
      card.hidden ||
      state.labelMode !== (pageLevel ? "page" : "element") ||
      Math.abs(deltaX) < 96 ||
      Math.abs(deltaX) < Math.abs(deltaY) * 1.5 ||
      state.saving
    )
      return;
    if (deltaX > 0) {
      if (pageLevel) fastPageModelReview("ok");
      else fastModelReview("ok");
    } else if (pageLevel) fastPageModelReview("not-ok");
    else fastModelReview("not-ok");
  });
}
function installListeners() {
  installSwipeReview($("model-suggestion-section"), false);
  installSwipeReview($("page-model-suggestion-section"), true);
  $("screenshot-stage").addEventListener("pointermove", updateHover);
  $("screenshot-stage").addEventListener("pointerleave", () => {
    state.hoverId = null;
    syncNodeStates();
  });
  $("screenshot-stage").addEventListener("click", (event) => {
    const node = findPointNode(event);
    if (node) selectNode(node.id);
  });
  $("parent-button").addEventListener("click", chooseParent);
  $("child-button").addEventListener("click", chooseChild);
  $("previous-page").addEventListener("click", () => loadPage(state.currentPageIndex - 1));
  $("next-page").addEventListener("click", () => loadPage(state.currentPageIndex + 1));
  $("next-suggestion").addEventListener("click", chooseNextSuggestion);
  $("next-model-suggestion").addEventListener("click", chooseNextModelSuggestion);
  $("zoom-select").addEventListener("change", (event) => {
    state.zoom = event.target.value;
    if (state.page) renderStage();
  });
  const setPickerMode = (mode) => {
    state.pickerMode = mode;
    $("sections-mode").classList.toggle("active", mode === "sections");
    $("elements-mode").classList.toggle("active", mode === "elements");
    $("sections-mode").setAttribute("aria-pressed", String(mode === "sections"));
    $("elements-mode").setAttribute("aria-pressed", String(mode === "elements"));
    showStatus(mode === "elements" ? "Element picker active" : "Section picker active");
  };
  $("sections-mode").addEventListener("click", () => setPickerMode("sections"));
  $("elements-mode").addEventListener("click", () => setPickerMode("elements"));
  $("component-trigger").addEventListener("click", () => {
    const open = $("component-picker").hidden;
    $("component-picker").hidden = !open;
    $("component-trigger").setAttribute("aria-expanded", String(open));
    if (open) $("component-search").focus();
  });
  $("component-search").addEventListener("input", () =>
    renderComponentOptions($("component-search").value),
  );
  $("component-subtype").addEventListener("change", () => {
    markModelLabelsEdited();
  });
  $("accept-button").addEventListener("click", () => saveAnnotation("accept"));
  $("reject-button").addEventListener("click", () => saveAnnotation("reject"));
  $("use-model-suggestion").addEventListener("click", () => chooseModelReview("accept"));
  $("correct-model-suggestion").addEventListener("click", () => chooseModelReview("correct"));
  $("reject-model-suggestion").addEventListener("click", () => chooseModelReview("reject"));
  $("save-model-rejection").addEventListener("click", () => saveStandaloneModelRejection());
  $("model-ok").addEventListener("click", () => fastModelReview("ok"));
  $("model-not-ok").addEventListener("click", () => fastModelReview("not-ok"));
  $("model-skip").addEventListener("click", () => skipModelReview());
  $("comparison-reject-both").addEventListener("click", () => rejectComparisonSuggestions());
  $("use-page-model-suggestion").addEventListener("click", () => choosePageModelReview("accept"));
  $("correct-page-model-suggestion").addEventListener("click", () =>
    choosePageModelReview("correct"),
  );
  $("reject-page-model-suggestion").addEventListener("click", () =>
    choosePageModelReview("reject"),
  );
  $("save-page-model-rejection").addEventListener("click", () =>
    saveStandaloneModelRejection(true),
  );
  $("page-model-ok").addEventListener("click", () => fastPageModelReview("ok"));
  $("page-model-not-ok").addEventListener("click", () => fastPageModelReview("not-ok"));
  $("page-model-skip").addEventListener("click", () => skipModelReview(true));
  $("element-tab").addEventListener("click", () => setLabelMode("element"));
  $("page-tab").addEventListener("click", () => setLabelMode("page"));
  $("page-type-search").addEventListener("input", () =>
    renderPageTypes($("page-type-search").value),
  );
  $("queue-search").addEventListener("input", () => {
    state.queueQuery = $("queue-search").value.trim().toLowerCase();
    renderQueue();
  });
  $("page-comment").addEventListener("input", () => {
    state.pageDraft.comment = $("page-comment").value;
    state.pageDirty = true;
    setPageFormError();
  });
  $("page-annotation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    savePageAnnotation();
  });
  const markManualAnnotationChange = (event) => {
    if (!selectedNode()) return;
    state.dirty = true;
    const target = event.target;
    if (
      target?.matches?.(
        'input[name="regions"], input[name="purposes"], input[name="observedState"], #component-subtype',
      )
    )
      markModelLabelsEdited();
  };
  $("annotation-form").addEventListener("input", markManualAnnotationChange);
  $("annotation-form").addEventListener("change", markManualAnnotationChange);
  $("annotation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveAnnotation("label");
  });
  $("keep-draft").addEventListener("click", () => {
    state.pendingAction = null;
    showUnsavedNotice(false);
  });
  $("discard-draft").addEventListener("click", () => {
    const action = state.pendingAction;
    state.pendingAction = null;
    state.dirty = false;
    showUnsavedNotice(false);
    $("annotation-form").reset();
    if (action) action();
  });
  $("page-keep-draft").addEventListener("click", () => {
    state.pagePendingAction = null;
    $("page-unsaved-notice").hidden = true;
  });
  $("page-discard-draft").addEventListener("click", () => {
    const action = state.pagePendingAction;
    renderPageLabel();
    if (action) action();
  });
  $("undo-last-review").addEventListener("click", undoLastReview);
  $("shortcut-toggle").addEventListener("click", () => $("shortcuts-dialog").showModal());
  $("shortcut-close").addEventListener("click", () => $("shortcuts-dialog").close());
  const saveCurrent = (advance = false) =>
    state.labelMode === "page"
      ? savePageAnnotation({ advance })
      : saveAnnotation("label", { advance });
  window.addEventListener("keydown", (event) => {
    if (event.repeat || event.isComposing || event.defaultPrevented) return;
    const dialogOpen = Boolean(document.querySelector("dialog[open]"));
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      if (dialogOpen || isEditingTarget(event.target)) return;
      event.preventDefault();
      undoLastReview();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "Enter") {
      if (dialogOpen) return;
      event.preventDefault();
      saveCurrent(true);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      if (dialogOpen) return;
      event.preventDefault();
      saveCurrent(false);
      return;
    }
    if (
      isEditingTarget(event.target) ||
      dialogOpen ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      clearSelection();
      $("shortcuts-dialog").close();
    } else if (event.key === "Enter") {
      if (event.target?.closest?.("button, a, [role='button']")) return;
      event.preventDefault();
      if (
        state.labelMode === "page" &&
        pageModelSuggestionFor() &&
        state.pageModelReview?.review !== "correct"
      )
        fastPageModelReview("ok");
      // On a disagreement Enter must not pick a side: 1, 2 or X decide it.
      else if (state.labelMode === "element" && comparisonSuggestions(selectedNode()))
        saveCurrent(true);
      else if (state.labelMode === "element" && modelSuggestionFor(selectedNode()?.id))
        if (state.modelReview?.review === "correct") saveCurrent(true);
        else fastModelReview("ok");
      else saveCurrent(true);
    } else if (
      state.labelMode === "element" &&
      (event.key === "1" || event.key === "2") &&
      comparisonSuggestions(selectedNode())
    ) {
      event.preventDefault();
      acceptComparisonSuggestion(Number(event.key));
    } else if (event.key.toLowerCase() === "x") {
      event.preventDefault();
      if (state.labelMode === "page") fastPageModelReview("not-ok");
      // X rejects both options when two annotators disagree.
      else if (comparisonSuggestions(selectedNode())) rejectComparisonSuggestions();
      else fastModelReview("not-ok");
    } else if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      chooseParent();
    } else if (event.key.toLowerCase() === "c") {
      event.preventDefault();
      chooseChild();
    } else if (event.key.toLowerCase() === "j") {
      event.preventDefault();
      if (state.labelMode === "page") skipModelReview(true);
      else skipModelReview();
    } else if (event.key.toLowerCase() === "k") {
      event.preventDefault();
      choosePreviousModelSuggestion();
    } else if (event.key === "[") {
      event.preventDefault();
      loadPage(state.currentPageIndex - 1);
    } else if (event.key === "]") {
      event.preventDefault();
      loadPage(state.currentPageIndex + 1);
    } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
      event.preventDefault();
      $("shortcuts-dialog").showModal();
    }
  });
}
async function bootstrap() {
  installListeners();
  renderUndoAction();
  try {
    const data = await api("/api/pages");
    state.pages = data.pages || [];
    state.roles = data.roles || [];
    state.regions = data.regions || [];
    state.functions = data.functions || [];
    state.purposes = data.purposes || [];
    state.contexts = data.contexts || [];
    state.pageTypes = data.pageTypes || [];
    state.pageTypeGroups = data.pageTypeGroups || [];
    state.contentKinds = data.contentKinds || [];
    state.componentSubtypes = data.componentSubtypes || {};
    state.statefulComponentTypes = data.statefulComponentTypes || {};
    renderLabelOptions();
    renderComponentOptions();
    renderPageTypes();
    renderPageCheckboxes(
      "content-kinds-grid",
      "contentKinds",
      state.contentKinds.length ? state.contentKinds : fallbackContentKinds,
    );
    renderQueue();
    refreshStats();
    if (state.pages.length) loadPage(0);
    else {
      $("empty-canvas").textContent = "No captured pages are ready for review.";
      showStatus("No pages in queue");
    }
  } catch {
    $("empty-canvas").textContent = "Couldn’t reach the review queue. Refresh to try again.";
    showStatus("Queue unavailable", "error");
  }
}
bootstrap();
