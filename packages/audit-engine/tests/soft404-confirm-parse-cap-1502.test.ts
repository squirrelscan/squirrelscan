// #1502: the soft-404 confirmation re-fetch parses the body it gets back. Under the `--max-duration` parse cap (#1332)
// a body over the cap is not parsed: the candidate is `unconfirmed` (annotated, never dropped). Over an injected fetch.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { MAX_DURATION_MAX_PAGE_BYTES } from "@squirrelscan/utils/constants";

import { DEFAULT_MAX_BODY_BYTES } from "../src/lib/capped-body-read";
import { confirmSoft404Candidates, type ConfirmFetch, type Soft404ConfirmPage } from "../src/soft404-confirm";

const SHELL = `<!doctype html>
<html id="__next_error__">
  <head><meta name="robots" content="noindex" /><title>Page Not Found | Example</title></head>
  <body><main><h1>Page Not Found</h1><p>The page does not exist.</p></main></body>
</html>`;
/** The same error shell, padded past any small cap by a comment. */
const padded = (extra: number): string => SHELL.replace("</body>", `<!--${"x".repeat(extra)}--></body>`);

const page = (): Soft404ConfirmPage => {
  const url = "https://example.com/gone";
  return { url, statusCode: 200, parsed: parsePage(SHELL, url) };
};

const bodyFetch = (body: string): ConfirmFetch => async () => ({ status: 200, body });

async function verdict(body: string, maxParseBytes?: number) {
  const pages = [page()];
  await confirmSoft404Candidates(pages, { userAgent: "t", ...(maxParseBytes !== undefined ? { maxParseBytes } : {}) }, bodyFetch(body));
  return pages[0]!.parsed.soft404Confirmation;
}

describe("the soft-404 confirmation honours the parse cap (#1502)", () => {
  test("a re-fetched body over the cap is unconfirmed, not parsed; without the cap the same body confirms", async () => {
    const body = padded(5_000);
    expect(await verdict(body)).toBe("confirmed");
    expect(await verdict(body, 1_000)).toBe("unconfirmed");
  });

  test("boundary: a body of exactly the cap is parsed, one byte over is not", async () => {
    const body = padded(500);
    const size = Buffer.byteLength(body);
    expect(await verdict(body, size)).toBe("confirmed");
    expect(await verdict(body, size - 1)).toBe("unconfirmed");
  });

  test("the size is the decoded text's bytes: multi-byte text counts by bytes, not characters", async () => {
    const body = SHELL.replace("</body>", `<!--${"中".repeat(400)}--></body>`);
    expect(body.length).toBeLessThan(Buffer.byteLength(body));
    expect(await verdict(body, body.length + 100)).toBe("unconfirmed"); // over the cap in bytes, under it in characters
  });

  test("the cap does not touch a body under it, a non-2xx, or a disabled pass", async () => {
    expect(await verdict(SHELL, 1_000_000)).toBe("confirmed");
    const pages = [page()];
    await confirmSoft404Candidates(pages, { userAgent: "t", maxParseBytes: 10 }, async () => ({ status: 500, body: "" }));
    expect(pages[0]!.parsed.soft404Confirmation).toBe("unconfirmed");
  });
});

describe("the streaming audit hands the cap to the confirmation pass (source guard)", () => {
  test("adapter.ts threads maxPageBytes into confirmSoft404Candidates", async () => {
    const source = await Bun.file(new URL("../src/adapter.ts", import.meta.url)).text();
    // the cap enters the site-fetch phase with the other probe options, and the confirmation call reads it from there
    expect(source).toContain("maxParseBytes: opts?.maxPageBytes }");
    expect(source).toContain("maxParseBytes: probes?.maxParseBytes,");
  });
});

describe("why the guard is defense in depth (#1502)", () => {
  test("the production re-fetch is cut at a body size under the `--max-duration` parse cap, so it cannot return an oversize body there", () => {
    // `defaultConfirmFetch` reads with `readBodyCapped(res, DEFAULT_MAX_BODY_BYTES)`; a body cut at that size is under the cap
    // `--max-duration` sets, so the guard only acts for a smaller cap or a caller that injects its own fetch.
    expect(DEFAULT_MAX_BODY_BYTES).toBeLessThan(MAX_DURATION_MAX_PAGE_BYTES);
  });
});
