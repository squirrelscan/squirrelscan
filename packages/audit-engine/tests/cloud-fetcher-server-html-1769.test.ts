// The render service may send the server's own HTML with a render (#1769, private half repo#4022). The mapper
// carries it to the crawler when present and changes nothing when it is absent.

import { describe, expect, test } from "bun:test";

import type { RenderResultItem } from "@squirrelscan/core-contracts";

import { mapRenderItemToResponse } from "../src/cloud-fetcher";

const TIMING = { startedAt: 0, responseAt: 1, finishedAt: 2 };
const URL_ = "https://example.com/";

const item = (extra: Partial<RenderResultItem> = {}): RenderResultItem & { html: string } => ({
  url: URL_,
  status: 200,
  html: "<html><body>rendered</body></html>",
  ...extra,
});

describe("mapRenderItemToResponse server HTML (#1769)", () => {
  test("with serverHtml the response carries it for the crawler to merge", () => {
    const server = '<html><body><script src="/s.js"></script></body></html>';
    const response = mapRenderItemToResponse(item({ serverHtml: server }), URL_, TIMING);
    expect(response.serverHtml).toBe(server);
    expect(response.body).toBe("<html><body>rendered</body></html>");
  });

  test("without it the response is exactly what it was: no serverHtml key at all", () => {
    const response = mapRenderItemToResponse(item(), URL_, TIMING);
    expect("serverHtml" in response).toBe(false);
    expect(response.body).toBe("<html><body>rendered</body></html>");
    expect(response.fetcherMethod).toBe("cloud-render");
    // An empty string is treated as absent too.
    expect("serverHtml" in mapRenderItemToResponse(item({ serverHtml: "" }), URL_, TIMING)).toBe(false);
  });
});
