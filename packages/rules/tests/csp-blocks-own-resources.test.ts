// security/csp-blocks-own-resources: a CSP that blocks what the page itself loads.
//
// The no-false-positive fixtures carry the weight: a CSP is easy to over-read, so
// every case a correct policy can produce has to stay clean.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { cspBlocksOwnResourcesRule } from "../src/security/csp-blocks-own-resources";
import { rules as securityRules } from "../src/security";
import { CSP_VENDORS } from "../src/security/csp-vendors";
import { parseCspPolicies, policiesAllow } from "../src/security/csp-source-match";
import type { RuleContext } from "../src/types";

const PAGE = "https://shop.test/";

function run(
  head: string,
  csp: string | undefined,
  opts: { url?: string; body?: string; scripts?: { url: string; content: string }[]; headers?: Record<string, string> } = {},
) {
  const url = opts.url ?? PAGE;
  const html = `<!DOCTYPE html><html><head><title>t</title>${head}</head><body>${opts.body ?? "hello"}</body></html>`;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (csp !== undefined) headers["content-security-policy"] = csp;
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers },
    parsed: parsePage(html, url),
    site: {
      baseUrl: url,
      pages: [],
      scripts: (opts.scripts ?? []).map((s) => ({
        url: s.url,
        status: 200,
        error: null,
        contentType: "text/javascript",
        sizeBytes: s.content.length,
        content: s.content,
        sourcePages: [url],
      })),
    },
    options: {},
  } as unknown as RuleContext;
  return cspBlocksOwnResourcesRule.run(ctx).checks[0]!;
}

const hostsOf = (check: ReturnType<typeof run>) =>
  (check.items ?? []).map((i) => `${i.meta?.directive}:${i.meta?.host}`).sort();

describe("acceptance fixtures", () => {
  test("gtag for an Ads-linked property with a thin connect-src is an error naming the missing hosts", () => {
    const check = run(
      `<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123DEF4"></script>
       <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}
       gtag('js',new Date());gtag('config','G-ABC123DEF4');gtag('config','AW-123456789');</script>`,
      "default-src 'self'; script-src 'self' https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://www.google.com; frame-src https://td.doubleclick.net; connect-src 'self' https://www.google-analytics.com",
    );
    expect(check.status).toBe("fail");
    expect(hostsOf(check)).toEqual([
      "connect-src:analytics.google.com",
      "connect-src:stats.g.doubleclick.net",
      "connect-src:www.google.com",
    ]);
    expect(check.message).toContain("connect-src: add analytics.google.com, www.google.com, stats.g.doubleclick.net");
  });

  test("a third-party script URL named only inside a preloaded same-origin chunk is a finding", () => {
    const check = run(
      `<link rel="modulepreload" href="/assets/booking-4f2a.js">`,
      "default-src 'self'; script-src 'self'",
      {
        scripts: [
          {
            url: "https://shop.test/assets/booking-4f2a.js",
            content: `export function open(){const s=document.createElement("script");s.src="https://widget.bookings.example/embed/v2/widget.js";document.head.appendChild(s)}`,
          },
        ],
      },
    );
    expect(check.status).toBe("warn");
    expect(hostsOf(check)).toEqual(["script-src:widget.bookings.example"]);
    expect(check.items?.[0]?.meta?.found).toBe("chunk");
  });

  test("a *.example.com source allows cdn.example.com and blocks example.com", () => {
    const policy = "default-src 'self'; script-src 'self' https://*.example.com";
    expect(run(`<script src="https://cdn.example.com/a.js"></script>`, policy).status).toBe("pass");
    const apex = run(`<script src="https://example.com/a.js"></script>`, policy);
    expect(apex.status).toBe("warn");
    expect(hostsOf(apex)).toEqual(["script-src:example.com"]);
  });

  test("no CSP header passes, and a report-only policy blocks nothing", () => {
    const head = `<script src="https://cdn.other.test/a.js"></script>`;
    const none = run(head, undefined);
    expect(none.status).toBe("pass");
    expect(none.message).toContain("security/csp");
    expect(run(head, undefined, { headers: { "content-security-policy-report-only": "script-src 'none'" } }).status).toBe("pass");
  });
});

