// content/dev-leakage: development, staging and preview hosts on a production page.
//
// The rule accuses a page of shipping a URL that only ever worked on somebody's
// laptop, so the fixtures that keep it quiet carry as much weight as the ones
// that trip it. Three classes matter: a tutorial printing `localhost` inside a
// code sample, a host that merely ENDS with a dev label (`notdev.example.com`),
// and an audit whose own seed is a preview deploy.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import {
  classifyHost,
  classifyUrlAttribute,
  devLeakageRule,
  findDevHostsInText,
  isDevSubdomainOf,
  isLoopbackHost,
  isNonProductionSeedHost,
  isPreviewHost,
  isPrivateIpHost,
  looksLikeOwnPreview,
  siteOriginOf,
  summarize,
  type SiteOrigin,
} from "../src/content/dev-leakage";
import { loadAllRules } from "../src/loader";
import type { CheckResult, ParsedPage, RuleContext, SiteData } from "../src/types";

const page = (body: string) => `<html><head><title>t</title></head><body>${body}</body></html>`;

// Every real page opens with chrome. Fixtures that start at the body's first
// byte hide the left-boundary bug the host patterns depend on.
const NAV = '<header><nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav></header>';

function run(
  body: string,
  opts: { url?: string; baseUrl?: string; finalUrl?: string; head?: string } = {},
): CheckResult[] {
  const url = opts.url ?? "https://example.com/about";
  const html = opts.head
    ? `<html><head><title>t</title>${opts.head}</head><body>${body}</body></html>`
    : page(body);
  const { document } = parseHTML(html);
  const ctx: RuleContext = {
    page: {
      url,
      html,
      statusCode: 200,
      loadTime: 0,
      headers: {},
      ...(opts.finalUrl ? { finalUrl: opts.finalUrl } : {}),
    },
    parsed: { document } as unknown as ParsedPage,
    ...(opts.baseUrl ? { site: { baseUrl: opts.baseUrl } as unknown as SiteData } : {}),
    options: {},
  };
  return devLeakageRule.run(ctx).checks;
}

const only = (checks: CheckResult[]): CheckResult => {
  expect(checks).toHaveLength(1);
  return checks[0] as CheckResult;
};

const site = (host = "example.com", secure = true): SiteOrigin =>
  siteOriginOf(`${secure ? "https" : "http"}://${host}/`) as SiteOrigin;

const textKinds = (text: string, origin = site()) =>
  findDevHostsInText(text, origin).map((h) => h.kind);

// ---------------------------------------------------------------------------
// Host classification
// ---------------------------------------------------------------------------

