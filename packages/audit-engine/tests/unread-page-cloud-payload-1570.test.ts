// #1570: an unread page is not sent to the cloud (it would be scored as an empty document, and cost credits).

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
import type { PageRecord } from "@squirrelscan/core-contracts";

import { buildCloudPagePayloads } from "../src/cloud-prefetch-run";
import { ORIGIN, mkPage } from "./helpers/template-corpus";

const HTML = `<!doctype html><html lang="en"><head><title>A page</title></head><body><main><h1>A page</h1><p>${"word ".repeat(100)}</p></main></body></html>`;

describe("cloud page payloads (#1570)", () => {
  test("a read page is sent, an unread page is not", () => {
    const read = { page: mkPage(`${ORIGIN}/a`, HTML) as PageRecord, parsed: parsePage(HTML, `${ORIGIN}/a`) };
    const unread = {
      page: mkPage(`${ORIGIN}/b`, HTML) as PageRecord,
      parsed: { ...parsePage(HTML, `${ORIGIN}/b`), parseNotices: ["the page could not be read (boom), so it was audited empty"] },
    };
    const urls = buildCloudPagePayloads([read, unread] as never).map((p) => p.url);
    expect(urls).toEqual([`${ORIGIN}/a`]);
  });
});
