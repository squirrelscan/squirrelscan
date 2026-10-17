// Body signatures must be what a provider's own infrastructure emits, never a
// page talking about the provider.
//
// #666: Cloudflare's JavaScript Detections loads a script from
// /cdn-cgi/challenge-platform/ on every ordinary page of a site that has it on,
// so a small 200 page through Cloudflare read as a challenge and was dropped
// from scoring. #667: `/imperva/i` attributed any page that mentions Imperva to
// Imperva; the same shape existed for most providers.

import { describe, expect, test } from "bun:test";

import { detectWaf, detectWafChallengePage, detectWafFromContent, isLikelyWafBlock } from "../src";

const CF_HEADERS = { server: "cloudflare", cfCacheStatus: "DYNAMIC" };

/** JavaScript Detections, as Cloudflare injects it before `</body>`. */
const JSD =
  "<script>(function(){function c(){var b=a.contentDocument||a.contentWindow.document;if(b){var d=b.createElement('script');" +
  "d.innerHTML=\"window.__CF$cv$params={r:'8d1f2a3b4c5d6e7f',t:'MTcyODcwMDAwMC4wMDAwMDA='};var a=document.createElement('script');" +
  "a.nonce='';a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);\";" +
  "b.getElementsByTagName('head')[0].appendChild(d)}}if(document.body){var a=document.createElement('iframe');a.height=1;a.width=1;" +
  "document.body.appendChild(a);c()}})();</script>";

const SMALL_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Contact</title></head><body><h1>Contact us</h1><p>Call or write any time.</p>${JSD}</body></html>`;

/** A Cloudflare managed challenge, as served with 403 and `cf-mitigated: challenge`. */
const CF_CHALLENGE =
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta name="robots" content="noindex,nofollow"></head>' +
  '<body class="no-js"><div class="main-wrapper" role="main"><div class="main-content"><noscript><div class="h2"><span id="challenge-error-text">' +
  "Enable JavaScript and cookies to continue</span></div></noscript></div></div><script>(function(){window._cf_chl_opt={cvId: '3',cZone: \"example.com\"," +
  "cType: 'managed',cRay: '8d1f2a3b4c5d6e7f',cUPMDTk: \"\\/?__cf_chl_tk=abc\"};var cpo = document.createElement('script');" +
  "cpo.src = '/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=8d1f2a3b4c5d6e7f';document.getElementsByTagName('head')[0].appendChild(cpo);}());</script></body></html>";

/** Imperva's block page: an iframe onto /_Incapsula_Resource with the incident line. */
const IMPERVA_BLOCK =
  '<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW"></head><body style="margin:0px;height:100%">' +
  '<iframe id="main-iframe" src="/_Incapsula_Resource?CWUDNSAI=24&xinfo=0-0-0&incident_id=1234000280151781213-1234&edet=12" frameborder=0 width="100%" height="100%">' +
  "Request unsuccessful. Incapsula incident ID: 1234000280151781213-1234</iframe></body></html>";

/** A page that talks about every provider, in prose. */
const ROUNDUP = `<!doctype html><html><head><title>WAF roundup</title></head><body>
  <h1>Comparing bot protection</h1>
  <p>We tried Imperva (formerly Incapsula, "powered by Incapsula" on old block pages), Cloudflare, Akamai, Sucuri Website Firewall,
  DataDome, PerimeterX and Kasada. When a Cloudflare error shows up, note the Cloudflare Ray ID and send it to support.
  Akamai says "access denied" with a reference # you can quote: see Reference #3 in our appendix. Just a moment of setup each.</p>
  <script src="/js/add.js"></script><script src="/js/tips.js"></script><script src="/js/abcd.js"></script>
