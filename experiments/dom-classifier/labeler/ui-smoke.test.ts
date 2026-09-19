import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLabelerServer } from "./server.ts";
import { LabelStore } from "./store.ts";
import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.ts";
import { COMPONENT_SUBTYPES, PURPOSES, REGIONS, STATEFUL_COMPONENT_TYPES } from "./types.ts";
import type { Browser } from "playwright";

const labelerDir = import.meta.dir;
const pageId = "page_aaaaaaaaaaaaaaaaaaaaaaaa";
const secondPageId = "page_999999999999999999999999";
const longFooterId = "node_444444444444444444444444";
const longTargetId = "node_555555555555555555555555";
const headerId = "node_bbbbbbbbbbbbbbbbbbbbbbbb";
const navId = "node_cccccccccccccccccccccccc";
const footerId = "node_dddddddddddddddddddddddd";
const sidebarId = "node_eeeeeeeeeeeeeeeeeeeeeeee";
const cardId = "node_ffffffffffffffffffffffff";
const formId = "node_111111111111111111111111";
const buttonId = "node_222222222222222222222222";
const spanId = "node_333333333333333333333333";
const token = "a".repeat(32);
const hash = `sha256:${"b".repeat(64)}`;
const posts: Array<Record<string, unknown>> = [];
const annotations: Array<Record<string, unknown>> = [];
const pageAnnotations: Array<Record<string, unknown>> = [];
const pagePosts: Array<Record<string, unknown>> = [];
const modelReviews: Array<Record<string, unknown>> = [];
const modelReviewPosts: Array<Record<string, unknown>> = [];
let server: ReturnType<typeof Bun.serve>;
// Assigned in beforeAll; typing it is what gives every `page` below a real
// Page, and with it typed evaluate/waitForFunction/waitForResponse callbacks.
let browser!: Browser;

