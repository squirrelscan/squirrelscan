// #253: the container's cloud-prefetch payloads must not hold the pages they
// were read off.
//
// `buildCloudPagePayloads` keeps a 6 KB text excerpt PER PAGE, plus a title, a
// description and up to twenty headings. Every one of those is a slice of the
// page's html, and in JSC a slice pins the buffer it was cut from, so the
// payload list holds the whole crawl as UTF-16 for as long as the prefetch
// runs. That is the page-count-scaled term the streamed pre-rules walk exists
// to remove, and the walk drops each batch right after the collector absorbs
// it, so nothing else is keeping those pages alive.
//
// `truncateUtf8Bytes` is not a detach. It returns `text.slice(0, maxBytes)`
// unchanged whenever the sliced text already fits the byte budget, which is
// every all-ASCII page, so the excerpt comes back still attached.
//
// The measurement reads `external` and subtracts a retain-nothing control, and
// fails loudly when it did not reproduce the retention — see helpers/retention.ts.

import type { PageRecord } from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { buildSiteContext } from "../src/adapter";
import { buildCloudPagePayloads, truncateUtf8Bytes } from "../src/cloud-prefetch-run";
import { compareRetention, expectDetached, MB } from "./helpers/retention";

const MAX_EXCERPT_BYTES = 6_000;
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_HEADING_CHARS = 200;

/**
 * A page whose visible text is unique per index, so the excerpt is a real slice
 * of a real buffer. Built from distinct chunks rather than `.repeat()`: JSC
 * ropes share backing storage, so a repeated corpus is nearly free to hold and
 * the attached arm would look detached.
 */
function heavyPage(i: number, bytes: number): PageRecord {
  const chunk = 20_000;
  const body = Array.from({ length: Math.max(1, Math.ceil(bytes / chunk)) }, (_, k) =>
    `${i}-${k} `.padEnd(chunk, "abcdefghij "),
  ).join(" ");
  const html =
    `<!doctype html><html><head><title>Title ${i} of the page</title>` +
    `<meta name="description" content="Description ${i} for this page"></head>` +
    `<body><h1>Heading ${i}</h1><p>${body}</p></body></html>`;
  const url = `https://example.com/p/${i}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 1,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `h${i}`,
    html,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    },
  } as PageRecord;
}

const contextFor = (page: PageRecord) => Effect.runSync(buildSiteContext([page]));

/** The payload builder's body WITHOUT the detach — what the bug looked like. */
function attachedPayload(i: number, bytes: number) {
  const ctx = contextFor(heavyPage(i, bytes));
  const entry = ctx[0]!;
  const parsed = entry.parsed!;
  const meta: Record<string, string> = {};
  if (parsed.meta.description)
    meta.description = parsed.meta.description.slice(0, MAX_DESCRIPTION_CHARS);
  return {
    url: entry.page.url,
    title: parsed.meta.title?.slice(0, MAX_TITLE_CHARS) ?? undefined,
    textExcerpt: truncateUtf8Bytes(parsed.content.textContent, MAX_EXCERPT_BYTES),
    meta: Object.keys(meta).length > 0 ? meta : undefined,
    headings: parsed.headings.headings.slice(0, 20).map((h) => h.text.slice(0, MAX_HEADING_CHARS)),
  };
}

describe("cloud-prefetch page payloads (#253)", () => {
  test("a payload does not retain the page it was built from", () => {
    const N = 24;
    const SOURCE_BYTES = 4_000_000;

    const result = compareRetention({
      iterations: N,
      // Same parse, same extraction, same slices taken — keeps only a length,
      // so the parser's own cost is present in all three arms and subtracts out.
      control: (i) => attachedPayload(i, SOURCE_BYTES).textExcerpt.length,
      attached: (i) => attachedPayload(i, SOURCE_BYTES),
      detached: (i) => buildCloudPagePayloads(contextFor(heavyPage(i, SOURCE_BYTES)))[0],
    });

    expectDetached(result, {
      marginBytes: 40 * MB,
      ratio: 4,
      label: `${N} cloud page payloads from ${(SOURCE_BYTES / MB).toFixed(0)} MB pages`,
    });
  }, 300_000);

  test("the payload's values are unchanged by the detach", () => {
    const page = heavyPage(7, 40_000);
    const [detached] = buildCloudPagePayloads(contextFor(page));
    const attached = attachedPayload(7, 40_000);

    // Same fields, same values — this fix is a memory property, not a payload
    // change, and the request body the container sends must be byte-for-byte
    // what it sent before.
    expect(detached).toEqual(attached);
    expect(detached?.title).toBe("Title 7 of the page");
    expect(detached?.meta?.description).toBe("Description 7 for this page");
    expect(detached?.headings).toEqual(["Heading 7"]);
    expect(detached?.textExcerpt.length).toBeGreaterThan(0);
  });

  test("truncateUtf8Bytes returns an ASCII slice unchanged, so it detaches nothing", () => {
    // The reason the excerpt was attached in the first place: the byte-budget
    // path only round-trips through TextEncoder when the slice OVERFLOWS the
    // budget. Documented as a test so a future reader does not mistake it for
    // a detach.
    const source = "a".repeat(10_000);
    expect(truncateUtf8Bytes(source, MAX_EXCERPT_BYTES)).toBe(source.slice(0, MAX_EXCERPT_BYTES));
  });
});
