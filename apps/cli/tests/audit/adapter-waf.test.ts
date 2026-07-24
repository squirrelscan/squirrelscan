import { describe, expect, test } from "bun:test";

import type { PageRecord } from "../../src/crawler/storage/types";

import { detectWafChallengePage } from "../../src/utils/waf";

function createPage(
  html: string,
  options?: {
    status?: number;
    server?: string | null;
    cfCacheStatus?: string | null;
  }
): Pick<PageRecord, "status" | "headers" | "html"> {
  return {
    status: options?.status ?? 200,
    html,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: options?.server ?? null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: options?.cfCacheStatus ?? null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
  };
}

describe("detectWafChallengePage", () => {
  test("detects challenge interstitial content with supporting status/header", () => {
    const html = `
      <html>
        <head><title>Just a moment...</title></head>
        <body>
          <div>Checking your browser before accessing the site.</div>
          <div id="cf-browser-verification">Please wait...</div>
        </body>
      </html>
    `;

    const result = detectWafChallengePage(
      createPage(html, { status: 403, server: "cloudflare" })
    );
    expect(result.detected).toBe(true);
    expect(result.provider).toBe("Cloudflare");
  });

  test("does not flag normal content pages", () => {
    const html = `
      <html>
        <head><title>Home</title></head>
        <body><h1>Welcome</h1><p>Regular content page.</p></body>
      </html>
    `;

    const result = detectWafChallengePage(createPage(html));
    expect(result.detected).toBe(false);
    expect(result.provider).toBeNull();
  });

  test("does not flag provider mentions without interstitial challenge markers", () => {
    const html = `
      <html>
        <head><title>Blog</title></head>
        <body>
          <h1>Security tooling roundup</h1>
          <p>We compare DataDome, Cloudflare, and Imperva in this article.</p>
          <script src="https://cdn.example.com/datadome.js"></script>
        </body>
      </html>
    `;

    const result = detectWafChallengePage(
      createPage(html, { status: 200, server: "nginx" })
    );
    expect(result.detected).toBe(false);
    expect(result.provider).toBeNull();
  });
});

// #513 — DataDome/Kasada serve challenge interstitials with no generic interstitial
// string (DataDome commonly at HTTP 200), so they must be fingerprinted without
// flagging a protected site's normal pages (where the WAF SDK is always present).
describe("detectWafChallengePage — DataDome/Kasada fingerprinted challenges (#513)", () => {
  test("detects a DataDome captcha interstitial served at 200", () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title></title></head>
      <body><h1 style="display:none"></h1>
        <script>var dd={'rt':'c','cid':'AHrlqAAAAAMA','hsh':'B0','t':'fe','s':40817,'host':'geo.captcha-delivery.com','cookie':'datadome=abc'}</script>
        <script src="https://ct.captcha-delivery.com/c.js"></script>
      </body></html>`;

    const result = detectWafChallengePage(createPage(html, { status: 200 }));
    expect(result.detected).toBe(true);
    expect(result.provider).toBe("DataDome");
  });

  test("detects a DataDome interstitial regardless of status code", () => {
    const html = `<!DOCTYPE html><html><head></head><body>
      <script src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></script>
      </body></html>`;

    const result = detectWafChallengePage(createPage(html, { status: 403 }));
    expect(result.detected).toBe(true);
    expect(result.provider).toBe("DataDome");
  });

  test("detects a Kasada KPSDK-only block interstitial (429)", () => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <script>window.KPSDK={};(function(){var s=document.createElement('script');s.src='/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/ips.js';document.head.appendChild(s);})();</script>
      </head><body></body></html>`;

    const result = detectWafChallengePage(createPage(html, { status: 429 }));
    expect(result.detected).toBe(true);
    expect(result.provider).toBe("Kasada");
  });

  test("does not flag a normal DataDome-protected page at 200", () => {
    // tags.js loads on every page of a DataDome site; only the captcha host signals a challenge
    const body = "<p>Real product content. </p>".repeat(60);
    const html = `<!DOCTYPE html><html><head><title>Acme Store</title>
      <script src="https://js.datadome.co/tags.js" async></script></head>
      <body><header><nav>Home Shop About</nav></header><main><h1>Welcome to Acme</h1>${body}</main></body></html>`;

    const result = detectWafChallengePage(createPage(html, { status: 200 }));
    expect(result.detected).toBe(false);
    expect(result.provider).toBeNull();
  });

  test("does not flag a normal Kasada-protected page at 200 (has real content)", () => {
    // window.KPSDK + ips.js load on every Kasada page; a large body means it is not the interstitial
    const body = "<p>Genuine article content about squirrels. </p>".repeat(60);
    const html = `<!DOCTYPE html><html><head><title>Blog</title>
      <script>window.KPSDK={};</script>
      <script src="/assets/ips.js"></script></head>
      <body><main><h1>Field notes</h1>${body}</main></body></html>`;

    const result = detectWafChallengePage(createPage(html, { status: 200 }));
    expect(result.detected).toBe(false);
    expect(result.provider).toBeNull();
  });

  test("does not flag a sparse Kasada-protected SPA shell served at 200", () => {
    // near-empty body + Kasada SDK, but 200 is not a challenge status, so it is real content
    const html = `<!DOCTYPE html><html><head><title>My App</title>
      <link rel="stylesheet" href="/app.css">
      <script>window.KPSDK={};</script>
      <script src="/kasada/ips.js"></script></head>
      <body><div id="root"></div><script src="/app.bundle.js"></script></body></html>`;

    const result = detectWafChallengePage(createPage(html, { status: 200 }));
    expect(result.detected).toBe(false);
    expect(result.provider).toBeNull();
  });

  test("does not flag a real article that names the DataDome captcha host", () => {
    // strong markers still require a tiny interstitial body, so prose can't trip them
    const body =
      "<p>DataDome serves captcha-delivery.com challenges. </p>".repeat(40);
    const html = `<!DOCTYPE html><html><head><title>How WAFs work</title></head>
      <body><main><h1>Inside DataDome</h1>${body}</main></body></html>`;

    const result = detectWafChallengePage(createPage(html, { status: 200 }));
    expect(result.detected).toBe(false);
    expect(result.provider).toBeNull();
  });

  test("does not flag a short article that merely mentions the providers", () => {
    const html = `<!DOCTYPE html><html><head><title>Roundup</title></head>
      <body><h1>Bot defenses</h1><p>We tried Kasada and DataDome this quarter.</p></body></html>`;

    const result = detectWafChallengePage(
      createPage(html, { status: 200, server: "nginx" })
    );
    expect(result.detected).toBe(false);
    expect(result.provider).toBeNull();
  });
});