const image = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#fafafa"/><rect width="1200" height="116" fill="#183b4d"/><text x="48" y="68" fill="white" font-size="36">Sample site</text><rect x="60" y="190" width="1080" height="480" fill="#edf4f0"/><text x="90" y="280" fill="#21303a" font-size="44">A captured article</text></svg>`;
const longImage = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="4800"><rect width="1200" height="4800" fill="#fafafa"/><rect width="1200" height="120" fill="#183b4d"/><text x="48" y="72" fill="white" font-size="38">Long captured page</text><rect x="80" y="280" width="1040" height="4100" fill="#edf4f0"/><rect y="4500" width="1200" height="300" fill="#183b4d"/><text x="48" y="4650" fill="white" font-size="38">Footer links</text></svg>`;
const pageFixture = () => ({
  id: pageId,
  title: "Sample site",
  url: "https://example.test/article",
  capturedAt: "2026-09-18T00:00:00.000Z",
  width: 1200,
  height: 800,
  screenshotUrl: "/captures/sample.svg",
  contentHash: hash,
  captureHash: hash,
  nodes: [
    {
      id: headerId,
      parentId: null,
      tag: "header",
      role: "banner",
      text: "Sample site Home About",
      selector: "html > body > header",
      rect: { x: 0, y: 0, width: 1200, height: 116 },
      depth: 2,
      suggestion: { role: "site_header", provenance: "weak", reason: "semantic <header>" },
    },
    {
      id: navId,
      parentId: headerId,
      tag: "nav",
      role: "navigation",
      text: "Home About",
      selector: "html > body > header > nav",
      rect: { x: 740, y: 24, width: 360, height: 64 },
      depth: 3,
      suggestion: { role: "navigation", provenance: "weak", reason: "ARIA role navigation" },
    },
    {
      id: sidebarId,
      parentId: null,
      tag: "aside",
      role: "complementary",
      text: "Related links",
      selector: "html > body > aside",
      rect: { x: 60, y: 190, width: 250, height: 420 },
      depth: 2,
      suggestion: { role: "aside", provenance: "weak", reason: "semantic <aside>" },
    },
    {
      id: footerId,
      parentId: null,
      tag: "footer",
      role: "contentinfo",
      text: "Footer links",
      selector: "html > body > footer",
      rect: { x: 0, y: 690, width: 1200, height: 110 },
      depth: 2,
      suggestion: { role: "footer", provenance: "weak", reason: "semantic <footer>" },
    },
    {
      id: cardId,
      parentId: null,
      tag: "div",
      role: null,
      text: "Newsletter Sign up",
      selector: "html > body > div.card",
      rect: { x: 360, y: 180, width: 500, height: 420 },
      depth: 2,
      suggestion: null,
    },
    {
      id: formId,
      parentId: cardId,
      tag: "form",
      role: "form",
      text: "Newsletter Sign up",
      selector: "html > body > div.card > form",
      rect: { x: 400, y: 250, width: 410, height: 230 },
      depth: 3,
      suggestion: { role: "form", provenance: "weak", reason: "semantic <form>" },
    },
    {
      id: buttonId,
      parentId: formId,
      tag: "button",
      role: null,
      text: "Sign up",
      selector: "html > body > div.card > form > button",
      rect: { x: 450, y: 350, width: 180, height: 50 },
      depth: 4,
      suggestion: null,
    },
    {
      id: spanId,
      parentId: buttonId,
      tag: "span",
      role: null,
      text: "Sign up",
      selector: "html > body > div.card > form > button > span",
      rect: { x: 470, y: 365, width: 110, height: 20 },
      depth: 5,
      suggestion: null,
    },
  ],
  annotations,
  pageAnnotations,
  modelReviews,
  modelSuggestions: [
    {
      id: "model_aaaaaaaaaaaaaaaaaaaaaaaa",
      pageId,
      nodeId: headerId,
      captureHash: hash,
      modelId: "jev",
      modelRevision: "2026-09",
      promptRevision: "dom-v1",
      snapshotHash: "sha256:model",
      rawAnswers: {},
      rawClass: "header/navigation",
      mappedLabels: {
        regions: ["site_header"],
        purposes: ["navigation"],
        componentType: "navigation_menu",
      },
      axisProbabilities: {
        regions: [{ label: "site_header", yesProbability: 0.91 }],
        purposes: [{ label: "navigation", yesProbability: 0.84 }],
      },
      componentTypeChoice: {
        choice: "navigation_menu",
        distribution: [
          { label: "navigation_menu", probability: 0.72 },
          { label: "content_section", probability: 0.18 },
        ],
        confidence: 0.64,
      },
      createdAt: "2026-09-18T00:00:00.000Z",
    },
    {
      id: "model_cccccccccccccccccccccccc",
      pageId,
      nodeId: navId,
      captureHash: hash,
      modelId: "jev",
      modelRevision: "2026-09",
      promptRevision: "dom-v1",
      snapshotHash: "sha256:model-nav",
      rawAnswers: {},
      rawClass: "footer/navigation",
      mappedLabels: { regions: ["footer"], purposes: ["navigation"] },
      axisProbabilities: { regions: [{ label: "footer", yesProbability: 0.72 }] },
      createdAt: "2026-09-18T00:00:00.000Z",
    },
    {
      id: "model_dddddddddddddddddddddddd",
      pageId,
      nodeId: sidebarId,
      captureHash: hash,
      modelId: "jev",
      modelRevision: "2026-09",
      promptRevision: "dom-v1",
      snapshotHash: "sha256:model-aside",
      rawAnswers: {},
      rawClass: "sidebar/navigation",
      mappedLabels: { regions: ["sidebar"], purposes: ["navigation"] },
      axisProbabilities: { regions: [{ label: "sidebar", yesProbability: 0.65 }] },
      createdAt: "2026-09-18T00:00:00.000Z",
    },
    {
      id: "model_eeeeeeeeeeeeeeeeeeeeeeee",
      pageId,
      nodeId: cardId,
      captureHash: hash,
      modelId: "jev",
      modelRevision: "2026-09",
      promptRevision: "dom-v1",
      snapshotHash: "sha256:model-card",
      rawAnswers: {},
      rawClass: "uncertain container",
      mappedLabels: {},
      axisProbabilities: { purposes: [{ label: "submit", yesProbability: 0.22 }] },
      createdAt: "2026-09-18T00:00:00.000Z",
    },
    {
      id: "model_bbbbbbbbbbbbbbbbbbbbbbbb",
      pageId,
      nodeId: null,
      captureHash: hash,
      modelId: "jev",
      modelRevision: "2026-09",
      promptRevision: "page-v1",
      snapshotHash: "sha256:page-model",
      rawAnswers: {},
      rawClass: "marketing/editorial",
      mappedLabels: { pageTypes: ["homepage", "blog_index"], contentKinds: ["article"] },
      axisProbabilities: {
        pageTypes: [
          { label: "homepage", yesProbability: 0.78 },
          { label: "blog_index", yesProbability: 0.54 },
        ],
        contentKinds: [{ label: "article", yesProbability: 0.66 }],
      },
      createdAt: "2026-09-18T00:00:00.000Z",
    },
  ],
});

const secondPageFixture = () => {
  const first = pageFixture();
  return {
    ...first,
    id: secondPageId,
    title: "Long sample",
    url: "https://example.test/long",
    height: 4800,
    screenshotUrl: "/captures/long.svg",
    nodes: [
      {
        id: "node_long_header_aaaaaaaaaa",
        parentId: null,
        tag: "header",
        role: "banner",
        text: "Long captured page",
        selector: "html > body > header",
        rect: { x: 0, y: 0, width: 1200, height: 120 },
        depth: 2,
        suggestion: null,
      },
      {
        id: longFooterId,
        parentId: null,
        tag: "footer",
        role: "contentinfo",
        text: "Footer links",
        selector: "html > body > footer",
        rect: { x: 0, y: 4500, width: 1200, height: 300 },
        depth: 2,
        suggestion: null,
      },
      {
        id: longTargetId,
        parentId: longFooterId,
        tag: "a",
        role: "link",
        text: "Footer link",
        selector: "html > body > footer > a",
        rect: { x: 820, y: 4560, width: 140, height: 8.66 },
        depth: 3,
        suggestion: null,
      },
    ],
    annotations: [],
    pageAnnotations: [],
    modelReviews: [],
    modelSuggestions: [
      {
        id: "model_long_target_aaaaaaaa",
        pageId: secondPageId,
        nodeId: longTargetId,
        captureHash: hash,
        modelId: "jev",
        modelRevision: "2026-09",
        promptRevision: "dom-v1",
        snapshotHash: "sha256:model-long-target",
        rawAnswers: {},
        provisional: true,
        mappedLabels: { regions: ["footer"], componentType: "link" },
        createdAt: "2026-09-18T00:00:00.000Z",
      },
    ],
  };
};

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

async function waitForPostCount(count: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (posts.length === count) return;
    await Bun.sleep(50);
  }
  throw new Error(`Expected ${count} annotation requests, received ${posts.length}`);
}
async function waitForSave(page: any) {
  await page.waitForFunction(() =>
    /Label saved|Suggestion set aside/.test(
      document.getElementById("save-status")?.textContent || "",
    ),
  );
  await page.waitForFunction(
    () => !document.getElementById("save-button")?.hasAttribute("disabled"),
  );
}
function statsFixture() {
  const latest = new Map<string, Record<string, unknown>>();
  for (const annotation of annotations) latest.set(String(annotation.nodeId), annotation);
  const reviewCounts = { accepted: 0, corrected: 0, rejected: modelReviewPosts.length };
  for (const annotation of latest.values()) {
    const review = annotation.modelReview;
    if (review === "accept") reviewCounts.accepted += 1;
    if (review === "correct") reviewCounts.corrected += 1;
    if (review === "reject") reviewCounts.rejected += 1;
  }
  const reviewed = reviewCounts.accepted + reviewCounts.corrected + reviewCounts.rejected;
  return {
    generatedAt: "2026-09-18T00:00:00.000Z",
    pages: {
      total: 2,
      labelled: pageAnnotations.length ? 1 : 0,
      currentPageLabels: pageAnnotations.length ? 1 : 0,
    },
    elements: {
      total: 10,
      currentHumanLabels: [...latest.values()].filter(
        (annotation) => annotation.decision === "label" || annotation.decision === "accept",
      ).length,
      latestManualLabels: latest.size,
    },
    suggestions: {
      total: 5,
      page: 1,
      element: 4,
      pending: Math.max(0, 5 - reviewed),
      reviewed: reviewCounts,
    },
  };
}

beforeAll(async () => {
  const { chromium } = await loadPlaywright();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/" || path === "/index.html")
        return new Response(readFileSync(join(labelerDir, "index.html")), {
          headers: { "content-type": "text/html" },
        });
      if (path === "/app.js")
        return new Response(readFileSync(join(labelerDir, "app.js")), {
          headers: { "content-type": "text/javascript" },
        });
      if (path === "/styles.css")
        return new Response(readFileSync(join(labelerDir, "styles.css")), {
          headers: { "content-type": "text/css" },
        });
      if (path === "/captures/sample.svg")
        return new Response(image, { headers: { "content-type": "image/svg+xml" } });
      if (path === "/captures/long.svg")
        return new Response(longImage, { headers: { "content-type": "image/svg+xml" } });
      if (path === "/api/pages")
        return json(
          {
            pages: [
              {
                id: pageId,
                title: "Sample site",
                url: "https://example.test/article",
                capturedAt: "2026-09-18T00:00:00.000Z",
                width: 1200,
                height: 800,
                screenshotUrl: "/captures/sample.svg",
                reviewedCount: new Set(annotations.map((item) => item.nodeId)).size,
                pageReviewedCount: pageAnnotations.length ? 1 : 0,
              },
              {
                id: secondPageId,
                title: "Long sample",
                url: "https://example.test/long",
                capturedAt: "2026-09-18T00:00:00.000Z",
                width: 1200,
                height: 4800,
                screenshotUrl: "/captures/long.svg",
                reviewedCount: 0,
                pageReviewedCount: 0,
              },
            ],
            regions: REGIONS,
            functions: ["navigation", "card", "form", "consent_banner", "unknown"],
            purposes: PURPOSES,
            pageTypes: [
              "homepage",
              "landing_page",
              "about",
              "blog_index",
              "post",
              "article",
              "unknown",
            ],
            pageTypeGroups: [
              { id: "entry", label: "Entry pages", values: ["homepage", "landing_page", "about"] },
              {
                id: "editorial",
                label: "Editorial",
                values: ["blog_index", "post", "article", "unknown"],
              },
            ],
            contentKinds: ["article", "product", "other", "unknown"],
            componentSubtypes: COMPONENT_SUBTYPES,
            statefulComponentTypes: STATEFUL_COMPONENT_TYPES,
            contexts: ["site", "article", "main", "header", "footer", "unknown"],
          },
          { headers: { "set-cookie": `labeler_csrf=${token}; Path=/; SameSite=Strict` } },
        );
      if (path === "/api/stats") return json(statsFixture());
      if (path === "/api/page-annotations" && request.method === "POST") {
        const payload = (await request.json()) as Record<string, unknown>;
        pagePosts.push(payload);
        const annotation = {
          ...payload,
          id: `page_ann_${pageAnnotations.length + 1}`,
          timestamp: "2026-09-18T00:00:00.000Z",
        };
        pageAnnotations.push(annotation);
        return json({ annotation }, { status: 201 });
      }
      if (path === "/api/model-reviews" && request.method === "POST") {
        const payload = (await request.json()) as Record<string, unknown>;
        modelReviewPosts.push(payload);
        const modelReview = { ...payload, id: `review_${modelReviews.length + 1}` };
        modelReviews.push(modelReview);
        return json({ modelReview }, { status: 201 });
      }
      if (path === `/api/pages/${pageId}`) return json(pageFixture());
      if (path === `/api/pages/${secondPageId}`) return json(secondPageFixture());
      if (path === "/api/annotations" && request.method === "POST") {
        expect(request.headers.get("x-labeler-csrf")).toBe(token);
        const payload = (await request.json()) as Record<string, unknown>;
        posts.push(payload);
        if (payload.decision === "reject") expect(payload.context).toBe("footer");
        const annotation = {
          ...payload,
          id: `ann_${String(annotations.length + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
          source: "human",
          gold: false,
          timestamp: "2026-09-18T00:00:00.000Z",
          role: payload.role ?? null,
          context: payload.context ?? null,
          comment: payload.comment || null,
        };
        annotations.push(annotation);
        return json({ annotation }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  browser = await chromium.launch(browserLaunchOptions());
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

test("combines regions and functions, then hydrates revisions and legacy labels", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(server.url.toString());
  await page.getByRole("button", { name: /Sample site/ }).click();
  await page.locator("#page-image[src*='/captures/sample.svg']").waitFor();

  const stage = await page.locator("#screenshot-stage").boundingBox();
  if (!stage) throw new Error("screenshot stage was not rendered");
  await page.mouse.click(stage.x + stage.width * 0.5, stage.y + stage.height * 0.07);
  await page.locator("#selected-tag").getByText("<header>").waitFor();
  expect(await page.locator("#model-suggestion-section").isHidden()).toBe(false);
  expect(await page.locator("#model-review-question").textContent()).toBe(
    "Is this a navigation menu in the header?",
  );
  expect(await page.locator("#model-proposal-region").textContent()).toBe("Header");
  expect(await page.locator("#model-proposal-component").textContent()).toBe("Navigation menu");
  expect(await page.locator("#model-proposal-purpose").textContent()).toBe("Navigation");
  const headerRegion = page.locator(`#node-layer [data-node-id="${headerId}"]`);
  expect(await headerRegion.evaluate((element) => element.classList.contains("model-target"))).toBe(
    true,
  );
  const stageBox = await page.locator("#screenshot-stage").boundingBox();
  const headerBox = await headerRegion.boundingBox();
  if (!stageBox || !headerBox) throw new Error("Target outline was not rendered");
  expect(Math.abs(headerBox.y - stageBox.y)).toBeLessThan(2);
  expect(Math.abs(headerBox.height - (stageBox.height * 116) / 800)).toBeLessThan(2);
  await page.screenshot({ path: "/tmp/labeler-prepared-model-target.png", fullPage: true });
  expect(await page.locator("#regions-site_header").isChecked()).toBe(true);
  await page.locator("#model-suggestion-section details > summary").click();
  await page.locator("#advanced-editor > summary").click();
  await page.locator("#use-model-suggestion").click();
  expect(await page.locator("#regions-site_header").isChecked()).toBe(true);
  expect(await page.locator("#purposes-navigation").isChecked()).toBe(true);
  expect(await page.locator("#model-suggestion-chips").textContent()).toContain("Region: Header");
  await page.screenshot({ path: "/tmp/labeler-model-node-review.png", fullPage: true });
  await page.locator("#regions-unknown").check();
  expect(await page.locator("#correct-model-suggestion").textContent()).toBe(
    "Manual correction selected",
  );
  await page.locator("#regions-site_header").check();
  expect(await page.locator("#regions-unknown").isChecked()).toBe(false);
  await page.locator("#purposes-unknown").check();
  await page.getByLabel("Navigation").check();
  expect(await page.locator("#purposes-unknown").isChecked()).toBe(false);
  await page.locator("#canvas").focus();
  await page.keyboard.press("Enter");
  await waitForPostCount(1);
  await waitForSave(page);
  expect(posts[0]).toMatchObject({
    pageId,
    nodeId: headerId,
    decision: "label",
    regions: ["site_header"],
    purposes: ["navigation"],
    modelSuggestionId: "model_aaaaaaaaaaaaaaaaaaaaaaaa",
    modelReview: "correct",
    captureHash: hash,
  });

  await page.locator("#selected-tag").getByText("<nav>").waitFor();
  expect(
    await page
      .locator(`#node-layer [data-node-id="${navId}"]`)
      .evaluate((element) => element.classList.contains("model-target")),
  ).toBe(true);
  expect(await headerRegion.evaluate((element) => element.classList.contains("selected"))).toBe(
    false,
  );
  await page.locator("#canvas").focus();
  await page.keyboard.press("k");
  await page.locator("#selected-tag").getByText("<header>").waitFor();
  await page.locator("#next-model-suggestion").click();
  await page.locator("#selected-tag").getByText("<nav>").waitFor();
  await page.locator("#correct-model-suggestion").click();
  expect(await page.locator("#regions-footer").isChecked()).toBe(true);
  await page.getByLabel("Footer").check();
  await page.getByLabel("Navigation").check();
  await page.locator("#advanced-options").click();
  await page.locator("#context-select").selectOption("footer");
  await page.locator("#reject-button").click();
  await waitForPostCount(2);
  await waitForSave(page);
  expect(posts[1]).toMatchObject({
    pageId,
    nodeId: navId,
    decision: "reject",
    regions: ["footer"],
    purposes: [],
    context: "footer",
    modelSuggestionId: "model_cccccccccccccccccccccccc",
    modelReview: "correct",
  });

  await page.locator("#next-suggestion").click();
  await page.locator("#selected-tag").getByText("<aside>").waitFor();
  await page.locator("#reject-model-suggestion").click();
  expect(await page.locator("#regions-sidebar").isChecked()).toBe(false);
  await page.locator("#comment").fill("Not enough evidence for this model guess.");
  await page.locator("#save-model-rejection").click();
  await page.waitForFunction(
    () => document.getElementById("save-status")?.textContent === "Model rejection saved",
  );
  expect(modelReviewPosts[0]).toMatchObject({
    pageId,
    nodeId: sidebarId,
    modelSuggestionId: "model_dddddddddddddddddddddddd",
    review: "reject",
    comment: "Not enough evidence for this model guess.",
    captureHash: hash,
  });
  await page.waitForFunction(() =>
    document.getElementById("stats-model-actions")?.textContent?.includes("1 rejected"),
  );
  expect(await page.locator("#queue-stats").isHidden()).toBe(false);
  expect(await page.locator("#stats-model-note").textContent()).toContain(
    "Provisional suggestions are not human labels",
  );
  await page.locator("#canvas").focus();
  await page.keyboard.press("Escape");
  await page.locator("#next-suggestion").click();
  await page.locator("#selected-tag").getByText("<aside>").waitFor();
  expect(await page.locator("#regions-sidebar").isChecked()).toBe(false);
  await page.getByLabel("Sidebar").check();
  await page.getByLabel("Navigation").check();
  await page.locator("#save-button").click();
  await waitForPostCount(3);
  await waitForSave(page);
  expect(posts[2]).toMatchObject({
    nodeId: sidebarId,
    decision: "label",
    regions: ["sidebar"],
    purposes: ["navigation"],
  });
  expect(posts[2].modelSuggestionId).toBeUndefined();

  await page.locator("#next-suggestion").click();
  await page.locator("#selected-tag").getByText("<footer>").waitFor();
  await page.getByLabel("Footer").check();
  await page.getByLabel("Navigation").check();
  await page.locator("#comment").fill("Footer navigation reviewed.");
  await page.locator("#save-button").click();
  await waitForPostCount(4);
  await waitForSave(page);
  expect(posts[3]).toMatchObject({
    nodeId: footerId,
    regions: ["footer"],
    purposes: ["navigation"],
  });
  await page.locator("#comment").fill("Footer navigation revised.");
  await page.locator("#save-button").click();
  await waitForPostCount(5);
  await waitForSave(page);
  expect(posts[4]).toMatchObject({
    nodeId: footerId,
    supersedes: annotations[3]?.id,
    regions: ["footer"],
    purposes: ["navigation"],
  });
  annotations.push({
    id: "ann_99999999-0000-4000-8000-000000000000",
    pageId,
    nodeId: navId,
    decision: "label",
    role: "navigation",
    functions: ["navigation"],
    purposes: [],
    context: "footer",
    comment: "Legacy navigation label.",
    boundary: "correct",
    clientRequestId: "legacy-navigation",
    captureHash: hash,
    source: "human",
    gold: false,
    timestamp: "2026-09-18T00:00:00.000Z",
  });

  await page.reload();
  await page.getByRole("button", { name: /Sample site/ }).click();
  await page.locator("#page-image[src*='/captures/sample.svg']").waitFor();
  const reloadedStage = await page.locator("#screenshot-stage").boundingBox();
  if (!reloadedStage) throw new Error("reloaded screenshot stage was not rendered");
  await page.mouse.click(
    reloadedStage.x + reloadedStage.width * 0.5,
    reloadedStage.y + reloadedStage.height * 0.92,
  );
  expect(await page.locator("#regions-footer").isChecked()).toBe(true);
  expect(await page.locator("#purposes-navigation").isChecked()).toBe(true);
  expect(await page.locator("#comment").inputValue()).toBe("Footer navigation revised.");
  await page.mouse.click(
    reloadedStage.x + reloadedStage.width * 0.8,
    reloadedStage.y + reloadedStage.height * 0.07,
  );
  expect(await page.locator("#regions-footer").isChecked()).toBe(true);
  expect(await page.locator("#purposes-navigation").isChecked()).toBe(true);
  expect(await page.locator("#comment").inputValue()).toBe("Legacy navigation label.");
  expect(await page.locator("#legacy-purpose-projection").textContent()).toContain(
    "Earlier function label: Navigation",
  );
  expect((await page.locator("#reviewed-progress").textContent())?.trim()).toBe("0 / 2");
  expect(await page.locator(".page-item-meta").first().textContent()).toContain("4 elements");
  await page.close();
}, 60_000);

test("labels nested controls as components without inferring them from DOM semantics", async () => {
  const page = await browser.newPage({ viewport: { width: 1260, height: 900 } });
  await page.goto(server.url.toString());
  await page.getByRole("button", { name: /Sample site/ }).click();
  await page.locator("#page-image[src*='/captures/sample.svg']").waitFor();
  await page.locator("#elements-mode").click();
  const stage = await page.locator("#screenshot-stage").boundingBox();
  if (!stage) throw new Error("screenshot stage was not rendered");
  await page.mouse.click(stage.x + stage.width * 0.44, stage.y + stage.height * 0.47);
  await page.locator("#selected-tag").getByText("<button>").waitFor();
  await page.locator("#advanced-editor > summary").click();
  await page.locator("#component-trigger").click();
  await page
    .locator(".component-option")
    .filter({ hasText: /^Button$/ })
    .click();
  await page.locator("#purposes-submit").check();
  await page.locator("#state-disabled").check();
  await page.screenshot({ path: "/tmp/labeler-v3-review.png", fullPage: true });
  await page.locator("#save-button").click();
  await waitForPostCount(6);
  await waitForSave(page);
  expect(posts[5]).toMatchObject({
    nodeId: buttonId,
    componentType: "button",
    purposes: ["submit"],
    observedState: ["disabled"],
  });

  await page.locator("#parent-button").click();
  await page.locator("#selected-tag").getByText("<form>").waitFor();
  await page.locator("#component-trigger").click();
  await page.locator("#component-search").fill("form");
  await page
    .locator(".component-option")
    .filter({ hasText: /^Form$/ })
    .click();
  await page.locator("#component-subtype").selectOption("newsletter");
  await page.locator("#save-button").click();
  await waitForPostCount(7);
  await waitForSave(page);
  expect(posts[6]).toMatchObject({
    nodeId: formId,
    componentType: "form",
    componentSubtype: "newsletter",
  });

  await page.locator("#parent-button").click();
  await page.locator("#selected-tag").getByText("<div>").waitFor();
  expect(await page.locator("#use-model-suggestion").isDisabled()).toBe(true);
  expect(await page.locator("#use-model-suggestion").textContent()).toBe("No applicable labels");
  await page.locator("#component-trigger").click();
  await page.locator("#component-search").fill("card");
  await page
    .locator(".component-option")
    .filter({ hasText: /^Card$/ })
    .first()
    .click();
  await page.locator("#save-button").click();
  await waitForPostCount(8);
  await waitForSave(page);
  expect(posts[7]).toMatchObject({ nodeId: cardId, componentType: "card" });

  if (await page.locator("#component-picker").isHidden())
    await page.locator("#component-trigger").click();
  await page.locator("#component-search").fill("content section");
  await page
    .locator(".component-option")
    .filter({ hasText: /^Content section$/ })
    .click();
  await page.locator("#component-subtype").selectOption("pricing");
  await page.locator("#regions-hero").check();
  await page.locator("#purposes-promotion").check();
  await page.locator("#save-button").click();
  await waitForPostCount(9);
  await waitForSave(page);
  expect(posts[8]).toMatchObject({
    nodeId: cardId,
    regions: ["hero"],
    componentType: "content_section",
    componentSubtype: "pricing",
    purposes: ["promotion"],
  });

  await page.locator("#child-button").click();
  await page.locator("#selected-tag").getByText("<form>").waitFor();
  await page.locator("#component-trigger").click();
  await page.locator("#component-search").fill("dialog");
  await page
    .locator(".component-option")
    .filter({ hasText: /^Dialog \(modal\/popup\)$/ })
    .click();
  await page.locator("#component-subtype").selectOption("modal");
  await page.locator("#regions-overlay").check();
  await page.locator("#purposes-consent").check();
  await page.locator("#state-open").check();
  await page.locator("#save-button").click();
  await waitForPostCount(10);
  await waitForSave(page);
  expect(posts[9]).toMatchObject({
    nodeId: formId,
    regions: ["overlay"],
    componentType: "dialog",
    componentSubtype: "modal",
    purposes: ["consent"],
    observedState: ["open"],
  });

  annotations.push({
    id: "ann_88888888-0000-4000-8000-000000000000",
    pageId,
    nodeId: formId,
    decision: "label",
    role: "form",
    context: null,
    comment: "Old form label.",
    boundary: "correct",
    clientRequestId: "legacy-form",
    captureHash: hash,
    source: "human",
    gold: false,
    timestamp: "2026-09-18T00:00:00.000Z",
  });
  await page.reload();
  await page.getByRole("button", { name: /Sample site/ }).click();
  await page.locator("#page-image[src*='/captures/sample.svg']").waitFor();
  await page.locator("#elements-mode").click();
  const reloaded = await page.locator("#page-image").boundingBox();
  if (!reloaded) throw new Error("reloaded screenshot was not rendered");
  await page.mouse.click(
    reloaded.x + reloaded.width * (750 / 1200),
    reloaded.y + reloaded.height * (290 / 800),
  );
  await page.locator("#selected-tag").getByText("<form>").waitFor();
  await page.locator("#advanced-editor > summary").click();
  expect(await page.locator("#component-trigger").textContent()).toBe("Form");
  expect(await page.locator("#component-projection").isHidden()).toBe(false);
  await page.close();
}, 60_000);

test("keeps filtered page-type drafts, saves hidden choices, and can discard an unfinished page draft", async () => {
  const page = await browser.newPage({ viewport: { width: 1260, height: 900 } });
  await page.goto(server.url.toString());
  await page.getByRole("button", { name: /Sample site/ }).click();
  await page.locator("#page-image[src*='/captures/sample.svg']").waitFor();
  await page.locator("#page-tab").click();
  expect(
    await page
      .locator(`#node-layer [data-node-id="${headerId}"]`)
      .evaluate((element) => element.classList.contains("selected")),
  ).toBe(false);
  expect(await page.locator("#pageTypes-homepage").isChecked()).toBe(true);
  await page.locator("#page-model-suggestion-section details > summary").click();
  await page.locator("#page-advanced-editor > summary").click();
  await page.locator("#use-page-model-suggestion").click();
  expect(await page.locator("#pageTypes-homepage").isChecked()).toBe(true);
  expect(await page.locator("#pageTypes-blog_index").isChecked()).toBe(true);
  await page.screenshot({ path: "/tmp/labeler-model-page-review.png", fullPage: true });
  await page.locator("#page-type-search").fill("landing");
  await page.locator("#pageTypes-landing_page").check();
  await page.locator("#page-advanced-editor .advanced > summary").click();
  await page.locator("#content-kinds-grid").getByLabel("Article").check();
  await page.locator("#page-comment").fill("Editorial home with a news index.");
  await page.locator("#page-save-button").click();
  await page.waitForFunction(
    () => document.getElementById("save-status")?.textContent === "Page label saved",
  );
  expect(pagePosts[0]).toMatchObject({
    pageId,
    decision: "label",
    pageTypes: ["homepage", "blog_index", "landing_page"],
    contentKinds: ["article"],
    modelSuggestionId: "model_bbbbbbbbbbbbbbbbbbbbbbbb",
    modelReview: "correct",
  });
  await page.locator("#page-type-search").fill("");
  expect(await page.locator("#pageTypes-homepage").isChecked()).toBe(true);
  expect(await page.locator("#pageTypes-blog_index").isChecked()).toBe(true);
  expect(await page.locator("#pageTypes-landing_page").isChecked()).toBe(true);
  expect(await page.locator("#page-comment").inputValue()).toBe(
    "Editorial home with a news index.",
  );

  await page.locator("#pageTypes-about").check();
  await page.locator("#canvas").focus();
  await page.keyboard.press("]");
  expect(await page.locator("#page-unsaved-notice").isHidden()).toBe(false);
  await page.keyboard.press("j");
  expect(await page.locator("#page-unsaved-notice").isHidden()).toBe(false);
  await page.locator("#page-keep-draft").click();
  await page.locator("#element-tab").click();
  expect(await page.locator("#page-pane").isHidden()).toBe(false);
  expect(await page.locator("#page-unsaved-notice").isHidden()).toBe(false);
  await page.locator("#page-keep-draft").click();
  expect(await page.locator("#pageTypes-about").isChecked()).toBe(true);
  await page.locator("#element-tab").click();
  await page.locator("#page-discard-draft").click();
  expect(await page.locator("#element-pane").isHidden()).toBe(false);
  await page.locator("#page-tab").click();
  expect(await page.locator("#pageTypes-homepage").isChecked()).toBe(true);
  expect(await page.locator("#pageTypes-landing_page").isChecked()).toBe(true);
  expect(await page.locator("#pageTypes-about").isChecked()).toBe(false);
  await page.close();
}, 60_000);

test("keeps the review shell fixed while selecting a footer in a long capture", async () => {
  const page = await browser.newPage({ viewport: { width: 1260, height: 720 } });
  await page.goto(server.url.toString());
  await page.getByRole("button", { name: /Sample site/ }).click();
  await page.locator("#page-image[src*='/captures/sample.svg']").waitFor();
  await page.getByRole("button", { name: /Long sample/ }).click();
  await page.locator("#page-image[src*='/captures/long.svg']").waitFor();
  await page.waitForFunction(() => {
    const image = document.getElementById("page-image") as HTMLImageElement | null;
    return Boolean(image?.complete && image.naturalHeight === 4800);
  });
  await page.locator(`[data-node-id="${longFooterId}"]`).waitFor();
  await page.locator("#next-model-suggestion").click();
  await page.locator(`#node-layer [data-node-id="${longTargetId}"]`).waitFor();
  await page.waitForFunction((targetId) => {
    const canvas = document.getElementById("canvas-scroll");
    const target = document.querySelector(`[data-node-id="${targetId}"]`);
    if (!canvas || !target) return false;
    const canvasBox = canvas.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    return targetBox.bottom > canvasBox.top && targetBox.top < canvasBox.bottom;
  }, longTargetId);
  expect(await page.locator("#zoom-select").inputValue()).toBe("200");
  expect(
    await page.locator("#canvas-scroll").evaluate((element: HTMLElement) => element.scrollTop),
  ).toBeGreaterThan(0);
  expect(
    await page
      .locator(`#node-layer [data-node-id="${longTargetId}"]`)
      .evaluate((element) => element.classList.contains("model-target")),
  ).toBe(true);
  await page.locator("#zoom-select").selectOption("fit");

  const before = {
    header: await page.locator(".topbar").boundingBox(),
    toolbar: await page.locator(".canvas-toolbar").boundingBox(),
    queue: await page.locator(".queue-panel").boundingBox(),
    inspector: await page.locator(".label-panel").boundingBox(),
  };
  expect(before.header?.y).toBe(0);
  expect(before.toolbar?.y).toBeGreaterThanOrEqual(58);
  await page.locator("#canvas-scroll").evaluate((element: HTMLElement) => {
    element.style.scrollBehavior = "auto";
    element.scrollTop = element.scrollHeight - element.clientHeight - 16;
  });
  await page.waitForFunction(() => {
    const canvas = document.getElementById("canvas-scroll");
    return Boolean(canvas && canvas.scrollTop > canvas.clientHeight);
  });
  const imageBox = await page.locator("#page-image").boundingBox();
  if (!imageBox) throw new Error("long screenshot was not rendered");
  await page.mouse.click(
    imageBox.x + imageBox.width / 2,
    imageBox.y + imageBox.height * (4650 / 4800),
  );
  await page.locator("#selected-tag").getByText("<footer>").waitFor();
  await page.locator("#advanced-editor > summary").click();

  const after = {
    header: await page.locator(".topbar").boundingBox(),
    toolbar: await page.locator(".canvas-toolbar").boundingBox(),
    queue: await page.locator(".queue-panel").boundingBox(),
    inspector: await page.locator(".label-panel").boundingBox(),
    windowScrollY: await page.evaluate(() => window.scrollY),
    queueScrollTop: await page
      .locator(".queue-panel")
      .evaluate((element: HTMLElement) => element.scrollTop),
    inspectorScrollTop: await page
      .locator(".label-panel")
      .evaluate((element: HTMLElement) => element.scrollTop),
    canvasScrollTop: await page
      .locator("#canvas-scroll")
      .evaluate((element: HTMLElement) => element.scrollTop),
  };
  expect(after.canvasScrollTop).toBeGreaterThan(0);
  expect(after.windowScrollY).toBe(0);
  expect(after.queueScrollTop).toBe(0);
  expect(after.inspectorScrollTop).toBe(0);
  expect(after.header?.y).toBe(before.header?.y);
  expect(after.toolbar?.y).toBe(before.toolbar?.y);
  expect(after.queue?.y).toBe(before.queue?.y);
  expect(after.inspector?.y).toBe(before.inspector?.y);
  await page.locator("#save-button").scrollIntoViewIfNeeded();
  const saveBox = await page.locator("#save-button").boundingBox();
  expect(Boolean(saveBox && saveBox.y >= 0 && saveBox.y + saveBox.height <= 720)).toBe(true);
  expect(
    await page.locator(".label-panel").evaluate((element: HTMLElement) => element.scrollTop),
  ).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect((await page.locator(".topbar").boundingBox())?.y).toBe(before.header?.y);
  await page.screenshot({ path: "/tmp/labeler-long-capture-layout.png", fullPage: false });
  await page.locator("#page-tab").click();
  await page.locator("#canvas").focus();
  await page.keyboard.press("k");
  await page.locator("#page-image[src*='/captures/sample.svg']").waitFor();
  await page.close();
}, 60_000);

test("keeps unfinished element edits when K looks back through model targets", async () => {
  const page = await browser.newPage({ viewport: { width: 1260, height: 900 } });
  await page.goto(server.url.toString());
  await page.getByRole("button", { name: /Sample site/ }).click();
  await page.locator("#page-image[src*='/captures/sample.svg']").waitFor();
  await page.waitForFunction(() => {
    const image = document.getElementById("page-image") as HTMLImageElement | null;
    return Boolean(image?.complete && image.naturalWidth > 0);
  });
  await page.locator("#zoom-select").selectOption("fit");
  await page
    .locator("#canvas-scroll")
    .evaluate((element: HTMLElement) => element.scrollTo({ left: 0, top: 0, behavior: "instant" }));
  const screenshot = await page.locator("#page-image").boundingBox();
  if (!screenshot) throw new Error("screenshot was not rendered");
  await page.mouse.click(
    screenshot.x + screenshot.width * (600 / 1200),
    screenshot.y + screenshot.height * (58 / 800),
  );
  await page.locator("#selected-tag").getByText("<header>").waitFor();
  await page.locator("#advanced-editor > summary").click();
  await page.locator("#comment").fill("Keep this correction before moving back.");
  await page.locator("#canvas").focus();
  await page.keyboard.press("k");
  expect(await page.locator("#unsaved-notice").isHidden()).toBe(false);
  await page.locator("#keep-draft").click();
  expect(await page.locator("#selected-tag").textContent()).toBe("<header>");
  expect(await page.locator("#comment").inputValue()).toBe(
    "Keep this correction before moving back.",
  );
  await page.close();
}, 60_000);

test("uses a Typesafe sidecar through the real server without touching active data", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "labeler-model-ui-"));
  const realPageId = "page_1234567890abcdef12345678";
  const realNodeId = "node_abcdef1234567890abcdef12";
  const realHash = `sha256:${"c".repeat(64)}`;
  const suggestionId = "msug_12345678-1234-4234-8234-1234567890ab";
  const store = new LabelStore(dataDir);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/sgAAAABJRU5ErkJggg==",
    "base64",
  );
  store.writeCapture(
    {
      id: realPageId,
      url: "https://example.test/",
      title: "Temporary model test",
      capturedAt: "2026-09-18T00:00:00.000Z",
      contentHash: realHash,
      captureHash: realHash,
      width: 1,
      height: 1,
      viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
      screenshotUrl: `/captures/${realPageId}.png`,
      split: "training-review",
      nodes: [
        {
          id: realNodeId,
          parentId: null,
          tag: "header",
          role: "banner",
          text: "",
          selector: "header",
          rect: { x: 0, y: 0, width: 1, height: 1 },
          depth: 1,
          suggestion: null,
        },
      ],
    },
    png,
  );
  writeFileSync(
    store.modelSuggestionsPath,
    `${JSON.stringify({
      schemaVersion: 1,
      id: suggestionId,
      pageId: realPageId,
      nodeId: null,
      captureHash: realHash,
      provider: "typesafe",
      modelId: "jev",
      modelRevision: "pilot-v2",
      promptRevision: "page-v1",
      snapshotHash: `sha256:${"d".repeat(64)}`,
      rawAnswers: { homepage: true },
      provisional: true,
      mappedLabels: { pageTypes: ["homepage"] },
      axisProbabilities: { pageTypes: [{ label: "homepage", yesProbability: 0.73 }] },
      createdAt: "2026-09-18T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  const existingPort = process.env.PORT;
  process.env.PORT = "0";
  const realServer = createLabelerServer({ dataDir, staticDir: labelerDir });
  if (existingPort === undefined) delete process.env.PORT;
  else process.env.PORT = existingPort;
  const page = await browser.newPage({ viewport: { width: 1260, height: 900 } });
  try {
    await page.goto(realServer.url.toString());
    await page.locator("#page-image").waitFor();
    await page.locator("#page-tab").click();
    await page
      .locator("#page-model-suggestion-section")
      .getByText("Provisional model output")
      .waitFor();
    expect(await page.locator("#pageTypes-homepage").isChecked()).toBe(true);
    await page.locator("#page-advanced-editor > summary").click();
    await page.locator("#page-comment").fill("Confirmed from captured page.");
    await page.locator("#canvas").focus();
    expect(
      await page.locator("#canvas").evaluate((element) => document.activeElement === element),
    ).toBe(true);
    const savedResponse = page.waitForResponse(
      (response) => response.url().endsWith("/api/page-annotations") && response.status() === 201,
    );
    await page.keyboard.press("Enter");
    await savedResponse;
    const saved = store.pageAnnotationsForPage(realPageId).at(-1);
    expect(saved).toMatchObject({
      pageId: realPageId,
      pageTypes: ["homepage"],
      modelSuggestionId: suggestionId,
      modelReview: "accept",
      comment: "Confirmed from captured page.",
    });
    expect(await page.locator("#undo-last-review").isDisabled()).toBe(false);
    const undoneResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/review-actions/undo") && response.status() === 201,
    );
    await page.locator("#undo-last-review").click();
    await undoneResponse;
    await page.locator("#page-model-suggestion-section").waitFor();
    expect(await page.locator("#page-model-suggestion-section").isHidden()).toBe(false);
    expect(store.pageAnnotationsForPage(realPageId)).toHaveLength(0);
    expect(await page.locator("#undo-last-review").isDisabled()).toBe(true);
  } finally {
    await page.close();
    realServer.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("reviews one prepared model card per deliberate swipe and keeps skips local", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "labeler-swipe-ui-"));
  const swipePageId = "page_1234567890abcdef12345678";
  const swipeHash = `sha256:${"f".repeat(64)}`;
  const nodeIds = [
    "node_aaaaaaaaaaaaaaaaaaaaaaaa",
    "node_bbbbbbbbbbbbbbbbbbbbbbbb",
    "node_cccccccccccccccccccccccc",
    "node_dddddddddddddddddddddddd",
  ];
  const suggestionIds = [
    "msug_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "msug_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "msug_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "msug_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ];
  const store = new LabelStore(dataDir);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/sgAAAABJRU5ErkJggg==",
    "base64",
  );
  store.writeCapture(
    {
      id: swipePageId,
      url: "https://example.test/swipe",
      title: "Temporary swipe review",
      capturedAt: "2026-09-19T00:00:00.000Z",
      contentHash: swipeHash,
      captureHash: swipeHash,
      width: 1,
      height: 1,
      viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
      screenshotUrl: `/captures/${swipePageId}.png`,
      split: "training-review",
      nodes: nodeIds.map((id, index) => ({
        id,
        parentId: null,
        tag: ["header", "nav", "footer", "main"][index],
        role: null,
        text: "",
        selector: `[data-swipe-node=\"${index}\"]`,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        depth: 1,
        suggestion: null,
      })),
    },
    png,
  );
  const suggestion = (id: string, nodeId: string, rawClass: string) => ({
    schemaVersion: 1,
    id,
    pageId: swipePageId,
    nodeId,
    captureHash: swipeHash,
    provider: "typesafe",
    modelId: "jev",
    modelRevision: "swipe-v1",
    promptRevision: "dom-v1",
    snapshotHash: `sha256:${id.slice(5).replaceAll("-", "").padEnd(64, "0")}`,
    rawAnswers: {},
    provisional: true,
    rawClass,
    mappedLabels: { regions: ["main_content"] },
    axisProbabilities: { regions: [{ label: "main_content", yesProbability: 0.9 }] },
    createdAt: "2026-09-19T00:00:00.000Z",
  });
  writeFileSync(
    store.modelSuggestionsPath,
    suggestionIds
      .map((id, index) => JSON.stringify(suggestion(id, nodeIds[index], `swipe-${index + 1}`)))
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  const existingPort = process.env.PORT;
  process.env.PORT = "0";
  const realServer = createLabelerServer({ dataDir, staticDir: labelerDir });
  if (existingPort === undefined) delete process.env.PORT;
  else process.env.PORT = existingPort;
  const page = await browser.newPage({ viewport: { width: 1260, height: 900 } });
  page.setDefaultTimeout(5_000);
  const swipe = async (deltaX: number, deltaY = 0) => {
    const box = await page.locator("#model-suggestion-section").boundingBox();
    if (!box) throw new Error("Model review card was not visible");
    const x = box.x + box.width / 2;
    const y = box.y + 72;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + deltaX, y + deltaY, { steps: 3 });
    await page.mouse.up();
  };
  try {
    await page.goto(realServer.url.toString());
    await page.locator("#model-suggestion-copy").getByText("swipe-1").waitFor();
    expect(await page.locator("#selected-tag").textContent()).toBe("<header>");
    expect(await page.locator("#model-suggestion-context").textContent()).toContain("<header>");

    const noWrites = async () => {
      await Bun.sleep(100);
      expect(store.annotationsForPage(swipePageId)).toHaveLength(0);
      expect(store.modelReviewsForPage(swipePageId)).toHaveLength(0);
    };
    const button = await page.locator("#model-ok").boundingBox();
    if (!button) throw new Error("OK control was not visible");
    await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
    await page.mouse.down();
    await page.mouse.move(button.x + button.width / 2 + 150, button.y + button.height / 2, {
      steps: 3,
    });
    await page.mouse.up();
    await noWrites();
    await swipe(42);
    await swipe(20, 140);
    await noWrites();

    await page.route("**/api/annotations", (route) => route.fulfill({ status: 500 }));
    await swipe(150);
    await page.locator("#save-status").getByText("Save failed").waitFor();
    expect(await page.locator("#selected-tag").textContent()).toBe("<header>");
    await noWrites();
    await page.unroute("**/api/annotations");

    const accepted = page.waitForResponse(
      (response) => response.url().endsWith("/api/annotations") && response.status() === 201,
    );
    await swipe(150);
    await accepted;
    await page.locator("#model-suggestion-copy").getByText("swipe-2").waitFor();
    expect(store.annotationsForPage(swipePageId)).toHaveLength(1);
    expect(store.annotationsForPage(swipePageId)[0]).toMatchObject({
      nodeId: nodeIds[0],
      modelSuggestionId: suggestionIds[0],
      modelReview: "accept",
      regions: ["main_content"],
      source: "human",
      gold: false,
    });

    await page.locator("#canvas").focus();
    await page.keyboard.press("j");
    await page.locator("#model-suggestion-copy").getByText("swipe-3").waitFor();
    expect(store.annotationsForPage(swipePageId)).toHaveLength(1);
    expect(store.modelReviewsForPage(swipePageId)).toHaveLength(0);

    const rejected = page.waitForResponse(
      (response) => response.url().endsWith("/api/model-reviews") && response.status() === 201,
    );
    await swipe(-150);
    await rejected;
    await page.locator("#model-suggestion-copy").getByText("swipe-4").waitFor();
    expect(store.modelReviewsForPage(swipePageId)[0]).toMatchObject({
      nodeId: nodeIds[2],
      modelSuggestionId: suggestionIds[2],
      review: "reject",
    });

    await page.locator("#canvas").focus();
    const keyboardRejected = page.waitForResponse(
      (response) => response.url().endsWith("/api/model-reviews") && response.status() === 201,
    );
    await page.keyboard.press("x");
    await keyboardRejected;
    expect(store.annotationsForPage(swipePageId)).toHaveLength(1);
    expect(
      store.modelReviewsForPage(swipePageId).map((review) => review.modelSuggestionId),
    ).toEqual([suggestionIds[2], suggestionIds[3]]);
    const undoneReject = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/review-actions/undo") && response.status() === 201,
    );
    await page.locator("#canvas").focus();
    await page.keyboard.press("Meta+z");
    await undoneReject;
    await page.locator("#model-suggestion-copy").getByText("swipe-4").waitFor();
    expect(await page.locator("#selected-tag").textContent()).toBe("<main>");
    expect(
      store.modelReviewsForPage(swipePageId).map((review) => review.modelSuggestionId),
    ).toEqual([suggestionIds[2]]);
  } finally {
    await page.close();
    realServer.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("queues only the latest model version and never reopens a reviewed target", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "labeler-model-version-ui-"));
  const versionPageId = "page_1234567890abcdef12345678";
  const firstNodeId = "node_bcdef1234567890abcdef123";
  const secondNodeId = "node_cdef1234567890abcdef1234";
  const versionHash = `sha256:${"e".repeat(64)}`;
  const oldSuggestionId = "msug_11111111-1111-4111-8111-111111111111";
  const currentSuggestionId = "msug_22222222-2222-4222-8222-222222222222";
  const nextSuggestionId = "msug_33333333-3333-4333-8333-333333333333";
  const store = new LabelStore(dataDir);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/sgAAAABJRU5ErkJggg==",
    "base64",
  );
  store.writeCapture(
    {
      id: versionPageId,
      url: "https://example.test/versioned",
      title: "Temporary version queue test",
      capturedAt: "2026-09-19T00:00:00.000Z",
      contentHash: versionHash,
      captureHash: versionHash,
      width: 1,
      height: 1,
      viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
      screenshotUrl: `/captures/${versionPageId}.png`,
      split: "training-review",
      nodes: [
        {
          id: firstNodeId,
          parentId: null,
          tag: "header",
          role: "banner",
          text: "",
          selector: "header",
          rect: { x: 0, y: 0, width: 1, height: 1 },
          depth: 1,
          suggestion: null,
        },
        {
          id: secondNodeId,
          parentId: null,
          tag: "footer",
          role: "contentinfo",
          text: "",
          selector: "footer",
          rect: { x: 0, y: 0, width: 1, height: 1 },
          depth: 1,
          suggestion: null,
        },
      ],
    },
    png,
  );
  const suggestion = (id: string, nodeId: string, revision: string, rawClass: string) => ({
    schemaVersion: 1,
    id,
    pageId: versionPageId,
    nodeId,
    captureHash: versionHash,
    provider: "typesafe",
    modelId: "jev",
    modelRevision: revision,
    promptRevision: "dom-v3",
    snapshotHash: `sha256:${id.slice(5).replaceAll("-", "").padEnd(64, "0")}`,
    rawAnswers: {},
    provisional: true,
    rawClass,
    mappedLabels: { regions: ["site_header"] },
    axisProbabilities: { regions: [{ label: "site_header", yesProbability: 0.9 }] },
    createdAt: "2026-09-19T00:00:00.000Z",
  });
  writeFileSync(
    store.modelSuggestionsPath,
    [
      suggestion(oldSuggestionId, firstNodeId, "old", "old-model-target"),
      suggestion(currentSuggestionId, firstNodeId, "new", "latest-model-target"),
      suggestion(nextSuggestionId, secondNodeId, "new", "next-model-target"),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  const existingPort = process.env.PORT;
  process.env.PORT = "0";
  const realServer = createLabelerServer({ dataDir, staticDir: labelerDir });
  if (existingPort === undefined) delete process.env.PORT;
  else process.env.PORT = existingPort;
  const page = await browser.newPage({ viewport: { width: 1260, height: 900 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(realServer.url.toString());
    await page.locator("#page-image").waitFor();
    await page.locator("#selected-tag").getByText("<header>").waitFor();
    expect(await page.locator("#model-suggestion-copy").textContent()).toBe("latest-model-target");
    expect(await page.locator("#model-suggestion-model").textContent()).toContain("new");

    await page.locator("#canvas").focus();
    const firstReview = page.waitForResponse(
      (response) => response.url().endsWith("/api/model-reviews") && response.status() === 201,
    );
    await page.keyboard.press("x");
    await firstReview;
    await page.locator("#selected-tag").getByText("<footer>").waitFor();
    expect(
      store.modelReviewsForPage(versionPageId).map((review) => review.modelSuggestionId),
    ).toEqual([currentSuggestionId]);

    expect(await page.locator("#model-suggestion-copy").textContent()).toBe("next-model-target");
    await page.locator("#canvas").focus();
    const secondReview = page.waitForResponse(
      (response) => response.url().endsWith("/api/model-reviews") && response.status() === 201,
    );
    await page.keyboard.press("x");
    await secondReview;
    await page.keyboard.press("j");
    expect(await page.locator("#selected-tag").textContent()).toBe("<footer>");
    expect(
      store.modelReviewsForPage(versionPageId).map((review) => review.modelSuggestionId),
    ).toEqual([currentSuggestionId, nextSuggestionId]);
    expect(
      store
        .modelReviewsForPage(versionPageId)
        .some((review) => review.modelSuggestionId === oldSuggestionId),
    ).toBe(false);
  } finally {
    await page.close();
    realServer.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 60_000);