describe("severity", () => {
  test("a blocked analytics, payments or captcha host fails, an unknown host warns", () => {
    const csp = "default-src 'self'";
    expect(run(`<script src="https://js.stripe.com/v3/"></script>`, csp).status).toBe("fail");
    expect(run(`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>`, csp).status).toBe("fail");
    expect(run(`<script src="https://static.randomvendor.test/x.js"></script>`, csp).status).toBe("warn");
  });

  test("Stripe, Turnstile, reCAPTCHA and PostHog name the hosts the HTML never loads", () => {
    const csp = "default-src 'self'; script-src 'self' https://js.stripe.com https://challenges.cloudflare.com https://www.google.com https://www.gstatic.com https://us-assets.i.posthog.com";
    const check = run(
      `<script src="https://js.stripe.com/v3/"></script>
       <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
       <script src="https://www.google.com/recaptcha/api.js"></script>
       <script src="https://us-assets.i.posthog.com/static/array.js"></script>`,
      csp,
    );
    expect(hostsOf(check)).toEqual([
      "default-src:api.stripe.com",
      "default-src:challenges.cloudflare.com",
      "default-src:hooks.stripe.com",
      "default-src:js.stripe.com",
      "default-src:us.i.posthog.com",
      "default-src:www.google.com",
    ]);
  });
});

describe("policy scope", () => {
  test("each page is judged by its own policy", () => {
    const head = `<script src="https://cdn.other.test/a.js"></script>`;
    expect(run(head, "script-src 'self'", { url: "https://shop.test/a" }).status).toBe("warn");
    expect(run(head, "script-src 'self' https://cdn.other.test", { url: "https://shop.test/b" }).status).toBe("pass");
  });

  test("a meta http-equiv policy is enforced too", () => {
    const check = run(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'self'"><script src="https://cdn.other.test/a.js"></script>`,
      undefined,
    );
    expect(check.status).toBe("warn");
  });

  test("every policy of a multi-policy header has to allow the resource", () => {
    const head = `<script src="https://cdn.other.test/a.js"></script>`;
    expect(run(head, "script-src 'self' https://cdn.other.test, script-src 'self'").status).toBe("warn");
  });
});

