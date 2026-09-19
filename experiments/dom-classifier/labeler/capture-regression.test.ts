import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.ts";
import { capturePixels, pngDimensions } from "./capture.ts";
import { browserRuntimeUnavailableReason } from "./browser-runtime.ts";

// CI has no Playwright on purpose, so this suite reports as skipped with the
// reason rather than throwing from beforeAll. It still runs where it is installed.
const browserSkipReason = browserRuntimeUnavailableReason();
describe.skipIf(browserSkipReason !== null)(
  `capture regression (needs a browser)${browserSkipReason ? `: skipped, ${browserSkipReason}` : ""}`,
  () => {

  let browser: any;

  function tallDocument(height: number) {
    return `<!doctype html>
    <html><head><style>
      html, body { margin: 0; padding: 0; }
      body { min-height: ${height}px; background: linear-gradient(#f4f7fb, #d8e3f2); }
      main { height: ${height}px; width: 1440px; }
    </style></head><body><main aria-label="Synthetic tall fixture"></main></body></html>`;
  }

  async function renderAndCapture(documentHeight: number, maxHeight: number) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    try {
      await page.setContent(tallDocument(documentHeight), { waitUntil: "load" });
      const measuredHeight = await page.evaluate(() =>
        Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      );
      expect(measuredHeight).toBe(documentHeight);
      expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual({
        x: 0,
        y: 0,
      });

      const screenshot = await capturePixels(page, measuredHeight, maxHeight);
      return {
        screenshot,
        dimensions: pngDimensions(screenshot),
        viewport: await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        })),
        scroll: await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })),
      };
    } finally {
      await page.close();
    }
  }

  beforeAll(async () => {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch(browserLaunchOptions());
  });

  afterAll(async () => {
    await browser?.close();
  });

  describe("bounded full-page capture regression", () => {
    test(
      "captures a 3,600px document beyond the 900px viewport",
      async () => {
        const result = await renderAndCapture(3_600, 12_000);
        expect(result.dimensions).toEqual({ width: 1440, height: 3_600 });
        expect(result.viewport).toEqual({ width: 1440, height: 900 });
        expect(result.scroll).toEqual({ x: 0, y: 0 });
        expect(result.screenshot.byteLength).toBeGreaterThan(1_000);
      },
      { timeout: 30_000 },
    );

    test(
      "caps a 20,000px document at 12,000px",
      async () => {
        const result = await renderAndCapture(20_000, 12_000);
        expect(result.dimensions).toEqual({ width: 1440, height: 12_000 });
        expect(result.viewport).toEqual({ width: 1440, height: 900 });
        expect(result.scroll).toEqual({ x: 0, y: 0 });
        expect(result.screenshot.byteLength).toBeGreaterThan(1_000);
      },
      { timeout: 30_000 },
    );
  });
  },
);
