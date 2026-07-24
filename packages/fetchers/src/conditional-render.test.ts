// Conditional-GET gate in front of a render fetcher (#821, #839): a 304 probe or
// a matching normalized-source hash reuses the stored render, everything else
// renders (without the conditional headers).

import { createHash } from "crypto";

import { describe, expect, test } from "bun:test";

import { normalizeHtmlForFingerprint } from "@squirrelscan/utils/fingerprint";

import { createConditionalRenderDocumentFetcher } from "./conditional-render";
import type { DocumentFetcher, FetchRequest, FetchResponse } from "./index";

// Mirror the gate's internal fingerprint so tests can supply a matching stored hash.
function fingerprint(body: string): string {
  return createHash("sha256").update(normalizeHtmlForFingerprint(body)).digest("hex");
}

function resp(over: Partial<FetchResponse> = {}): FetchResponse {
  return {
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    headers: { "content-type": "text/html" },
    body: "<html></html>",
    timing: { startedAt: 0, responseAt: 1, finishedAt: 1 },
    redirectChain: {
      sourceUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      hops: [],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
    ...over,
  };
}

function stub(
  id: string,
  reqs: FetchRequest[],
  impl: (req: FetchRequest) => Promise<FetchResponse>,
): DocumentFetcher {
  return {
    id,
    capabilities: {
      jsRendering: id === "cloud-render",
      cookies: false,
      screenshot: false,
    },
    fetch: (req) => {
      reqs.push(req);
      return impl(req);
    },
  };
}

const COND = { "If-None-Match": '"abc"', "If-Modified-Since": "Wed, 21 Oct 2025 07:28:00 GMT" };

describe("createConditionalRenderDocumentFetcher", () => {
  test("no conditional headers, no stored hash → renders AND bootstraps source_hash via a parallel probe (#990)", async () => {
    const httpReqs: FetchRequest[] = [];
    const renderReqs: FetchRequest[] = [];
    const body = "<html><body>bootstrap</body></html>";
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", httpReqs, async () => resp({ status: 200, body })),
      render: stub("cloud-render", renderReqs, async () =>
        resp({ body: "rendered", fetcherMethod: "cloud-render" }),
      ),
    });

    const r = await fetcher.fetch({ url: "https://example.com/", headers: {} });
    expect(r.body).toBe("rendered"); // still the render result, unmodified except the hash
    expect(renderReqs.length).toBe(1); // rendered exactly once
    expect(httpReqs.length).toBe(1); // probed once, purely to fingerprint
    // The bootstrap hash the crawler persists so the NEXT run's probe can reuse.
    expect(r.sourceHash).toBe(fingerprint(body));
  });

  test("304 probe → reuses probe response, never renders", async () => {
    const httpReqs: FetchRequest[] = [];
    const renderReqs: FetchRequest[] = [];
    const reused: string[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", httpReqs, async () => resp({ status: 304, body: "" })),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
      onReuse: (u) => reused.push(u),
    });

    const r = await fetcher.fetch({ url: "https://example.com/", headers: { ...COND } });
    expect(r.status).toBe(304);
    expect(renderReqs).toEqual([]); // 304 → no render, no credits
    expect(httpReqs.length).toBe(1);
    expect(reused).toEqual(["https://example.com/"]);
  });

  test("200 HTML probe → renders once, WITHOUT the conditional headers", async () => {
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () => resp({ status: 200, body: "changed" })),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({
      url: "https://example.com/",
      headers: { "x-keep": "1", ...COND },
    });
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
    // The render must not carry the conditional headers (else it 304s itself),
    // but non-conditional headers pass through untouched.
    expect(renderReqs[0]?.headers).toEqual({ "x-keep": "1" });
  });

  test("probe throws → still renders (probe never makes things worse)", async () => {
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () => {
        throw new Error("probe network error");
      }),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({ url: "https://example.com/", headers: { ...COND } });
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
    expect(renderReqs[0]?.headers).toEqual({}); // conditional headers stripped
  });

  test("healthy non-HTML probe → returns probe, never renders", async () => {
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () =>
        resp({ status: 200, body: "{}", headers: { "content-type": "application/json" } }),
      ),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({ url: "https://example.com/api", headers: { ...COND } });
    expect(r.body).toBe("{}"); // rendering non-HTML is pointless
    expect(renderReqs).toEqual([]);
  });

  test("uppercase Content-Type: Text/HTML probe → still renders (case-insensitive)", async () => {
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () =>
        resp({ status: 200, body: "changed", headers: { "content-type": "Text/HTML" } }),
      ),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({ url: "https://example.com/", headers: { ...COND } });
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
  });

  test("missing content-type probe → renders (bias to render when unsure)", async () => {
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () => resp({ status: 200, body: "changed", headers: {} })),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({ url: "https://example.com/", headers: { ...COND } });
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
  });

  test("error/block status (403 WAF) → renders (plain fetch may be walled)", async () => {
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () =>
        resp({ status: 403, body: "blocked", headers: { "content-type": "text/html" } }),
      ),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({ url: "https://example.com/", headers: { ...COND } });
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
  });

  test("probe throws while aborted → propagates, does not render", async () => {
    const controller = new AbortController();
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () => {
        controller.abort();
        throw new Error("aborted");
      }),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    await expect(
      fetcher.fetch({
        url: "https://example.com/",
        headers: { ...COND },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(renderReqs).toEqual([]); // aborted probe must not start a render
  });

  // ---- v2: normalized-source fingerprint reuse (#839) ----

  // Two fetches of the "same" page differing only in the per-request Cloudflare
  // challenge-platform injection — the scenario that defeated the v1 gate.
  const CF_BASE = "<html><body><h1>Unchanged</h1>";
  function cfPage(rayId: string): string {
    return (
      CF_BASE +
      `<script>window.__CF$cv$params={r:'${rayId}',t:'MTc4MzY1ODY1Mw=='};</script>` +
      "</body></html>"
    );
  }

  test("200 HTML + matching stored source hash → reuses (synth 304), never renders", async () => {
    const renderReqs: FetchRequest[] = [];
    const reused: string[] = [];
    // The stored hash was computed last run from a fetch with a DIFFERENT ray id.
    const storedSourceHash = fingerprint(cfPage("old-ray-id"));
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () => resp({ status: 200, body: cfPage("new-ray-id") })),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
      onReuse: (u) => reused.push(u),
    });

    const r = await fetcher.fetch({
      url: "https://example.com/",
      headers: { ...COND },
      storedSourceHash,
    });
    expect(r.status).toBe(304); // synthesized so the crawler's 304 path reuses the stored render
    expect(renderReqs).toEqual([]); // the whole point: no render, no credits
    expect(reused).toEqual(["https://example.com/"]);
  });

  test("200 HTML + differing stored source hash → renders once, result carries the fresh hash", async () => {
    const renderReqs: FetchRequest[] = [];
    const body = cfPage("new-ray-id");
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () => resp({ status: 200, body })),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({
      url: "https://example.com/",
      headers: { ...COND },
      storedSourceHash: "sha256-of-a-genuinely-different-page",
    });
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
    // The crawler persists this as the page's source_hash for next-run reuse.
    expect(r.sourceHash).toBe(fingerprint(body));
  });

  test("stored source hash present but NO conditional headers → still probes, still reuses on match", async () => {
    const httpReqs: FetchRequest[] = [];
    const renderReqs: FetchRequest[] = [];
    const body = cfPage("ray");
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", httpReqs, async () => resp({ status: 200, body })),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({
      url: "https://example.com/",
      headers: {}, // origin never sent validators, so the crawler built none
      storedSourceHash: fingerprint(body),
    });
    expect(httpReqs.length).toBe(1); // probed on the strength of the stored hash alone
    expect(r.status).toBe(304);
    expect(renderReqs).toEqual([]);
  });

  test("bootstrap probe rejects → render result returned unchanged, no throw, no hash (#990)", async () => {
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () => {
        throw new Error("probe network error");
      }),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({ url: "https://example.com/", headers: {} });
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
    expect(r.sourceHash).toBeUndefined(); // a failed probe must not attach a hash
  });

  test("bootstrap probe hangs → fetch resolves after the render via bounded grace, no hash (#990)", async () => {
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      // A probe that never settles — the bounded grace must not let it stall us.
      http: stub("fetch", [], () => new Promise<FetchResponse>(() => {})),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
      bootstrapProbeGraceMs: 10,
    });

    const r = await fetcher.fetch({ url: "https://example.com/", headers: {} });
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
    expect(r.sourceHash).toBeUndefined(); // hung probe → give up, no hash
  });

  test("bootstrap probe non-2xx → no hash attached (#990)", async () => {
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () =>
        resp({ status: 500, body: "err", headers: { "content-type": "text/html" } }),
      ),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({ url: "https://example.com/", headers: {} });
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
    expect(r.sourceHash).toBeUndefined(); // error body is not a trustworthy fingerprint
  });

  test("bootstrap probe definitely-non-HTML → no hash attached (#990)", async () => {
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () =>
        resp({ status: 200, body: "{}", headers: { "content-type": "application/json" } }),
      ),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({ url: "https://example.com/", headers: {} });
    // Unlike the shouldProbe path we don't return the probe here — we already
    // rendered; a non-HTML probe just yields no hash.
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
    expect(r.sourceHash).toBeUndefined();
  });

  test("bootstrap probe aborts with the render → render's rejection propagates, no hash swallowed (#990)", async () => {
    const controller = new AbortController();
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      // Probe rejects on abort (swallowed); the render is what must reject the call.
      http: stub("fetch", [], async () => {
        throw new Error("probe aborted");
      }),
      render: stub("cloud-render", renderReqs, async () => {
        controller.abort();
        throw new Error("render aborted");
      }),
    });

    await expect(
      fetcher.fetch({ url: "https://example.com/", headers: {}, signal: controller.signal }),
    ).rejects.toThrow("render aborted");
  });

  test("first run with conditional headers but no stored hash → renders once AND attaches a hash to store", async () => {
    const renderReqs: FetchRequest[] = [];
    const body = cfPage("ray");
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () => resp({ status: 200, body })),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({ url: "https://example.com/", headers: { ...COND } });
    expect(renderReqs.length).toBe(1); // can't reuse without a prior hash
    expect(r.sourceHash).toBe(fingerprint(body)); // but store it so the NEXT run reuses
  });

  test("3xx HTML probe with a stored hash → renders, never reuses on a redirect-stub hash", async () => {
    const renderReqs: FetchRequest[] = [];
    // A redirect whose stub body happens to equal the stored hash must NOT be
    // treated as a reuse — only a 2xx body is a trustworthy fingerprint.
    const body = cfPage("ray");
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () =>
        resp({ status: 302, body, headers: { "content-type": "text/html" } }),
      ),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({
      url: "https://example.com/",
      headers: { ...COND },
      storedSourceHash: fingerprint(body), // would "match" if we hashed 3xx bodies
    });
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
    expect(r.sourceHash).toBeUndefined();
  });

  test("error/block status (403) with a stored hash → renders, does NOT attach a block-page hash", async () => {
    const renderReqs: FetchRequest[] = [];
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () =>
        resp({ status: 403, body: "blocked", headers: { "content-type": "text/html" } }),
      ),
      render: stub("cloud-render", renderReqs, async () => resp({ body: "rendered" })),
    });

    const r = await fetcher.fetch({
      url: "https://example.com/",
      headers: { ...COND },
      storedSourceHash: "whatever",
    });
    expect(r.body).toBe("rendered");
    expect(renderReqs.length).toBe(1);
    expect(r.sourceHash).toBeUndefined(); // a WAF body must not poison source_hash
  });

  test("preserves the wrapped render fetcher's id and capabilities", () => {
    const fetcher = createConditionalRenderDocumentFetcher({
      http: stub("fetch", [], async () => resp()),
      render: stub("cloud-render", [], async () => resp()),
    });
    // Downstream concurrency planning keys on the "cloud-render" id.
    expect(fetcher.id).toBe("cloud-render");
    expect(fetcher.capabilities.jsRendering).toBe(true);
  });
});
