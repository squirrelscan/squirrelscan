// #2306: `--render-cdp` / `[render] cdp_url` pick the local-Chrome fetcher, never the cloud one, and
// the flag combinations that make no sense are refused.

import { ConfigSchema, getDefaultConfig } from "@squirrelscan/config";
import { CDP_RENDER_FETCHER_ID } from "@squirrelscan/fetchers";
import { describe, expect, test } from "bun:test";

import {
  buildReportRender,
  isRenderedFetcher,
  renderFallbackLine,
  renderModeOf,
} from "../../src/audit/render-summary";
import {
  invalidCdpEndpoint,
  validateAuditFlags,
} from "../../src/cli/commands/audit";
import {
  closeDocumentFetcher,
  resolveDocumentFetcher,
  type RunAuditOptions,
} from "../../src/controllers/audit";

const opts = (o: Partial<RunAuditOptions>): RunAuditOptions =>
  o as RunAuditOptions;
const ENDPOINT = "ws://127.0.0.1:9/devtools/browser/x";

describe("resolveDocumentFetcher with a Chrome endpoint", () => {
  test("renderStrategy all renders every page in the browser", () => {
    const f = resolveDocumentFetcher(
      opts({ renderCdpUrl: ENDPOINT, renderStrategy: "all" }),
      getDefaultConfig()
    );
    expect(f?.id).toBe(CDP_RENDER_FETCHER_ID);
  });

  test("renderStrategy auto is the HTTP-first hybrid, so only client-rendered shells reach the browser", () => {
    const f = resolveDocumentFetcher(
      opts({ renderCdpUrl: ENDPOINT, renderStrategy: "auto" }),
      getDefaultConfig()
    );
    expect(f?.id).toBe("hybrid-http-first");
  });

  test("no strategy follows the level: quick is auto, the rest all", () => {
    const quick = resolveDocumentFetcher(
      opts({ renderCdpUrl: ENDPOINT }),
      getDefaultConfig(),
      undefined,
      true
    );
    const full = resolveDocumentFetcher(
      opts({ renderCdpUrl: ENDPOINT }),
      getDefaultConfig(),
      undefined,
      false
    );
    expect(quick?.id).toBe("hybrid-http-first");
    expect(full?.id).toBe(CDP_RENDER_FETCHER_ID);
  });

  test("never builds the cloud fetcher, signed out or with [cloud] rendering = browser", () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.rendering = "browser";
    const f = resolveDocumentFetcher(
      opts({ renderCdpUrl: ENDPOINT, cloudAvailable: false }),
      config
    );
    expect(f?.id).not.toBe("cloud-render");
    expect(f).toBeDefined();
  });

  test("an unreachable endpoint reports why through the fallback hook and serves the page over HTTP", async () => {
    const reasons: string[] = [];
    const f = resolveDocumentFetcher(
      opts({
        renderCdpUrl: "ws://127.0.0.1:1/devtools/browser/none",
        renderStrategy: "all",
      }),
      getDefaultConfig(),
      undefined,
      false,
      { onFallbackReason: (r) => reasons.push(r) }
    );
    // A loopback address nothing listens on: the plain fetch fails too, which is fine here.
    await f
      ?.fetch({ url: "http://127.0.0.1:1/", timeoutMs: 500 })
      .catch(() => {});
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("Chrome endpoint unreachable");
    await closeDocumentFetcher(f);
  });

  test("closeDocumentFetcher is a no-op for a fetcher with nothing to close", async () => {
    await closeDocumentFetcher(undefined);
    await closeDocumentFetcher(
      resolveDocumentFetcher(opts({}), getDefaultConfig())
    );
  });
});

describe("validateAuditFlags with --render-cdp", () => {
  test("alone is valid", () => {
    expect(validateAuditFlags({ renderCdp: ENDPOINT })).toBeNull();
    expect(
      validateAuditFlags({
        renderCdp: ENDPOINT,
        renderMode: "all",
        offline: true,
      })
    ).toBeNull();
  });

  test("with --http is refused with a clear error", () => {
    expect(validateAuditFlags({ renderCdp: ENDPOINT, http: true })).toBe(
      "--render-cdp and --http cannot be combined"
    );
  });

  test("with the cloud --render or --render-mode off is refused", () => {
    expect(validateAuditFlags({ renderCdp: ENDPOINT, render: true })).toContain(
      "--render-cdp and --render cannot be combined"
    );
    expect(
      validateAuditFlags({ renderCdp: ENDPOINT, renderMode: "off" })
    ).toContain("--render-mode off");
  });

  test("an endpoint that is not a ws or http URL is refused", () => {
    expect(validateAuditFlags({ renderCdp: "localhost:9222" })).toContain(
      "--render-cdp"
    );
    expect(validateAuditFlags({ renderCdp: "file:///tmp/x" })).toContain(
      "must start with"
    );
    expect(invalidCdpEndpoint("http://127.0.0.1:9222")).toBeNull();
    expect(
      invalidCdpEndpoint("wss://browser.example.com/devtools/browser/1")
    ).toBeNull();
  });
});

describe("the report names the local browser", () => {
  test("cdp-render counts as a rendered fetcher in mode all", () => {
    expect(isRenderedFetcher(CDP_RENDER_FETCHER_ID)).toBe(true);
    expect(renderModeOf(CDP_RENDER_FETCHER_ID)).toBe("all");
  });

  test("an unreachable endpoint reads as a fallback from local browser rendering, not the cloud", () => {
    const render = buildReportRender({
      requested: true,
      fetcherId: CDP_RENDER_FETCHER_ID,
      fallbackReason: "Chrome endpoint unreachable (connection refused)",
      rendered: 0,
      plain: 3,
    });
    expect(render.fallbackReason).toBe(
      "Chrome endpoint unreachable (connection refused)"
    );
    expect(renderFallbackLine(render)).toStartWith(
      "Local browser rendering fell back"
    );
  });
});

describe("[render] cdp_url config", () => {
  test("parses, and is absent by default", () => {
    expect(ConfigSchema.parse({}).render).toBeUndefined();
    expect(
      ConfigSchema.parse({ render: { cdp_url: "http://127.0.0.1:9222" } })
        .render?.cdp_url
    ).toBe("http://127.0.0.1:9222");
  });

  test("rejects a non ws/http scheme", () => {
    expect(
      ConfigSchema.safeParse({ render: { cdp_url: "ftp://host/x" } }).success
    ).toBe(false);
  });
});
