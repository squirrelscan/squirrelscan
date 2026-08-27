// summary.missingAltText is judged per APPEARANCE, not per image URL.
//
// alt="" is decorative markup, not a missing attribute (HTML spec, WCAG H67),
// so the same src can be correct on one page and a real defect on another. The
// rule and reconstruct.ts both decide per page; grouping by src in the report
// assembly made a single decorative appearance excuse every bare one.
// squirrelscan/squirrelscan#143

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";

import { generateReportFromStorage } from "../src/adapter";
import {
  buildV2Report,
  emptyRuleExecutionResult,
  type StreamingReportInput,
} from "../src/report-stream";

const EMPTY_STATS = {
  pagesTotal: 0,
  pagesFetched: 0,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

function streamingInput(): StreamingReportInput {
  return { ...emptyRuleExecutionResult(), tallies: new Map() };
}

/** One src, one appearance per entry. `alt: undefined` = no alt attribute. */
type Appearance = { pageUrl: string; alt?: string };

async function summariesFor(images: Record<string, Appearance[]>) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: "https://example.com",
        originalUrl: "https://example.com",
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: EMPTY_STATS,
      });

      for (const [src, appearances] of Object.entries(images)) {
        yield* storage.upsertImage(crawlId, { src });
        for (const appearance of appearances) {
          yield* storage.addImageAppearance(crawlId, {
            src,
            pageUrl: appearance.pageUrl,
            ...(appearance.alt === undefined ? {} : { alt: appearance.alt }),
            isLazyLoaded: false,
            inFigure: false,
          });
        }
      }

      const v1 = yield* generateReportFromStorage(storage, crawlId, emptyRuleExecutionResult());
      const v2 = yield* buildV2Report(storage, crawlId, streamingInput());
      return {
        v1: v1.summary.missingAltText,
        v2: v2.summary.missingAltText,
      };
    }),
  );
}

describe("summary.missingAltText", () => {
  test("reports the bare page of a src that is decorative elsewhere", async () => {
    // The regression: /logo.svg carries alt="" on page A and no alt on page B.
    // Grouping by src let page A's correct markup hide page B's defect.
    const { v1, v2 } = await summariesFor({
      "https://example.com/logo.svg": [
        { pageUrl: "https://example.com/a", alt: "" },
        { pageUrl: "https://example.com/b" },
      ],
    });

    for (const missing of [v1, v2]) {
      expect(missing).toEqual([
        { page: "https://example.com/b", image: "https://example.com/logo.svg" },
      ]);
    }
  });

  test("a src that is decorative everywhere is never reported", async () => {
    const { v1, v2 } = await summariesFor({
      "https://example.com/divider.svg": [
        { pageUrl: "https://example.com/a", alt: "" },
        { pageUrl: "https://example.com/b", alt: "" },
      ],
    });

    expect(v1).toEqual([]);
    expect(v2).toEqual([]);
  });

  test("a src with no alt attribute anywhere is reported on every page", async () => {
    const { v1, v2 } = await summariesFor({
      "https://example.com/photo.jpg": [
        { pageUrl: "https://example.com/a" },
        { pageUrl: "https://example.com/b" },
      ],
    });

    for (const missing of [v1, v2]) {
      expect(missing).toEqual([
        { page: "https://example.com/a", image: "https://example.com/photo.jpg" },
        { page: "https://example.com/b", image: "https://example.com/photo.jpg" },
      ]);
    }
  });

  test("a described src is never reported", async () => {
    const { v1, v2 } = await summariesFor({
      "https://example.com/barn.jpg": [{ pageUrl: "https://example.com/a", alt: "A red barn" }],
    });

    expect(v1).toEqual([]);
    expect(v2).toEqual([]);
  });
});
