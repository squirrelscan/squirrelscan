import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { handleRequest } from "./server.ts";
import { LabelStore } from "./store.ts";
import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.ts";
import type { Browser } from "playwright";
import type { CapturedPage } from "./types.ts";

// A temp primary data dir plus a temp cohort; nothing outside tmp is touched and
// the server binds a random free port.
const pageId = "page_abcabcabcabcabcabcabc123";
const nodeId = "node_abcabcabcabcabcabcabc123";
const captureHash = `sha256:${"b".repeat(64)}`;
const jevId = "msug_00000000-0000-4000-8000-0000000000a1";
const lunaId = "msug_00000000-0000-4000-8000-0000000000b2";
/**
 * A real PNG, because the app only draws the node layer once the screenshot
 * fires `onload`. The capture route always serves `image/png`, so SVG bytes
 * would fail to decode and no node would ever be clickable.
 */
function png(width: number, height: number): Uint8Array {
  const table = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = (bytes: Uint8Array) => {
    let value = 0xffffffff;
    for (const byte of bytes) value = table[(value ^ byte) & 0xff]! ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  // Each scanline is a filter byte (0 = none) followed by one byte per pixel.
  const raw = Buffer.alloc(height * (width + 1), 0xee);
  for (let row = 0; row < height; row += 1) raw[row * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const image = png(1200, 800);

let browser!: Browser;
let server: ReturnType<typeof Bun.serve>;
let store: LabelStore;
const directories: string[] = [];
const contexts: import("playwright").BrowserContext[] = [];

function capture(): CapturedPage {
  return {
    id: pageId,
    url: "https://example.test/article",
    title: "Sample site",
    capturedAt: "2026-09-19T00:00:00.000Z",
    contentHash: `sha256:${"a".repeat(64)}`,
    captureHash,
    width: 1200,
    height: 800,
    viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
    screenshotUrl: `/captures/${pageId}.png`,
    split: "training-review",
    nodes: [
      {
        id: nodeId,
        parentId: null,
        tag: "footer",
        role: "contentinfo",
        text: "Site footer with links",
        selector: "html > body:nth-of-type(1) > footer:nth-of-type(1)",
        rect: { x: 0, y: 400, width: 1200, height: 300 },
        depth: 2,
        suggestion: null,
      },
    ],
  };
}

function suggestion(id: string, modelId: string, componentType: string, regions: string[]) {
  return {
    schemaVersion: 1,
    id,
    pageId,
    nodeId,
    captureHash,
    provider: "typesafe",
    modelId,
    modelRevision: `${modelId}-1`,
    promptRevision: "v4",
    taxonomyRevision: "dom-taxonomy-v2",
    snapshotHash: `sha256:${"c".repeat(64)}`,
    rawAnswers: {},
    provisional: true,
    mappedLabels: { componentType, regions },
    createdAt: "2026-09-19T00:00:00.000Z",
  };
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "comparison-primary-"));
  const cohortDir = mkdtempSync(join(tmpdir(), "comparison-cohort-"));
  directories.push(dataDir, cohortDir);
  new LabelStore(dataDir).ensureDirectories();
  mkdirSync(join(cohortDir, "captures"), { recursive: true });
  writeFileSync(join(cohortDir, "captures", `${pageId}.json`), JSON.stringify(capture()));
  writeFileSync(join(cohortDir, "captures", `${pageId}.png`), image);
  writeFileSync(
    join(cohortDir, "model-suggestions.jsonl"),
    [
      JSON.stringify(suggestion(jevId, "jev", "content_section", ["main_content"])),
      JSON.stringify(suggestion(lunaId, "luna", "layout_container", ["footer"])),
    ].join("\n") + "\n",
  );
  store = new LabelStore(dataDir, [{ id: "review-v1", dir: cohortDir }]);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => handleRequest(request, store, import.meta.dir),
  });
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch(browserLaunchOptions());
});

afterAll(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => {});
  await browser?.close();
  server?.stop(true);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Poll until `check` is true, so assertions wait on the real stored outcome. */
async function until(check: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function openNode(blind = false) {
  // A fresh context per test: the app keeps per-session review state, so a
  // reused profile lets one test's selection leak into the next.
  const context = await browser.newContext({ viewport: { width: 1260, height: 900 } });
  const page = await context.newPage();
  contexts.push(context);
  await page.goto(`${server.url.toString()}${blind ? "?blind=1" : ""}`);
  await page.getByRole("button", { name: /Sample site/ }).click();
  await page.locator(`#node-layer [data-node-id="${nodeId}"]`).waitFor({ timeout: 15_000 });
  const section = page.locator("#suggestion-comparison-section");
  // The screenshot's onload drives the node layer, so selection can land before
  // the layer is ready. Retry until the comparison panel is actually up.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await section.evaluate((element) => (element as HTMLElement).hidden)) === false) return page;
    const alreadySelected = await page
      .locator(`#node-layer [data-node-id="${nodeId}"].selected`)
      .count();
    if (!alreadySelected) {
      // Node regions are non-interactive overlays; selection is a click on the
      // stage, hit-tested against the capture rect (y 400-700 of 800).
      const stage = await page.locator("#screenshot-stage").boundingBox();
      if (stage) await page.mouse.click(stage.x + stage.width * 0.5, stage.y + stage.height * 0.68);
    }
    await page.waitForTimeout(250);
  }
  throw new Error("comparison panel never appeared");
  return page;
}

