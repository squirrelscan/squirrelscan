// pub#776: security/csp-blocks-own-resources counted a host as a dependency
// when its URL only appeared as a string inside a same-origin JS chunk. SDKs
// ship fallback URLs that load only behind a feature flag (`@openpanel/web`'s
// replay module), so the page never requested them and the CSP blocked
// nothing. A chunk-only host is now an informational note; a host the page
// loads from its HTML is still a warning.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { cspBlocksOwnResourcesRule } from "../src/security/csp-blocks-own-resources";
import type { RuleContext } from "../src/types";

const PAGE = "http://127.0.0.1:18923/";

function checks(head: string, chunk?: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CSP repro page for squirrel</title>${head}</head><body><h1>Repro</h1></body></html>`;
  const scripts = chunk
    ? [
        {
          url: `${PAGE}app.js`,
          status: 200,
          error: null,
          contentType: "text/javascript",
          sizeBytes: chunk.length,
          content: chunk,
          sourcePages: [PAGE],
        },
      ]
    : [];
  const ctx = {
    page: { url: PAGE, html, statusCode: 200, loadTime: 0, headers: { "content-security-policy": "default-src 'self'; script-src 'self'" } },
    parsed: parsePage(html, PAGE),
    site: { baseUrl: PAGE, pages: [], scripts, preloadedScripts: [] },
    options: {},
  } as unknown as RuleContext;
  return cspBlocksOwnResourcesRule.run(ctx).checks;
}

const REPRO_CHUNK = `function loadReplay(){ if (window.__replay) return import("https://openpanel.dev/op1-replay.js"); }`;

describe("security/csp-blocks-own-resources — hosts named only inside a chunk (pub#776)", () => {
  test("the issue's repro gives no warning, only an informational note", () => {
    const result = checks(`<script src="/app.js" defer></script>`, REPRO_CHUNK);
    expect(result.map((c) => c.status)).toEqual(["pass", "info"]);
    const note = result[1]!;
    expect(note.name).toBe("csp-chunk-only-hosts");
    expect(note.message).toBe(
      "1 host the page's CSP would block appears only as a URL inside the page's scripts, which may never load it (script-src: openpanel.dev)",
    );
    expect(note.items?.[0]).toMatchObject({
      id: "script-src openpanel.dev",
      snippet: "https://openpanel.dev/op1-replay.js",
      meta: { directive: "script-src", host: "openpanel.dev", found: "chunk" },
    });
  });

  test("a host the HTML loads and the CSP blocks is still a warning, and is not repeated in the note", () => {
    const result = checks(
      `<script src="/app.js" defer></script><script src="https://openpanel.dev/op1.js"></script>`,
      REPRO_CHUNK,
    );
    expect(result.map((c) => c.status)).toEqual(["warn"]);
    expect(result[0]!.items?.map((i) => i.meta?.found)).toEqual(["html"]);
  });

  test("other HTML attributes the CSP blocks still warn", () => {
    for (const head of [
      `<link rel="stylesheet" href="https://cdn.other.test/a.css">`,
      `<script src="https://cdn.other.test/a.js"></script>`,
    ]) {
      expect(checks(head)[0]!.status).toBe("warn");
    }
  });
});
