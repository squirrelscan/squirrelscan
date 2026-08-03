// The render service reports the LANDING page only, never the redirect
// responses that led to it. Stamping the landing page's status onto the request
// URL produced chains that claimed `200 → 200` (#1510): a first hop that
// returned 200 did not redirect, so nothing downstream can tell an invented
// chain from a real one.

import { describe, expect, test } from "bun:test";

import type { RenderResultItem } from "@squirrelscan/core-contracts";

import { mapRenderItemToResponse } from "../src/cloud-fetcher";

const TIMING = { startedAt: 0, responseAt: 1, finishedAt: 2 };

const map = (item: RenderResultItem, requestUrl: string) =>
  mapRenderItemToResponse(item, requestUrl, TIMING);

describe("mapRenderItemToResponse — redirect hops", () => {
  test("a landing-page-only chain never claims a 200 first hop", () => {
    // Exactly what the API sends for a redirect: one entry, the landing page.
    const response = map(
      {
        url: "https://example.com/o-mnie",
        status: 200,
        html: "<html></html>",
        redirectChain: [{ url: "https://example.com/o-mnie/", status: 200 }],
      },
      "https://example.com/o-mnie",
    );

    const hops = response.redirectChain!.hops;
    expect(hops).toHaveLength(2);
    expect(hops[0]).toEqual({
      url: "https://example.com/o-mnie",
      statusCode: 0,
      type: "http",
    });
    expect(hops[1]!.statusCode).toBe(200);
    // Still a redirect — the URL genuinely changed — just an honest one.
    expect(response.finalUrl).toBe("https://example.com/o-mnie/");
    expect(response.redirectChain!.chainLength).toBe(1);
  });

  test("no non-final hop is ever 2xx", () => {
    const response = map(
      {
        url: "https://example.com/a",
        status: 200,
        redirectChain: [{ url: "https://example.com/b/", status: 200 }],
      },
      "https://example.com/a",
    );

    for (const hop of response.redirectChain!.hops.slice(0, -1)) {
      const is2xx = hop.statusCode >= 200 && hop.statusCode < 300;
      expect(is2xx).toBe(false);
    }
  });

  test("a page that did not redirect keeps its real status on its single hop", () => {
    const response = map(
      { url: "https://example.com/", status: 200, html: "<html></html>" },
      "https://example.com/",
    );

    expect(response.redirectChain!.hops).toEqual([
      { url: "https://example.com/", statusCode: 200, type: "http" },
    ]);
    expect(response.redirectChain!.chainLength).toBe(0);
    expect(response.finalUrl).toBe("https://example.com/");
  });

  test("an error status is still reported on the page's own hop", () => {
    const response = map({ url: "https://example.com/gone", status: 404 }, "https://example.com/gone");

    expect(response.status).toBe(404);
    expect(response.redirectChain!.hops[0]!.statusCode).toBe(404);
    expect(response.redirectChain!.endsInError).toBe(true);
  });

  test("a service that reports the source hop itself is not duplicated", () => {
    // Forward compatibility: if the render service ever reports every hop, the
    // real statuses are used verbatim and no synthetic source hop is prepended.
    const response = map(
      {
        url: "https://example.com/old",
        status: 200,
        redirectChain: [
          { url: "https://example.com/old", status: 301 },
          { url: "https://example.com/new/", status: 200 },
        ],
      },
      "https://example.com/old",
    );

    expect(response.redirectChain!.hops).toEqual([
      { url: "https://example.com/old", statusCode: 301, type: "http" },
      { url: "https://example.com/new/", statusCode: 200, type: "http" },
    ]);
    expect(response.redirectChain!.chainLength).toBe(1);
  });

  test("scheme downgrade/upgrade flags still derive from source vs landing", () => {
    const response = map(
      {
        url: "http://example.com/",
        status: 200,
        redirectChain: [{ url: "https://example.com/", status: 200 }],
      },
      "http://example.com/",
    );

    expect(response.redirectChain!.httpToHttps).toBe(true);
    expect(response.redirectChain!.httpsToHttp).toBe(false);
  });
});