describe("no false positives", () => {
  const ok = (head: string, csp: string, opts = {}) => expect(run(head, csp, opts).status).toBe("pass");

  test("'self' allows same-origin scripts, styles, images and frames", () => {
    ok(
      `<script src="/a.js"></script><link rel="stylesheet" href="/a.css"><img src="/a.png"><iframe src="/embed"></iframe>`,
      "default-src 'self'",
    );
  });

  test("directive fallback: script-src-elem, child-src and default-src", () => {
    ok(`<script src="https://cdn.x.test/a.js"></script>`, "script-src 'none'; script-src-elem https://cdn.x.test");
    ok(`<iframe src="https://embed.x.test/f"></iframe>`, "default-src 'none'; child-src https://embed.x.test");
    ok(`<img src="https://img.x.test/a.png">`, "default-src https://img.x.test");
  });

  test("a directive that is not set allows everything", () => {
    ok(`<img src="https://img.x.test/a.png"><iframe src="https://e.x.test/"></iframe>`, "script-src 'self'");
  });

  test("scheme, port and path sources", () => {
    ok(`<script src="https://cdn.x.test/lib/a.js"></script>`, "script-src https:");
    ok(`<script src="https://cdn.x.test:8443/a.js"></script>`, "script-src https://cdn.x.test:8443");
    ok(`<script src="https://cdn.x.test:8443/a.js"></script>`, "script-src https://cdn.x.test:*");
    ok(`<script src="https://cdn.x.test/lib/a.js"></script>`, "script-src https://cdn.x.test/lib/");
    ok(`<script src="https://cdn.x.test/lib/a.js"></script>`, "script-src https://cdn.x.test/lib/a.js");
    ok(`<script src="https://cdn.x.test/a.js"></script>`, "script-src cdn.x.test");
    ok(`<script src="https://CDN.X.TEST/a.js"></script>`, "SCRIPT-SRC HTTPS://cdn.x.test");
    ok(`<script src="https://cdn.x.test/a.js"></script>`, "script-src *");
  });

  test("a nonce on the element allows it", () => {
    ok(`<script nonce="r4nd0m" src="https://cdn.x.test/a.js"></script>`, "script-src 'nonce-r4nd0m'");
  });

  test("'strict-dynamic' makes a host check undecidable, so nothing is reported", () => {
    ok(`<script src="https://cdn.x.test/a.js"></script>`, "script-src 'nonce-abc' 'strict-dynamic'");
  });

  test("a noscript fallback and a data: image are not judged", () => {
    ok(`<img src="data:image/gif;base64,R0lGOD"><noscript><img src="https://px.x.test/p.gif"></noscript>`, "img-src 'self'");
  });

  test("a chunk URL without a script-loading context is not a load", () => {
    ok(
      `<link rel="modulepreload" href="/c.js">`,
      "script-src 'self'",
      { scripts: [{ url: "https://shop.test/c.js", content: `/* docs: https://cdn.jsdelivr.net/npm/lib/dist/lib.js */ const homepage = "https://example.org/lib.js";` }] },
    );
  });

  test("a chunk URL on the page's own host or already allowed is not a finding", () => {
    ok(
      `<link rel="modulepreload" href="/c.js">`,
      "script-src 'self' https://widget.ok.test",
      { scripts: [{ url: "https://shop.test/c.js", content: `s.src="https://widget.ok.test/w.js";document.head.appendChild(s);import("https://shop.test/lazy.js")` }] },
    );
  });

  test("vendors are checked only when the page uses them, and a proxied PostHog is not", () => {
    ok(`<script>posthog.init('phc_abc', {api_host: '/ingest'})</script>`, "default-src 'self'");
    ok("", "default-src 'none'", { body: "no resources at all" });
  });

  test("a page whose policy covers a GA4-only setup passes", () => {
    ok(
      `<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123DEF4"></script><script>gtag('config','G-ABC123DEF4')</script>`,
      "default-src 'self'; script-src 'self' https://www.googletagmanager.com; connect-src 'self' https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com",
    );
  });
});

describe("source matching", () => {
  const allow = (policy: string, url: string, kind: "script" | "connect" = "script") =>
    policiesAllow(parseCspPolicies(policy), new URL(url), kind, new URL(PAGE)).allowed;

  test("*.example.com does not match example.com, and 'self' needs the same port", () => {
    expect(allow("script-src *.example.com", "https://example.com/a.js")).toBe(false);
    expect(allow("script-src *.example.com", "https://a.b.example.com/a.js")).toBe(true);
    expect(allow("script-src 'self'", "https://shop.test:8443/a.js")).toBe(false);
    expect(allow("script-src https://x.test", "https://x.test:444/a.js")).toBe(false);
  });

  test("a scheme-less source on an https page rejects http, an empty list rejects all", () => {
    expect(allow("script-src x.test", "http://x.test/a.js")).toBe(false);
    expect(allow("script-src", "https://x.test/a.js")).toBe(false);
    expect(allow("script-src 'none'", "https://shop.test/a.js")).toBe(false);
  });

  test("the first duplicate directive wins", () => {
    expect(allow("script-src https://a.test; script-src https://b.test", "https://a.test/x.js")).toBe(true);
    expect(allow("script-src https://a.test; script-src https://b.test", "https://b.test/x.js")).toBe(false);
  });
});

describe("registration and vendor table", () => {
  test("the rule is registered once under security", () => {
    expect(securityRules.filter((r) => r.meta.id === "security/csp-blocks-own-resources")).toHaveLength(1);
  });

  test("every vendor entry records an ISO last-verified date", () => {
    for (const vendor of CSP_VENDORS) expect(vendor.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
