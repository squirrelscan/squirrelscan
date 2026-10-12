// reliability/broken-forms - forms that silently lose submissions (#707).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { getCategoryGroup, getCategoryName, CATEGORY_CODES } from "../src/categories";
import { loadAllRules } from "../src/loader";
import { createProbeBudget, type ProbeBudget, type ProbeLevel } from "../src/probe-budget";
import { brokenFormsRule, createBrokenFormsRule } from "../src/reliability/broken-forms";
import type { CheckResult, ExternalLinkCheckData, RuleContext, SiteData } from "../src/types";

const HOME = "https://example.com/";

interface PageSpec {
  url: string;
  html: string;
  statusCode?: number;
}

function site(pages: PageSpec[], extra: Partial<SiteData> = {}): SiteData {
  return {
    baseUrl: "https://example.com",
    pages: pages.map((p) => ({
      url: p.url,
      statusCode: p.statusCode ?? 200,
      parsed: parsePage(p.html, p.url),
    })),
    robotsTxt: null,
    sitemaps: null,
    ...extra,
  } as SiteData;
}

function ctx(s: SiteData, probe?: ProbeBudget): RuleContext {
  return { site: s, probe, options: {} } as unknown as RuleContext;
}

function doc(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${bodyHtml}</body></html>`;
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

function labels(result: CheckResult | undefined): string[] {
  return (result?.items ?? []).map((i) => i.label ?? i.id);
}

function budget(level: ProbeLevel): ProbeBudget {
  return createProbeBudget({ level, budgetMs: 60_000 });
}

/**
 * Test DNS: every public-looking test host answers one public address, so no
 * test needs the network. The rule pins each probe to that address and keeps
 * the name in the Host header; the stub below records the name again.
 */
const DNS: Record<string, string[]> = {
  "example.com": ["93.184.216.34"],
  "pay.example.com": ["93.184.216.35"],
  "forms.vendor.com": ["93.184.216.36"],
};
const rule = createBrokenFormsRule({
  resolve: async (host) => {
    const answer = DNS[host];
    if (!answer) throw new Error(`ENOTFOUND ${host}`);
    return answer;
  },
});

/** A fetch stub that records every request and answers with `status` per URL. */
interface Call {
  url: string;
  method: string;
  /** The URL the request actually connected to (the pinned address). */
  raw: string;
  /** The Host header it carried. */
  host: string | null;
}
let calls: Call[] = [];
let answer: (url: string, method: string) => Response | "throw" = (_url, _method) =>
  new Response(null, { status: 200 });

const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  answer = (_url, _method) => new Response(null, { status: 200 });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Record the name the request was for: pinned requests carry it in Host.
    const logical = new URL(raw);
    const host = new Headers(init?.headers).get("host");
    if (host) logical.host = host;
    const url = logical.href;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, raw, host });
    const res = answer(url, method);
    if (res === "throw") throw new TypeError("fetch failed");
    return res;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CONTACT = (inner: string, attrs = 'action="/contact" method="post"') =>
  doc(`<form ${attrs}>${inner}<button type="submit">Send</button></form>`);

describe("reliability/broken-forms: unnamed fields", () => {
  test("warns on an unnamed email field in a form with a real action", async () => {
    const html = CONTACT(`<input name="name" type="text"><input id="email" type="email">`);
    const result = await rule.run(
      ctx(
        site([
          { url: HOME, html },
          { url: "https://example.com/contact", html: "" },
        ]),
        budget("active"),
      ),
    );
    const warn = check(result.checks, "unnamed-form-fields");
    expect(warn?.status).toBe("warn");
    const text = labels(warn).join("\n");
    expect(text).toContain("input#email");
    expect(text).toContain('form[action="/contact"]');
  });

  test("a fully named form produces no finding and passes", async () => {
    const html = CONTACT(`<input name="name" type="text"><input name="email" type="email">`);
    const result = await rule.run(
      ctx(
        site([
          { url: HOME, html },
          { url: "https://example.com/contact", html: "" },
        ]),
        budget("active"),
      ),
    );
    expect(check(result.checks, "unnamed-form-fields")).toBeUndefined();
    expect(check(result.checks, "unnamed-form-fields-no-action")).toBeUndefined();
    expect(check(result.checks, "broken-forms")?.status).toBe("pass");
  });

  test('a form with no action, or action="#", reports unnamed fields as info, not warn', async () => {
    for (const attrs of ['method="post"', 'action="#" method="post"']) {
      const html = doc(`<form ${attrs}><input id="email" type="email"></form>`);
      const result = await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
      expect(check(result.checks, "unnamed-form-fields")).toBeUndefined();
      expect(check(result.checks, "unnamed-form-fields-no-action")?.status).toBe("info");
    }
  });

  test("submit, button, reset, image, disabled and form=other controls are not reported against their own form", async () => {
    const html = doc(`
      <form id="contact" action="/contact" method="post">
        <input type="submit" value="Go">
        <input type="button" value="Other">
        <button type="reset">Reset</button>
        <input type="image" src="/go.png">
        <input type="text" name="x" disabled>
        <input type="text" form="other">
      </form>
      <form id="other" action="/other" method="post"></form>`);
    const result = await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    // Only the `form="other"` control is unnamed, and it belongs to #other, not #contact.
    const warn = check(result.checks, "unnamed-form-fields");
    expect(warn?.items).toHaveLength(1);
    expect(labels(warn).join("\n")).toContain("form#other");
    expect(labels(warn).join("\n")).not.toContain("form#contact");
  });

  test('a control outside any form with form="contact" and no name is reported against #contact', async () => {
    const html = doc(`
      <form id="contact" action="/contact" method="post"></form>
      <input id="stray" type="text" form="contact">`);
    const result = await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    const warn = check(result.checks, "unnamed-form-fields");
    expect(warn?.status).toBe("warn");
    expect(labels(warn).join("\n")).toContain("form#contact");
  });
});

describe("reliability/broken-forms: action reachability", () => {
  test("a same-origin action the crawl fetched and found 404 is an error, with no extra request", async () => {
    const html = CONTACT(`<input name="a">`);
    const result = await rule.run(
      ctx(
        site([
          { url: HOME, html },
          { url: "https://example.com/contact", html: "", statusCode: 404 },
        ]),
        budget("aggressive"),
      ),
    );
    expect(check(result.checks, "dead-form-action")?.status).toBe("fail");
    expect(calls).toHaveLength(0);
  });

  test("an uncrawled same-origin action answering 405 to HEAD and GET is not broken; 404 warns as maybe POST-only", async () => {
    const html = CONTACT(`<input name="a">`);
    answer = () => new Response(null, { status: 405 });
    let result = await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    expect(check(result.checks, "dead-form-action")).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["HEAD", "GET"]);

    calls = [];
    answer = (_url, method) => new Response(null, { status: method === "HEAD" ? 405 : 404 });
    result = await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    expect(check(result.checks, "dead-form-action")).toBeUndefined();
    const probe404 = check(result.checks, "form-action-not-found-to-probe");
    expect(probe404?.status).toBe("warn");
    expect(labels(probe404).join("\n")).toContain("the endpoint may accept POST only");
  });

  test("no probe ever uses POST", async () => {
    const html = doc(`
      <form action="/a" method="post"><input name="x"></form>
      <form action="/b" method="post"><input name="x"></form>
      <form action="https://pay.example.com/x" method="post"><input name="x"></form>`);
    answer = () => new Response(null, { status: 500 });
    await rule.run(ctx(site([{ url: HOME, html }]), budget("aggressive")));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "HEAD" || c.method === "GET")).toBe(true);
  });

  test("passive probing sends nothing for an uncrawled action and says so", async () => {
    const html = CONTACT(`<input name="a">`);
    const result = await rule.run(ctx(site([{ url: HOME, html }]), budget("passive")));
    expect(calls).toHaveLength(0);
    const unchecked = check(result.checks, "unchecked-form-actions");
    expect(unchecked?.status).toBe("info");
    expect(unchecked?.message).toContain("passive probing sends no requests");
  });

  test("staging, localhost and mailto actions each warn, with no request", async () => {
    const html = doc(`
      <form action="https://staging.example.com/lead" method="post"><input name="a"></form>
      <form action="http://localhost:3000/subscribe" method="post"><input name="a"></form>
      <form action="mailto:hi@example.com" method="post"><input name="a"></form>`);
    const result = await rule.run(ctx(site([{ url: HOME, html }]), budget("aggressive")));
    expect(check(result.checks, "non-production-form-action")?.status).toBe("warn");
    expect(labels(check(result.checks, "non-production-form-action")).join("\n")).toContain(
      "staging.example.com",
    );
    expect(labels(check(result.checks, "non-production-form-action")).join("\n")).toContain(
      "localhost",
    );
    expect(check(result.checks, "mailto-form-action")?.status).toBe("warn");
    expect(calls).toHaveLength(0);
  });

  test("an http: action to a public host is left to security/form-https, not probed here", async () => {
    const html = doc(
      `<form action="http://pay.example.org/x" method="post"><input name="a"></form>`,
    );
    const result = await rule.run(ctx(site([{ url: HOME, html }]), budget("aggressive")));
    expect(result.checks.filter((c) => c.name.includes("form-action"))).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("429, 503 with Retry-After and a WAF challenge are unverified info, never broken", async () => {
    const html = doc(`
      <form action="/a" method="post"><input name="x"></form>
      <form action="/b" method="post"><input name="x"></form>
      <form action="/c" method="post"><input name="x"></form>`);
    answer = (url) => {
      if (url.endsWith("/a")) return new Response(null, { status: 429 });
      if (url.endsWith("/b"))
        return new Response(null, { status: 503, headers: { "retry-after": "60" } });
      return new Response(null, { status: 403, headers: { "cf-mitigated": "challenge" } });
    };
    const result = await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    expect(check(result.checks, "dead-form-action")).toBeUndefined();
    expect(check(result.checks, "unreachable-form-action")).toBeUndefined();
    expect(check(result.checks, "unverified-form-actions")?.status).toBe("info");
  });

  test("a third-party action is not requested when external link checking is off", async () => {
    const html = doc(
      `<form action="https://forms.vendor.com/submit" method="post"><input name="a"></form>`,
    );
    const result = await rule.run(ctx(site([{ url: HOME, html }]), budget("aggressive")));
    expect(calls).toHaveLength(0);
    expect(check(result.checks, "unchecked-form-actions")?.message).toContain(
      "external link checking is off",
    );
  });

  test("a third-party action is requested only when external link checking is on", async () => {
    const html = doc(
      `<form action="https://forms.vendor.com/submit" method="post"><input name="a"></form>`,
    );
    const external: ExternalLinkCheckData[] = [];
    const result = await rule.run(
      ctx(site([{ url: HOME, html }], { externalLinks: external }), budget("active")),
    );
    expect(calls.map((c) => c.url)).toEqual(["https://forms.vendor.com/submit"]);
    expect(calls[0]?.method).toBe("HEAD");
    expect(result.checks.length).toBeGreaterThan(0);
  });

  test("a first-party action that answers 404 to the probe warns (maybe POST-only); one the crawl found 404 is an error", async () => {
    const html = CONTACT(`<input name="a">`);
    answer = () => new Response(null, { status: 404 });
    const probed = await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    expect(check(probed.checks, "dead-form-action")).toBeUndefined();
    expect(check(probed.checks, "form-action-not-found-to-probe")?.status).toBe("warn");

    const crawled = await rule.run(
      ctx(
        site([
          { url: HOME, html },
          { url: "https://example.com/contact", html: doc("gone"), statusCode: 404 },
        ]),
        budget("active"),
      ),
    );
    expect(check(crawled.checks, "dead-form-action")?.status).toBe("fail");
  });

  test("auditing localhost: a relative action is the site's own, never a non-production warning", async () => {
    const local = "http://localhost:3000/";
    const html = doc(`<form action="/subscribe" method="post"><input name="email"></form>`);
    const localSite = {
      baseUrl: "http://localhost:3000",
      pages: [{ url: local, statusCode: 200, parsed: parsePage(html, local) }],
      robotsTxt: null,
      sitemaps: null,
    } as unknown as SiteData;
    const result = await rule.run(ctx(localSite, budget("active")));
    expect(check(result.checks, "non-production-form-action")).toBeUndefined();
    // A plain-http action the crawl did not fetch is not probed.
    expect(calls).toHaveLength(0);
  });

  test("a preview deployment's own actions are not non-production warnings", async () => {
    const preview = "https://acme-git-main-acme.vercel.app/";
    const html = doc(
      `<form action="https://acme-git-main-acme.vercel.app/api/lead" method="post"><input name="a"></form>`,
    );
    const previewSite = {
      baseUrl: "https://acme-git-main-acme.vercel.app",
      pages: [{ url: preview, statusCode: 200, parsed: parsePage(html, preview) }],
      robotsTxt: null,
      sitemaps: null,
    } as unknown as SiteData;
    const result = await rule.run(ctx(previewSite, budget("passive")));
    expect(check(result.checks, "non-production-form-action")).toBeUndefined();
  });

  test("a probe carries squirrel's User-Agent and no cookies or custom headers", async () => {
    const html = CONTACT(`<input name="a">`);
    let seen: Headers | undefined;
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      seenInit = init;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    expect(seen?.get("user-agent")).toContain("squirrelscan");
    expect(seen?.get("cookie")).toBeNull();
    expect(seen?.get("authorization")).toBeNull();
    expect(seenInit?.credentials).toBe("omit");
    expect(seenInit?.redirect).toBe("manual");
    // Undecoded (#2717): the runtime never inflates a compressed body the probe drops.
    expect((seenInit as { decompress?: boolean } | undefined)?.decompress).toBe(false);
  });

  test("a third-party action on a private or metadata address is never requested", async () => {
    const html = doc(`
      <form action="https://169.254.169.254/latest/meta-data/" method="post"><input name="a"></form>
      <form action="https://10.0.0.5/submit" method="post"><input name="a"></form>
      <form action="https://inside.vendor.com/submit" method="post"><input name="a"></form>`);
    DNS["inside.vendor.com"] = ["10.0.0.9"];
    let result: Awaited<ReturnType<typeof rule.run>>;
    try {
      result = await rule.run(
        ctx(site([{ url: HOME, html }], { externalLinks: [] }), budget("aggressive")),
      );
    } finally {
      delete DNS["inside.vendor.com"];
    }
    // Nothing left the process: 10.0.0.5 is reported as a private host without a
    // request, and the metadata address and the public-looking name that resolves
    // privately are refused by the egress guard.
    expect(calls).toHaveLength(0);
    const unchecked = check(result.checks, "unchecked-form-actions");
    expect(labels(unchecked).join("\n")).toContain("inside.vendor.com");
    expect(unchecked?.message).toContain("private, loopback or link-local");
    expect(check(result.checks, "unreachable-form-action")).toBeUndefined();
    expect(check(result.checks, "dead-form-action")).toBeUndefined();
  });

  test("a probe connects to the vetted address and keeps the name in Host", async () => {
    const html = CONTACT(`<input name="a">`);
    await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.raw).hostname).toBe("93.184.216.34");
    expect(calls[0]!.host).toBe("example.com");
  });

  test("a same-site name that resolves to the metadata address is refused", async () => {
    const html = doc(
      `<form action="https://meta.example.com/x" method="post"><input name="a"></form>`,
    );
    DNS["meta.example.com"] = ["169.254.169.254"];
    let result: Awaited<ReturnType<typeof rule.run>>;
    try {
      result = await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    } finally {
      delete DNS["meta.example.com"];
    }
    expect(calls).toHaveLength(0);
    expect(check(result.checks, "unchecked-form-actions")?.status).toBe("info");
  });

  test("a public site's subdomain that resolves privately is never probed", async () => {
    const html = doc(
      `<form action="https://intranet.example.com/x" method="post"><input name="a"></form>`,
    );
    DNS["intranet.example.com"] = ["10.1.2.3"];
    let result: Awaited<ReturnType<typeof rule.run>>;
    try {
      result = await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    } finally {
      delete DNS["intranet.example.com"];
    }
    expect(calls).toHaveLength(0);
    expect(check(result.checks, "unchecked-form-actions")?.message).toContain(
      "private, loopback or link-local",
    );
  });

  test("the site's own origin may resolve privately (the crawl already requests it)", async () => {
    const html = CONTACT(`<input name="a">`);
    DNS["example.com"] = ["127.0.0.1"];
    try {
      await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    } finally {
      DNS["example.com"] = ["93.184.216.34"];
    }
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.raw).hostname).toBe("127.0.0.1");
  });

  test("another port on the site's own host that resolves privately is never probed", async () => {
    const html = doc(
      `<form action="https://example.com:8443/x" method="post"><input name="a"></form>`,
    );
    DNS["example.com"] = ["127.0.0.1"];
    let result: Awaited<ReturnType<typeof rule.run>>;
    try {
      result = await rule.run(ctx(site([{ url: HOME, html }]), budget("active")));
    } finally {
      DNS["example.com"] = ["93.184.216.34"];
    }
    expect(calls).toHaveLength(0);
    expect(check(result.checks, "unchecked-form-actions")?.status).toBe("info");
  });

  test("at most 10 endpoints per site are probed; the rest are not checked", async () => {
    const forms = Array.from(
      { length: 30 },
      (_, n) => `<form action="/a${n}" method="post"><input name="q"></form>`,
    ).join("");
    const result = await rule.run(ctx(site([{ url: HOME, html: doc(forms) }]), budget("active")));
    expect(calls).toHaveLength(10);
    const unchecked = check(result.checks, "unchecked-form-actions");
    expect(unchecked?.items).toHaveLength(20);
    expect(unchecked?.message).toContain("probe cap reached");
  });

  test("query variants of one endpoint share a single probe", async () => {
    const forms = Array.from(
      { length: 30 },
      (_, n) => `<form action="/cart/add?id=${n}" method="post"><input name="q"></form>`,
    ).join("");
    const result = await rule.run(ctx(site([{ url: HOME, html: doc(forms) }]), budget("active")));
    expect(calls).toHaveLength(1);
    expect(check(result.checks, "unchecked-form-actions")).toBeUndefined();
  });

  test("at most 25 endpoints in all, the site's own first", async () => {
    // Vendor forms first on the page, then the site's own.
    const vendors = Array.from({ length: 4 }, (_, v) =>
      Array.from(
        { length: 8 },
        (_, n) =>
          `<form action="https://forms${v}.vendor${v}.com/f${n}" method="post"><input name="q"></form>`,
      ).join(""),
    ).join("");
    const own = Array.from(
      { length: 5 },
      (_, n) => `<form action="/own${n}" method="post"><input name="q"></form>`,
    ).join("");
    for (let v = 0; v < 4; v++) DNS[`forms${v}.vendor${v}.com`] = [`93.184.216.${40 + v}`];
    try {
      await rule.run(
        ctx(
          site([{ url: HOME, html: doc(vendors + own) }], { externalLinks: [] }),
          budget("aggressive"),
        ),
      );
    } finally {
      for (let v = 0; v < 4; v++) delete DNS[`forms${v}.vendor${v}.com`];
    }
    expect(calls).toHaveLength(25);
    // Every own endpoint was probed, ahead of the vendors.
    expect(calls.slice(0, 5).map((c) => new URL(c.url).pathname)).toEqual([
      "/own0",
      "/own1",
      "/own2",
      "/own3",
      "/own4",
    ]);
  });

  test("on a preview deployment, a localhost or private-IP action is still reported", async () => {
    const preview = "https://acme.netlify.app/";
    const html = doc(`
      <form action="https://localhost:8443/api" method="post"><input name="a"></form>
      <form action="http://192.168.1.10/api" method="post"><input name="a"></form>`);
    const previewSite = {
      baseUrl: "https://acme.netlify.app",
      pages: [{ url: preview, statusCode: 200, parsed: parsePage(html, preview) }],
      robotsTxt: null,
      sitemaps: null,
    } as unknown as SiteData;
    const result = await rule.run(ctx(previewSite, budget("passive")));
    const warned = labels(check(result.checks, "non-production-form-action")).join("\n");
    expect(warned).toContain("localhost");
    expect(warned).toContain("192.168.1.10");
  });

  test("an IPv6-literal site probes its own actions", async () => {
    const v6 = "https://[2606:4700::1111]/";
    const html = doc(`<form action="/contact" method="post"><input name="a"></form>`);
    const v6Site = {
      baseUrl: "https://[2606:4700::1111]",
      pages: [{ url: v6, statusCode: 200, parsed: parsePage(html, v6) }],
      robotsTxt: null,
      sitemaps: null,
    } as unknown as SiteData;
    const result = await rule.run(ctx(v6Site, budget("active")));
    expect(calls).toHaveLength(1);
    expect(check(result.checks, "unchecked-form-actions")).toBeUndefined();
  });

  test("a crafted action cannot turn a label into a markdown link", async () => {
    const html = doc(
      `<form action="mailto:x@example.com?subject=](https://evil.example/pwn)" method="post"><input name="a"></form>`,
    );
    const result = await rule.run(ctx(site([{ url: HOME, html }]), budget("passive")));
    const text = labels(check(result.checks, "mailto-form-action")).join("\n");
    expect(text).not.toContain("](https://evil.example");
  });
});
describe("reliability/broken-forms: category and registration", () => {
  test("the rule is in the reliability category and registered", () => {
    expect(brokenFormsRule.meta.category).toBe("reliability");
    expect(getCategoryGroup("reliability")).toBeDefined();
    expect(getCategoryName("reliability")).toBeDefined();
    expect(CATEGORY_CODES).toContain("reliability");
    expect(loadAllRules().has("reliability/broken-forms")).toBe(true);
  });
});