</body></html>`;

function page(html: string, status = 200, headers: { server?: string | null; cfCacheStatus?: string | null } = {}) {
  return { status, html, headers };
}

describe("a Cloudflare page with JavaScript Detections (#666)", () => {
  test("a small 200 page carrying only the JSD script is not a challenge", () => {
    expect(SMALL_PAGE.length).toBeLessThan(10_240);
    expect(detectWafChallengePage(page(SMALL_PAGE, 200, CF_HEADERS))).toEqual({ detected: false, provider: null });
  });

  test("it is still attributed to Cloudflare, which it is on", () => {
    expect(detectWafFromContent(SMALL_PAGE).provider).toBe("cloudflare");
  });

  test("a real challenge is still a challenge, with its provider", () => {
    expect(detectWafChallengePage(page(CF_CHALLENGE, 403, CF_HEADERS))).toEqual({ detected: true, provider: "Cloudflare" });
    expect(detectWafChallengePage(page(CF_CHALLENGE, 503, CF_HEADERS))).toEqual({ detected: true, provider: "Cloudflare" });
  });

  test("challenge markup on a 200 from Cloudflare is still a challenge", () => {
    expect(detectWafChallengePage(page(CF_CHALLENGE, 200, CF_HEADERS))).toEqual({ detected: true, provider: "Cloudflare" });
  });

  test("challenge wording alone needs a challenge status", () => {
    const wording = "<html><head><title>Just a moment...</title></head><body><p>Checking your browser.</p></body></html>";
    expect(detectWafChallengePage(page(wording, 200, CF_HEADERS)).detected).toBe(false);
    expect(detectWafChallengePage(page(wording, 503, CF_HEADERS))).toEqual({ detected: true, provider: "Cloudflare" });
  });
});

describe("a page that mentions a provider (#667)", () => {
  test("is attributed to no provider", () => {
    expect(detectWafFromContent(ROUNDUP)).toMatchObject({ detected: false, provider: null });
    expect(detectWaf(new Headers({ server: "nginx" }), ROUNDUP).detected).toBe(false);
  });

  test("is not a challenge page, even when it says 'just a moment'", () => {
    expect(detectWafChallengePage(page(ROUNDUP, 200, { server: "nginx" })).detected).toBe(false);
  });

  test("a real Imperva block page is still Imperva, and a challenge", () => {
    expect(detectWafFromContent(IMPERVA_BLOCK)).toMatchObject({ detected: true, provider: "imperva" });
    expect(detectWafChallengePage(page(IMPERVA_BLOCK, 200))).toEqual({ detected: true, provider: "Imperva/Incapsula" });
    expect(detectWafChallengePage(page(IMPERVA_BLOCK, 403))).toEqual({ detected: true, provider: "Imperva/Incapsula" });
  });
});

describe("each provider's body signatures are infrastructure, not prose", () => {
  const signatures: Array<[string, string, "markup" | "text"]> = [
    ["cloudflare", '<p>Cloudflare Ray ID: <strong class="font-semibold">8d1f2a3b4c5d6e7f</strong></p>', "text"],
    ["cloudflare", "<h1>Checking your browser before accessing example.com</h1>", "text"],
    ["cloudflare", '<div id="cf-browser-verification"></div>', "markup"],
    ["akamai", "Reference #18.9d367a83.1614887475.2b3c78d", "text"],
    ["akamai", "Reference&#32;&#35;18&#46;9d367a83&#46;1614887475&#46;2b3c78d", "text"],
    ["akamai", "<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;9d367a83</P>", "text"],
    ["sucuri", "<title>Sucuri WebSite Firewall - Access Denied</title>", "text"],
    ["sucuri", "<h2>Access Denied - Sucuri Website Firewall</h2>", "text"],
    ["sucuri", "<title>Sucuri WebSite Firewall &ndash; Access Denied</title>", "text"],
    ["sucuri", "<h2>Access Denied – Sucuri Website Firewall</h2>", "text"],
    ["imperva", "Request unsuccessful. Incapsula incident ID&#58; 1234000280151781213-1234", "text"],
    ["imperva", "Request unsuccessful. Incapsula incident ID: 1234000280151781213-1234", "text"],
    ["imperva", "Request unsuccessful. Incapsula incident ID: <b>1234000280151781213-1234</b>", "text"],
    ["imperva", '<script src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"></script>', "markup"],
    ["datadome", '<script src="https://js.datadome.co/tags.js" async></script>', "markup"],
    ["datadome", '<script src="https://ct.captcha-delivery.com/c.js"></script>', "markup"],
    ["datadome", "<script>window.ddjskey = 'ABC123';</script>", "markup"],
    ["perimeterx", '<div id="px-captcha"></div>', "markup"],
    ["perimeterx", '<script>window._pxAppId = "PX12345";</script>', "markup"],
    ["perimeterx", '<script src="//client.perimeterx.net/PX12345/main.min.js"></script>', "markup"],
    ["perimeterx", "<script>s.src = 'https://client.perimeterx.net/PX12345/main.min.js';</script>", "markup"],
    ["kasada", "<script>window.KPSDK={};</script>", "markup"],
    ["kasada", '<script src="/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/ips.js"></script>', "markup"],
  ];

  test.each(signatures)("%s: %s", (provider, html, _view) => {
    expect(detectWafFromContent(`<html><body>${html}</body></html>`).provider).toBe(provider);
  });

  // #693: the same signatures QUOTED, as a tutorial or support page prints
  // them, are attributed to no provider. In a code block for every one; in
  // plain paragraph text for the script and resource signatures. Block-page
  // wording is text by nature, so a paragraph does not quote it.
  const escape = (html: string) => html.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const quoted = signatures.flatMap(([provider, html, view]) => [
    [provider, `<pre><code>${escape(html)}</code></pre>`],
    [provider, `<p>Paste <code>${html.includes("<") ? escape(html) : html}</code> into the page.</p>`],
    ...(view === "markup" ? [[provider, `<p>Add ${escape(html)} to the head.</p>`]] : []),
  ]);

  test.each(quoted)("%s quoted: %s", (_provider, html) => {
    expect(detectWafFromContent(`<html><body>${html}</body></html>`)).toMatchObject({ detected: false, provider: null });
  });

  const prose = [
    "<p>Imperva and Incapsula are the same company now.</p>",
    "<p>This site is powered by Incapsula.</p>",
    "<p>What is an Incapsula incident ID?</p>",
    "<p>Look for the Cloudflare Ray ID at the bottom of the page.</p>",
    "<p>Checking your browser support for WebGL.</p>",
    "<p>Access denied errors from Akamai are rare.</p>",
    "<p>See reference # 2 and reference #3.1 below.</p>",
    "<p>We moved from Sucuri Website Firewall to Cloudflare.</p>",
    "<p>DataDome blocks scrapers; so do PerimeterX and Kasada.</p>",
    '<script src="/static/add.js"></script><script src="/js/tips.js"></script><script src="/js/abcd.js"></script>',
    '<script src="/vendor/ips.js"></script>',
    "<p>The KPSDK object belongs to Kasada.</p>",
    "<p>Our guide explains Access Denied - Sucuri errors.</p>",
  ];

  test.each(prose)("no provider for: %s", (html) => {
    expect(detectWafFromContent(`<html><body>${html}</body></html>`)).toMatchObject({ detected: false, provider: null });
  });
});

describe("block pages served without the provider's headers", () => {
  const AKAMAI_PLAIN = "<html><body><h1>Access Denied</h1>Reference #18.9d367a83.1614887475.2b3c78d</body></html>";
  const AKAMAI_ENCODED =
    "<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>Reference&#32;&#35;18&#46;9d367a83&#46;1614887475&#46;2b3c78d</BODY></HTML>";

  test("an Akamai deny page at 200 is still a challenge, in either form", () => {
    for (const html of [AKAMAI_PLAIN, AKAMAI_ENCODED]) {
      expect(detectWafChallengePage(page(html, 200))).toEqual({ detected: true, provider: "Akamai" });
    }
  });

  test("a page repeating 'access denied' without a reference is read quickly", () => {
    const html = `<html><body>${"<p>Access denied.</p>".repeat(600)}</body></html>`;
    const started = performance.now();
    expect(detectWafChallengePage(page(html, 200)).detected).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("a page quoting an Akamai reference id is not a challenge", () => {
    const help = "<html><body><h1>Reading Akamai errors</h1><p>Example: Reference #18.9d367a83.1614887475.2b3c78d</p></body></html>";
    expect(detectWafChallengePage(page(help, 200)).detected).toBe(false);
  });

  // External link checks call this on a 403 to tell a bot wall from a forbidden page.
  test.each([
    ["Imperva", IMPERVA_BLOCK],
    ["Akamai", AKAMAI_ENCODED],
    ["Cloudflare", CF_CHALLENGE],
    ["Sucuri", "<html><head><title>Sucuri WebSite Firewall - Access Denied</title></head></html>"],
    ["PerimeterX", '<html><body><div id="px-captcha"></div><script>window._pxAppId="PX12345";</script></body></html>'],
  ])("a headerless 403 from %s is still read as a WAF block", (_provider, html) => {
    expect(isLikelyWafBlock(403, new Headers(), html)).toBe(true);
  });

  test("a headerless 403 that only mentions providers is an ordinary refusal", () => {
    expect(isLikelyWafBlock(403, new Headers(), ROUNDUP)).toBe(false);
  });
});

describe("a signature counts where it acts, not where a page quotes it (#693)", () => {
  test("the issue's pages: a code-block tutorial, a support page, a troubleshooting page", () => {
    const tutorial =
      '<h1>Installing DataDome</h1><pre class="language-html"><code>&lt;script src="https://js.datadome.co/tags.js" async&gt;&lt;/script&gt;</code></pre>';
    const support = "<h1>Blocked?</h1><p>Send us the line that reads <code>Incapsula incident ID: 1234-5678</code>.</p>";
    const troubleshooting =
      "<h1>Cloudflare errors</h1><p>Requests to /cdn-cgi/challenge-platform/ come from Bot Fight Mode; allow __cf_chl_ in your WAF rules.</p>";
    for (const html of [tutorial, support, troubleshooting]) {
      expect(detectWafFromContent(`<html><body>${html}</body></html>`)).toMatchObject({ detected: false, provider: null });
    }
  });

  test.each([
    ["datadome", '<iframe src="https://js.datadome.co/frame.html"></iframe>'],
    ["imperva", '<iframe id="main-iframe" src="/_Incapsula_Resource?CWUDNSAI=24"></iframe>'],
    ["cloudflare", "<script>var s = '/cdn-cgi/challenge-platform/scripts/jsd/main.js';</script>"],
    ["kasada", "<script>KPSDK.configure([]);</script>"],
    ["aws-waf", '<script src="https://abc123.edge.sdk.token.awswaf.com/abc123/challenge.js"></script>'],
  ])("%s in a script or an iframe is still attributed: %s", (provider, html) => {
    expect(detectWafFromContent(`<html><body>${html}</body></html>`).provider).toBe(provider);
  });

  test("a link to a provider's script is a mention", () => {
    const html = '<p>See <a href="https://js.datadome.co/tags.js">the DataDome tag</a>.</p>';
    expect(detectWafFromContent(`<html><body>${html}</body></html>`).detected).toBe(false);
  });

  test("a textarea or a comment is not where a script runs", () => {
    for (const html of [
      '<textarea><script src="https://js.datadome.co/tags.js"></script></textarea>',
      '<!-- <script src="https://js.datadome.co/tags.js"></script> -->',
    ]) {
      expect(detectWafFromContent(`<html><body>${html}</body></html>`).detected).toBe(false);
    }
  });

  test("a page quoting challenge markup is not a challenge, even served by Cloudflare", () => {
    const docs =
      "<html><head><title>Debugging challenges</title></head><body><h1>Debugging challenges</h1>" +
      "<pre><code>window._cf_chl_opt = { cType: 'managed' };\n&lt;div id=\"px-captcha\"&gt;&lt;/div&gt;</code></pre>" +
      "<p>An Akamai page reads <code>Reference&amp;#32;&amp;#35;18&amp;#46;9d367a83</code> in its source.</p></body></html>";
    expect(detectWafChallengePage(page(docs, 200, CF_HEADERS)).detected).toBe(false);
    // The real challenge still is.
    expect(detectWafChallengePage(page(CF_CHALLENGE, 200, CF_HEADERS))).toEqual({ detected: true, provider: "Cloudflare" });
  });

  test("a short page quoting DataDome's captcha host or Kasada's client is not their interstitial", () => {
    for (const html of [
      "<html><body><pre><code>https://ct.captcha-delivery.com/c.js</code></pre></body></html>",
      "<html><body><p>Call <code>KPSDK.configure()</code> first.</p></body></html>",
    ]) {
      expect(detectWafChallengePage(page(html, 200)).detected).toBe(false);
    }
    expect(
      detectWafChallengePage(page('<html><body><script src="https://ct.captcha-delivery.com/c.js"></script></body></html>', 200)),
    ).toEqual({ detected: true, provider: "DataDome" });
  });

  test("offsets survive characters that lowercase to two, and raw-text tags do not self-close", () => {
    expect(detectWafFromContent("<p>İİİ</p><script>window._cf_chl_opt={}</script>").provider).toBe("cloudflare");
    expect(detectWafFromContent("<textarea/><script>window._cf_chl_opt={}</script></textarea>").detected).toBe(false);
    expect(detectWafFromContent("<script/>window._cf_chl_opt={}</script>").provider).toBe("cloudflare");
  });

  test("an unclosed <code> stops hiding wording at its block's end (pub#904)", () => {
    const stray =
      "<html><body><p>Error details: <code>403</p><p>Request unsuccessful. Incapsula incident ID: 1234000280151781213-1234</p></body></html>";
    expect(detectWafFromContent(stray).provider).toBe("imperva");
    // Closed properly, the quoted line stays a quote.
    const quoted =
      "<html><body><pre><code>Request unsuccessful. Incapsula incident ID: 1234000280151781213-1234</code></pre></body></html>";
    expect(detectWafFromContent(quoted).detected).toBe(false);
    // A block nested inside the quote closes itself, not the quote.
    const nested =
      "<html><body><pre><code><div>log</div>Request unsuccessful. Incapsula incident ID: 1234000280151781213-1234</code></pre></body></html>";
    expect(detectWafFromContent(nested).detected).toBe(false);
    // Expressive Code (Starlight) wraps every line of a code block in a block.
    const expressive =
      '<html><body><figure><pre><code><div class="ec-line"><div class="code">Request unsuccessful. Incapsula incident ID: 1234000280151781213-1234</div></div>' +
      '<div class="ec-line"><div class="code">Cloudflare Ray ID: <span>8d1f2a3b4c5d6e7f</span></div></div></code></pre></figure></body></html>';
    expect(detectWafFromContent(expressive)).toMatchObject({ detected: false, provider: null });
    // The same for an unclosed <kbd> in a list item.
    const kbd = "<html><body><li><kbd>Ctrl</li><li>Cloudflare Ray ID: <strong>8d1f2a3b4c5d6e7f</strong></li></body></html>";
    expect(detectWafFromContent(kbd).provider).toBe("cloudflare");
  });

  test("the scan stays linear on hostile markup", () => {
    const html = `<html><body>${"<code><pre ".repeat(2_000)}${'<a href="'.repeat(2_000)}</body></html>`;
    const started = performance.now();
    detectWafFromContent(html);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