test("shows both annotators side by side and highlights the axes they differ on", async () => {
  const page = await openNode();
  try {
    const cards = page.locator("#suggestion-comparison-list .comparison-card");
    expect(await cards.count()).toBe(2);
    expect((await page.locator(".comparison-name").allTextContents()).sort()).toEqual([
      "Jev",
      "luna",
    ]);
    // componentType and regions differ, purpose does not.
    expect(await page.locator("#suggestion-comparison-list .comparison-axis.differs").count()).toBe(4);
    // The single-suggestion panel stays out of the way for a disagreement.
    expect(await page.locator("#model-suggestion-section").isHidden()).toBe(true);
    // layout_container vs content_section gets its boundary rule inline.
    expect(await page.locator("#comparison-guidance").textContent()).toContain(
      "one subject of its own",
    );
  } finally {
    await page.close();
  }
}, 30_000);

test("key 1 accepts the first option, records which suggestion won, and undo reverses it", async () => {
  const page = await openNode();
  try {
    const first = page.locator("#suggestion-comparison-list .comparison-card").first();
    const acceptedId = await first.getAttribute("data-suggestion-id");
    await page.keyboard.press("1");
    await until(() => store.annotationsForPage(pageId).length === 1, "the accept to save");
    const annotations = store.annotationsForPage(pageId);
    expect(annotations[0]?.modelSuggestionId).toBe(acceptedId!);
    expect(annotations[0]?.modelReview).toBe("accept");
    expect(annotations[0]?.cohortId).toBe("review-v1");

    // Same code path the Cmd+Z shortcut calls.
    await page.locator("#undo-last-review").click();
    await until(() => store.annotationsForPage(pageId).length === 0, "undo to reverse the accept");
  } finally {
    await page.close();
  }
}, 30_000);

test("key 2 accepts the second option", async () => {
  const page = await openNode();
  try {
    const second = page.locator("#suggestion-comparison-list .comparison-card").nth(1);
    const acceptedId = await second.getAttribute("data-suggestion-id");
    await page.keyboard.press("2");
    await until(() => store.annotationsForPage(pageId).length === 1, "the accept to save");
    expect(store.annotationsForPage(pageId).at(-1)?.modelSuggestionId).toBe(acceptedId!);

    // Same code path the Cmd+Z shortcut calls.
    await page.locator("#undo-last-review").click();
    await until(() => store.annotationsForPage(pageId).length === 0, "undo to reverse the accept");
  } finally {
    await page.close();
  }
}, 30_000);

test("X rejects both options without manufacturing a human label, and undo reverses it", async () => {
  const page = await openNode();
  try {
    await page.keyboard.press("x");
    await until(() => store.modelReviewsForPage(pageId).length === 2, "both rejections to save");
    // Rejecting both records feedback without manufacturing a human label.
    expect(store.annotationsForPage(pageId)).toHaveLength(0);
    expect(store.modelReviewsForPage(pageId).map((row) => row.modelSuggestionId).sort()).toEqual(
      [jevId, lunaId].sort(),
    );
    expect(store.stats().byCohort["review-v1"]?.bySource).toEqual({
      jev: { accepted: 0, rejected: 1 },
      luna: { accepted: 0, rejected: 1 },
    });

    // Undo reverses one rejection at a time, newest first.
    await page.locator("#undo-last-review").click();
    await until(() => store.modelReviewsForPage(pageId).length === 1, "undo to reverse a rejection");
  } finally {
    await page.close();
  }
}, 30_000);

test("blind mode hides annotator names and orders the columns deterministically", async () => {
  const first = await openNode(true);
  try {
    expect(await first.locator(".comparison-name").allTextContents()).toEqual([
      "Option 1",
      "Option 2",
    ]);
    const order = await first
      .locator("#suggestion-comparison-list .comparison-card")
      .evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.suggestionId));
    expect(order).not.toContain(undefined);
    await first.close();

    // The same item shows the same order on a second visit.
    const again = await openNode(true);
    const repeat = await again
      .locator("#suggestion-comparison-list .comparison-card")
      .evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.suggestionId));
    await again.close();
    expect(repeat).toEqual(order);
  } finally {
    await first.close().catch(() => {});
  }
}, 30_000);