describe("host families", () => {
  test("loopback covers the whole 127/8 block, the IPv6 form and *.localhost", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("api.acme.localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.53.2.9")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    // A host that merely CONTAINS the word is somebody's domain.
    expect(isLoopbackHost("mylocalhost.com")).toBe(false);
    expect(isLoopbackHost("localhost.example.com")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
  });

  test("private ranges are the three RFC 1918 blocks and nothing adjacent", () => {
    expect(isPrivateIpHost("10.0.0.5")).toBe(true);
    expect(isPrivateIpHost("192.168.1.10")).toBe(true);
    expect(isPrivateIpHost("172.16.0.1")).toBe(true);
    expect(isPrivateIpHost("172.31.255.254")).toBe(true);
    // The 172 block stops at 31; 172.15 and 172.32 are public space.
    expect(isPrivateIpHost("172.15.0.1")).toBe(false);
    expect(isPrivateIpHost("172.32.0.1")).toBe(false);
    expect(isPrivateIpHost("192.169.1.1")).toBe(false);
    expect(isPrivateIpHost("11.0.0.1")).toBe(false);
  });

  test("an out-of-range or malformed octet is not an address", () => {
    expect(isPrivateIpHost("10.0.0.256")).toBe(false);
    expect(isPrivateIpHost("10.0.0")).toBe(false);
    expect(isPrivateIpHost("10.0.0.1.2")).toBe(false);
    expect(isPrivateIpHost("10..0.1")).toBe(false);
    expect(isPrivateIpHost("10.0.0.x")).toBe(false);
  });

  test("preview platforms match the host and any subdomain of it", () => {
    expect(isPreviewHost("acme-git-main.vercel.app")).toBe(true);
    expect(isPreviewHost("deploy-preview-7--acme.netlify.app")).toBe(true);
    expect(isPreviewHost("abc123.pages.dev")).toBe(true);
    expect(isPreviewHost("1a2b.ngrok.io")).toBe(true);
    expect(isPreviewHost("1a2b.ngrok-free.app")).toBe(true);
    expect(isPreviewHost("quiet-fox.trycloudflare.com")).toBe(true);
    // A brand that merely ends in the same letters is not the platform.
    expect(isPreviewHost("notvercel.app")).toBe(false);
    expect(isPreviewHost("mypages.dev")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PSL: the acceptance criterion that `notdev.example.com` must not match
// ---------------------------------------------------------------------------

describe("dev subdomains resolve through the registrable domain, not a suffix test", () => {
  test("the site's own dev tiers match", () => {
    expect(isDevSubdomainOf("dev.example.com", "example.com")).toBe(true);
    expect(isDevSubdomainOf("staging.example.com", "example.com")).toBe(true);
    expect(isDevSubdomainOf("test.example.com", "example.com")).toBe(true);
    // Deeper tiers still belong to the same apex.
    expect(isDevSubdomainOf("staging.app.example.com", "example.com")).toBe(true);
  });

  test("a host that merely ends with the dev label does not", () => {
    expect(isDevSubdomainOf("notdev.example.com", "example.com")).toBe(false);
    expect(isDevSubdomainOf("webdev.example.com", "example.com")).toBe(false);
    expect(isDevSubdomainOf("development.example.com", "example.com")).toBe(false);
    expect(isDevSubdomainOf("latest.example.com", "example.com")).toBe(false);
  });

  test("somebody else's dev tier is not this site's", () => {
    expect(isDevSubdomainOf("dev.other.com", "example.com")).toBe(false);
    expect(isDevSubdomainOf("dev.example.com.au", "example.com")).toBe(false);
  });

  test("a multi-label public suffix resolves to the right apex", () => {
    // A string suffix test would call `example.co.uk` a subdomain of `co.uk`.
    expect(isDevSubdomainOf("dev.example.co.uk", "example.co.uk")).toBe(true);
    expect(isDevSubdomainOf("dev.example.co.uk", "co.uk")).toBe(false);
  });

  test("the apex itself is never its own dev tier", () => {
    expect(isDevSubdomainOf("example.com", "example.com")).toBe(false);
  });
});

describe("preview ownership", () => {
  test("a preview carrying the site's own name is the site's own", () => {
    expect(looksLikeOwnPreview("acme.vercel.app", "acme")).toBe(true);
    expect(looksLikeOwnPreview("acme-git-main-acme.vercel.app", "acme")).toBe(true);
  });

  test("an unrelated tenant of the same platform is not", () => {
    expect(looksLikeOwnPreview("someones-portfolio.vercel.app", "acme")).toBe(false);
  });

  test("a label that merely CONTAINS the apex label is not", () => {
    // Whole hyphen-separated segments only. A substring test reads every one of
    // these as the site's own deployment and escalates the finding to `fail`.
    expect(looksLikeOwnPreview("sandbox-demo.vercel.app", "box")).toBe(false);
    expect(looksLikeOwnPreview("shopify-theme.vercel.app", "shop")).toBe(false);
    expect(looksLikeOwnPreview("my-nextjs-demo.vercel.app", "next")).toBe(false);
    expect(looksLikeOwnPreview("moneyapp.vercel.app", "one")).toBe(false);
    expect(looksLikeOwnPreview("blog-application.pages.dev", "app")).toBe(false);
    // The segment itself still matches.
    expect(looksLikeOwnPreview("blog-app.pages.dev", "app")).toBe(true);
  });

  test("a stranger's preview warns rather than fails, even on a short apex", () => {
    const check = only(
      run(`${NAV}<main><a href="https://sandbox-demo.vercel.app/">Partner demo</a></main>`, {
        url: "https://box.com/x",
      }),
    );
    expect(check.status).toBe("warn");
  });

  test("a two-letter apex label never claims ownership", () => {
    expect(looksLikeOwnPreview("wp-demo.vercel.app", "wp")).toBe(false);
  });
});

describe("classifyHost", () => {
  test("names the family and whether it is this site's own artifact", () => {
    const s = site("acme.com");
    expect(classifyHost("localhost", s)).toEqual({ kind: "localhost", own: true });
    expect(classifyHost("10.0.0.5", s)).toEqual({ kind: "private-ip", own: true });
    expect(classifyHost("dev.acme.com", s)).toEqual({ kind: "dev-subdomain", own: true });
    expect(classifyHost("acme-git-main.vercel.app", s)).toEqual({
      kind: "preview-host",
      own: true,
    });
    expect(classifyHost("someone-else.vercel.app", s)).toEqual({
      kind: "preview-host",
      own: false,
    });
    expect(classifyHost("example.com", s)).toBeNull();
    expect(classifyHost("cdn.acme.com", s)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Visible copy
// ---------------------------------------------------------------------------

describe("findDevHostsInText", () => {
  test("a dev URL written out in copy", () => {
    expect(textKinds("Point your client at http://localhost:3000/api")).toContain("localhost");
    expect(textKinds("Internal only: 192.168.1.10/admin")).toContain("private-ip");
    expect(textKinds("Preview at acme-git-main.vercel.app")).toContain("preview-host");
    expect(textKinds("Copy is drafted on staging.example.com first")).toContain("dev-subdomain");
  });

  test("a bare `localhost` in a sentence is not a leak; a qualified one is", () => {
    // "run it on localhost" is a sentence people write on purpose.
    expect(textKinds("The app also runs on localhost during development")).toHaveLength(0);
    expect(textKinds("Open localhost:5173 to see it")).toContain("localhost");
    expect(textKinds("Open http://localhost to see it")).toContain("localhost");
    expect(textKinds("Try api.acme.localhost for the internal build")).toContain("localhost");
  });

  test("a bare 10.x quad is a version number as often as an address", () => {
    expect(textKinds("Requires Contoso Server 10.0.0.1 or later")).toHaveLength(0);
    expect(textKinds("Requires Contoso Server v10.0.0.1 or later")).toHaveLength(0);
    // With URL context it is unmistakably a host.
    expect(textKinds("Hit http://10.0.0.1 from the VPN")).toContain("private-ip");
    expect(textKinds("Hit 10.0.0.1:8080 from the VPN")).toContain("private-ip");
    // The other two blocks and loopback have no second reading.
    expect(textKinds("Bound to 192.168.1.10 on the office LAN")).toContain("private-ip");
    expect(textKinds("Bound to 127.0.0.1 on the office LAN")).toContain("localhost");
  });

  test("a bare platform name is not a deployment", () => {
    expect(textKinds("We deploy to pages.dev and vercel.app")).toHaveLength(0);
    expect(textKinds("We deploy to acme.pages.dev")).toContain("preview-host");
  });

  test("a host at the end of a sentence still counts", () => {
    // The most common way copy mentions a host is with a full stop after it.
    expect(textKinds("Bound to 192.168.1.10.")).toContain("private-ip");
    expect(textKinds("Bound to 127.0.0.1.")).toContain("localhost");
    expect(textKinds("Preview at acme-git-main.vercel.app.")).toContain("preview-host");
    expect(textKinds("Draft on staging.example.com.")).toContain("dev-subdomain");
    expect(textKinds("(see acme.vercel.app)")).toContain("preview-host");
  });

  test("but a dot followed by MORE host is a different domain", () => {
    // `dev.example.com.au` must not match as `dev.example.com`.
    expect(textKinds("Read dev.example.com.au for theirs")).toHaveLength(0);
  });

  test("the sentence's full stop stays out of the reported sample", () => {
    const hits = findDevHostsInText("Old links point at http://example.com. Next.", site());
    expect(hits).toHaveLength(1);
    expect(hits[0]?.host).toBe("example.com");
    expect(hits[0]?.sample).toBe("http://example.com");
  });

  test("the left boundary keeps lookalike hosts out", () => {
    expect(textKinds("Visit notdev.example.com for the writeup")).toHaveLength(0);
    expect(textKinds("Our mylocalhost.com mirror is fine")).toHaveLength(0);
    expect(textKinds("Build 1.10.0.0.1 shipped")).toHaveLength(0);
  });

  test("an http self-link on an HTTPS page, and nobody else's http link", () => {
    expect(textKinds("Old bookmarks point at http://example.com/pricing")).toContain(
      "insecure-self-link",
    );
    expect(textKinds("See http://other.com/pricing for theirs")).toHaveLength(0);
  });

  test("an http self-link is not reported from an HTTP page", () => {
    expect(textKinds("Old bookmarks point at http://example.com/pricing", site("example.com", false)))
      .toHaveLength(0);
  });

  test("a dev host reachable over http is reported once, as what it is", () => {
    const kinds = textKinds("Try http://dev.example.com/preview");
    expect(kinds).toEqual(["dev-subdomain"]);
  });

  test("the sample is the URL as written, flattened to one line", () => {
    const hits = findDevHostsInText("Point at http://localhost:3000/api/v1 now", site());
    expect(hits[0]?.sample).toBe("http://localhost:3000/api/v1");
  });
});

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

describe("classifyUrlAttribute", () => {
  const s = site("example.com");
  const at = (raw: string) => classifyUrlAttribute(raw, "https://example.com/about", s);

  test("an absolute dev URL is a hit and reports the canonical form", () => {
    expect(at("http://localhost:3000/api")).toMatchObject({
      kind: "localhost",
      source: "attribute",
      host: "localhost",
      sample: "http://localhost:3000/api",
      own: true,
    });
  });

  test("a relative URL resolves onto the page's own production origin", () => {
    expect(at("/pricing")).toBeNull();
    expect(at("https://example.com/pricing")).toBeNull();
  });

  test("an http self-link on an HTTPS page", () => {
    expect(at("http://example.com/pricing")).toMatchObject({ kind: "insecure-self-link" });
    // Somebody else's http link belongs to links/https-downgrade, not here.
    expect(at("http://other.com/pricing")).toBeNull();
  });

  test("a non-HTTP scheme is out of scope", () => {
    expect(at("mailto:hi@example.com")).toBeNull();
    expect(at("javascript:void(0)")).toBeNull();
    expect(at("tel:+61000")).toBeNull();
  });

  test("a value that will not parse is links/invalid-links' finding, not this one", () => {
    expect(at("http://")).toBeNull();
    expect(at("ht!tp://[bad")).toBeNull();
  });

  test("the canonical form is percent-encoded, so a hostile attribute cannot inject", () => {
    const hit = at('http://localhost:3000/a"><img src=x onerror=1>');
    expect(hit?.sample).not.toContain('"');
    expect(hit?.sample).not.toContain("<");
  });
});

// ---------------------------------------------------------------------------
// Rule outcomes: pass, warn, fail, skipped
// ---------------------------------------------------------------------------

describe("devLeakageRule outcomes", () => {
  test("pass: an ordinary production page", () => {
    const check = only(
      run(
        `${NAV}<main><h1>Pricing</h1><p>Plans start at ten dollars.</p>` +
          `<a href="/contact">Contact us</a><img src="/img/hero.png" alt="hero">` +
          `<a href="https://example.com/docs">Docs</a></main>`,
      ),
    );
    expect(check.status).toBe("pass");
  });

  test("fail: a live href at a localhost origin", () => {
    const check = only(
      run(`${NAV}<main><a href="http://localhost:3000/api/health">Health check</a></main>`),
    );
    expect(check.status).toBe("fail");
    expect(check.message).toContain("localhost");
    expect(check.value).toBe(1);
  });

  test("fail: an img src on a private address", () => {
    const check = only(run(`${NAV}<main><img src="http://192.168.1.10/logo.png" alt=""></main>`));
    expect(check.status).toBe("fail");
    expect(check.message).toContain("private-ip");
  });

  test("fail: a link to the site's own staging tier", () => {
    const check = only(run(`${NAV}<main><a href="https://staging.example.com/x">Draft</a></main>`));
    expect(check.status).toBe("fail");
    expect(check.message).toContain("dev-subdomain");
  });

  test("fail: an asset served from the site's own preview deployment", () => {
    const check = only(
      run(`${NAV}<main><img src="https://example-git-main.vercel.app/a.png" alt=""></main>`, {
        url: "https://example.com/about",
      }),
    );
    expect(check.status).toBe("fail");
    expect(check.message).toContain("preview-host");
  });

  test("warn: a preview host that could belong to anyone", () => {
    const check = only(
      run(`${NAV}<main><a href="https://someones-portfolio.vercel.app/">A friend</a></main>`),
    );
    expect(check.status).toBe("warn");
    expect(check.message).toContain("preview-host");
  });

  test("warn: a dev host mentioned in copy but never linked", () => {
    const check = only(
      run(`${NAV}<main><p>The API also listens on http://localhost:3000 in development.</p></main>`),
    );
    expect(check.status).toBe("warn");
    expect(check.message).toContain("localhost");
  });

  test("warn: an http link back to the site's own origin never escalates", () => {
    // links/https-downgrade owns the page-level downgrade story; this rule
    // reports the same href as a baked-in dev URL and stops at warn.
    const check = only(run(`${NAV}<main><a href="http://example.com/pricing">Pricing</a></main>`));
    expect(check.status).toBe("warn");
    expect(check.message).toContain("insecure-self-link");
  });

  test("skipped: the seed is itself a preview deploy", () => {
    const check = only(
      run(`${NAV}<main><a href="https://acme.vercel.app/pricing">Pricing</a></main>`, {
        url: "https://acme.vercel.app/about",
        baseUrl: "https://acme.vercel.app/",
      }),
    );
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("non-production-origin");
  });

  test("skipped: the audit is of a local dev server", () => {
    const check = only(
      run(`${NAV}<main><a href="http://localhost:3000/api">API</a></main>`, {
        url: "http://localhost:3000/about",
      }),
    );
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("non-production-origin");
  });

  test("skipped: the seed is a staging tier even when this page redirected onto the apex", () => {
    const check = only(
      run(`${NAV}<main><a href="https://staging.example.com/x">Draft</a></main>`, {
        url: "https://example.com/about",
        baseUrl: "https://staging.example.com/",
      }),
    );
    expect(check.status).toBe("skipped");
  });

  test("fail: the head is scanned, where the worst leaks live", () => {
    // A canonical at localhost de-indexes the page; a stylesheet or script at
    // localhost breaks it outright. Body copy here is entirely clean.
    const check = only(
      run(`${NAV}<main><p>Plans start at ten dollars.</p></main>`, {
        head:
          '<link rel="canonical" href="http://localhost:3000/about">' +
          '<link rel="stylesheet" href="http://localhost:3000/a.css">' +
          '<script src="http://localhost:3000/app.js"></script>',
      }),
    );
    expect(check.status).toBe("fail");
    expect(check.value).toBe(3);
  });

  test("skipped: the page redirected onto a preview host", () => {
    const check = only(
      run(`${NAV}<main><a href="/pricing">Pricing</a></main>`, {
        url: "https://example.com/about",
        finalUrl: "https://example-git-main.vercel.app/about",
      }),
    );
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("non-production-origin");
  });

  test("the redirected-to URL decides whether the page is secure", () => {
    // Seeded over http, redirected to https: the self-link kind is live now.
    const check = only(
      run(`${NAV}<main><a href="http://example.com/pricing">Pricing</a></main>`, {
        url: "http://example.com/about",
        finalUrl: "https://example.com/about",
      }),
    );
    expect(check.status).toBe("warn");
    expect(check.message).toContain("insecure-self-link");
  });

  test("an unparseable finalUrl falls back to the page URL rather than disabling the rule", () => {
    const check = only(
      run(`${NAV}<main><a href="http://localhost:3000/api">API</a></main>`, {
        url: "https://example.com/about",
        finalUrl: "not a url",
      }),
    );
    expect(check.status).toBe("fail");
  });

  test("skipped: no document", () => {
    const ctx = {
      page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: { document: null } as unknown as ParsedPage,
      options: {},
    } as RuleContext;
    const check = only(devLeakageRule.run(ctx).checks);
    expect(check.status).toBe("skipped");
  });

  test("skipped: the page URL will not parse", () => {
    const check = only(run(`${NAV}<main><p>hi</p></main>`, { url: "not a url" }));
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("unparseable-page-url");
  });
});

// ---------------------------------------------------------------------------
// The no-false-positive fixture the acceptance criteria call for
// ---------------------------------------------------------------------------

describe("code samples stay clean", () => {
  test("a production page whose code sample mentions localhost passes", () => {
    const check = only(
      run(
        `${NAV}<main><h1>Getting started</h1>` +
          `<p>Start the dev server, then open the address it prints.</p>` +
          `<pre><code>bun run dev\n# Listening on http://localhost:5173</code></pre>` +
          `<p>Set <code>BASE_URL=http://127.0.0.1:8080</code> to point at the API.</p>` +
          `</main>`,
      ),
    );
    expect(check.status).toBe("pass");
  });

  test("a highlighted block, a CodeMirror editor and an inert template are code too", () => {
    const check = only(
      run(
        `${NAV}<main>` +
          // What Rouge and Chroma emit: a wrapper div around a real <pre>.
          `<div class="highlight"><pre><code>curl http://localhost:9000/health</code></pre></div>` +
          // What CodeMirror emits: plain divs, no <pre> or <code> anywhere.
          `<div class="cm-editor"><div>fetch("http://192.168.0.9/v1")</div></div>` +
          `<div class="language-bash"><div>curl http://10.1.2.3:9000/health</div></div>` +
          // Inert: the browser never renders it, so a visitor never reads it.
          `<template><span>http://staging.example.com</span></template>` +
          `</main>`,
      ),
    );
    expect(check.status).toBe("pass");
  });

  test("but an href inside a code block is still a live reference", () => {
    // Excluding code from the PROSE scan must not excuse a real anchor: a
    // clickable link is a clickable link wherever it sits in the markup.
    const check = only(
      run(`${NAV}<main><pre><a href="http://localhost:3000/x">run</a></pre></main>`),
    );
    expect(check.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// Reporting shape and registration
// ---------------------------------------------------------------------------

describe("reporting", () => {
  test("kinds are folded to one row each, counted, and lead with the live reference", () => {
    const check = only(
      run(
        `${NAV}<main>` +
          `<p>Mentioned once: http://localhost:4000 and again http://localhost:4001.</p>` +
          `<a href="http://192.168.1.10/admin">Admin</a>` +
          `</main>`,
      ),
    );
    expect(check.status).toBe("fail");
    expect(check.value).toBe(3);
    const rows = (check.details?.kinds ?? []) as Array<{ kind: string; count: number }>;
    expect(rows.find((r) => r.kind === "localhost")?.count).toBe(2);
    expect(rows.find((r) => r.kind === "private-ip")?.count).toBe(1);
    // The example line is the clickable one, not whichever mention came first.
    expect(check.message).toContain("http://192.168.1.10/admin");
  });

  test("item ids are kinds, never URLs", () => {
    // report/affected-pages reads an item id starting with `http` as a page of
    // the audited site, which would both inflate the affected-page count and
    // suppress the row as redundant.
    const check = only(
      run(`${NAV}<main><a href="http://localhost:3000/api">API</a></main>`),
    );
    expect(check.items).toEqual([
      {
        id: "localhost",
        label: "localhost",
        snippet: "http://localhost:3000/api",
        meta: { count: 1, inAttribute: true },
      },
    ]);
  });

  test("markdown link syntax in a hostile href cannot survive into the report", () => {
    // Canonicalizing is not enough: new URL() leaves brackets and parentheses
    // alone, and the renderer would turn them into a clickable attacker link.
    const check = only(
      run(
        `${NAV}<main><a href="http://localhost/[click here](https://evil.example/pwn)">x</a></main>`,
      ),
    );
    const sample = (check.items?.[0]?.snippet ?? "") as string;
    expect(sample).not.toContain("[");
    expect(sample).not.toContain("]");
    expect(sample).not.toContain("(");
    expect(sample).not.toContain(")");
    expect(sample).toContain("%5Bclick%20here%5D");
  });

  test("a very long site-controlled URL is truncated", () => {
    const long = `http://localhost:3000/${"a".repeat(500)}`;
    const check = only(run(`${NAV}<main><a href="${long}">x</a></main>`));
    const sample = (check.items?.[0]?.snippet ?? "") as string;
    expect(sample.length).toBeLessThanOrEqual(120);
    expect(sample.endsWith("…")).toBe(true);
  });

  test("summarize prefers an attribute sample over an earlier text one", () => {
    const rows = summarize([
      { kind: "localhost", source: "text", host: "localhost", sample: "localhost:1", own: true },
      {
        kind: "localhost",
        source: "attribute",
        host: "localhost",
        sample: "http://localhost:2/",
        own: true,
      },
    ]);
    expect(rows).toEqual([
      { kind: "localhost", sample: "http://localhost:2/", count: 2, inAttribute: true },
    ]);
  });
});

describe("registration", () => {
  test("the loader exposes the rule under its id", () => {
    const rule = loadAllRules().get("content/dev-leakage");
    expect(rule).toBeDefined();
    expect(rule?.meta.category).toBe("content");
    expect(rule?.meta.scope).toBe("page");
  });
});

describe("seed classification", () => {
  test("every non-production host family is recognised as a seed", () => {
    expect(isNonProductionSeedHost("localhost")).toBe(true);
    expect(isNonProductionSeedHost("127.0.0.1")).toBe(true);
    expect(isNonProductionSeedHost("192.168.1.10")).toBe(true);
    expect(isNonProductionSeedHost("acme.vercel.app")).toBe(true);
    expect(isNonProductionSeedHost("staging.example.com")).toBe(true);
    expect(isNonProductionSeedHost("dev.example.com")).toBe(true);
    expect(isNonProductionSeedHost("example.com")).toBe(false);
    expect(isNonProductionSeedHost("www.example.com")).toBe(false);
    expect(isNonProductionSeedHost("notdev.example.com")).toBe(false);
  });

  test("a real site whose APEX starts with a tier word is production", () => {
    // dev.to, test.com and staging.com are registrable domains, not tiers of
    // anything. A bare leftmost-label test disables the whole rule on them.
    expect(isNonProductionSeedHost("dev.to")).toBe(false);
    expect(isNonProductionSeedHost("test.com")).toBe(false);
    expect(isNonProductionSeedHost("staging.com")).toBe(false);
    // …and agrees with itself when the same site is reached as www.
    expect(isNonProductionSeedHost("www.dev.to")).toBe(false);
  });

  test("the rule still runs on a site hosted at dev.to", () => {
    const check = only(
      run(`${NAV}<main><a href="http://localhost:3000/api">API</a></main>`, {
        url: "https://dev.to/some-post",
      }),
    );
    expect(check.status).toBe("fail");
  });
});
