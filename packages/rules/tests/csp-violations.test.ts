// security/csp-violations (#425): what the browser itself blocked during a rendered crawl.
//
// The rule opens no browser: it reads the events a rendered page carries (`ctx.page.browserEvents`), which a
// render service collects and the crawler stores. Fixtures here are the events a browser raised for the pages
// in the issue.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { rules as securityRules } from "../src/security";
import { cspViolationsRule } from "../src/security/csp-violations";
import type { BrowserEvents } from "@squirrelscan/core-contracts";
import { readBrowserEvents } from "@squirrelscan/core-contracts/browser-events";
import type { RuleContext } from "../src/types";

const URL_ = "https://clinic.test/book";

function run(opts: { rendered?: boolean; events?: BrowserEvents }) {
  const html = `<!doctype html><html><head><title>Book</title></head><body><div id="widget"></div></body></html>`;
  const ctx = {
    page: {
      url: URL_,
      html,
      statusCode: 200,
      loadTime: 0,
      headers: {},
      ...(opts.rendered === undefined ? {} : { rendered: opts.rendered }),
      ...(opts.events ? { browserEvents: opts.events } : {}),
    },
    parsed: parsePage(html, URL_),
    options: {},
  } as unknown as RuleContext;
  return cspViolationsRule.run(ctx).checks[0]!;
}

const events = (cspViolations: BrowserEvents["cspViolations"], over: Partial<BrowserEvents> = {}): BrowserEvents => ({
  cspViolations,
  failedRequests: [],
  listenedAfterLoad: true,
  ...over,
});

describe("acceptance fixtures", () => {
  test("a script injected after load that script-src omits is one finding naming the host and script-src-elem", () => {
    const check = run({
      rendered: true,
      events: events([
        {
          violatedDirective: "script-src-elem",
          effectiveDirective: "script-src-elem",
          blockedUri: "https://widget.bookingvendor.test/embed.js",
          sourceFile: "https://clinic.test/assets/app.js",
          lineNumber: 12,
          disposition: "enforce",
        },
      ]),
    });
    expect(check.name).toBe("csp-violations");
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    expect(check.items![0]).toMatchObject({ id: "script-src-elem widget.bookingvendor.test" });
    expect(check.items![0]!.label).toContain("add widget.bookingvendor.test");
    expect(check.message).toContain("script-src-elem: widget.bookingvendor.test");
  });

  test("an Ads-linked gtag page with connect-src limited to www.google-analytics.com is an error listing the blocked collect endpoints", () => {
    const blocked = ["https://analytics.google.com/g/collect", "https://www.google.com/g/collect", "https://stats.g.doubleclick.net/g/collect"];
    const check = run({
      rendered: true,
      events: events([
        ...blocked.map((blockedUri) => ({ violatedDirective: "connect-src", blockedUri, disposition: "enforce" as const })),
        { violatedDirective: "script-src-elem", blockedUri: "https://googleads.g.doubleclick.net/pagead/viewthroughconversion/123/", disposition: "enforce" as const },
      ]),
    });
    expect(check.status).toBe("fail");
    const ids = (check.items ?? []).map((i) => i.id).sort();
    expect(ids).toEqual(
      ["connect-src analytics.google.com", "connect-src stats.g.doubleclick.net", "connect-src www.google.com", "script-src-elem googleads.g.doubleclick.net"].sort(),
    );
    const collect = check.items!.find((i) => i.id === "connect-src analytics.google.com")!;
    expect(collect.snippet).toContain("https://analytics.google.com/g/collect");
    expect(collect.meta).toMatchObject({ category: "analytics", directive: "connect-src" });
    expect(check.message).toContain("known");
  });

  test("the same pages under a corrected policy pass", () => {
    expect(run({ rendered: true, events: events([]) }).status).toBe("pass");
  });

  test("an HTTP-only page is skipped with its reason", () => {
    for (const rendered of [undefined, false]) {
      const check = run({ rendered });
      expect(check.status).toBe("skipped");
      expect(check.skipReason).toBe("not-rendered");
      expect(check.message).toContain("rendered crawl");
    }
  });
});

describe("what the rule reads", () => {
  test("a rendered page whose service reported no events is skipped, not passed", () => {
    const check = run({ rendered: true });
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("no-browser-events");
  });

  test("a known vendor category makes it an error, any other host a warning", () => {
    expect(run({ rendered: true, events: events([{ violatedDirective: "frame-src", blockedUri: "https://assets.calendly.com/x", disposition: "enforce" }]) }).status).toBe("fail");
    expect(run({ rendered: true, events: events([{ violatedDirective: "img-src", blockedUri: "https://images.unknown-cdn.test/a.png", disposition: "enforce" }]) }).status).toBe("warn");
  });

  test("repeats of one host and directive are one item with a count and sample URLs", () => {
    const hits = Array.from({ length: 8 }, (_, i) => ({ violatedDirective: "connect-src", blockedUri: `https://api.thirdparty.test/v1/e${i}`, disposition: "enforce" as const }));
    const check = run({ rendered: true, events: events(hits) });
    expect(check.items).toHaveLength(1);
    expect(check.items![0]!.meta).toMatchObject({ blocked: 8 });
    expect(check.items![0]!.snippet!.split(", ").length).toBeLessThanOrEqual(5);
  });

  test("a report-only violation blocks nothing: it is counted in the details, not reported", () => {
    const check = run({ rendered: true, events: events([{ violatedDirective: "script-src", blockedUri: "https://x.test/a.js", disposition: "report" }]) });
    // Only a report-only policy fired: not a pass, and not a finding.
    expect(check.status).toBe("info");
    expect(check.message).toContain("report-only");
    expect(check.message).not.toContain("no enforced CSP violation");
    expect(check.details).toMatchObject({ reportOnly: 1, violations: 1 });
  });

  test("a report-only violation next to an enforced one still reports only the enforced one", () => {
    const check = run({
      rendered: true,
      events: events([
        { violatedDirective: "script-src", blockedUri: "https://x.test/a.js", disposition: "report" },
        { violatedDirective: "img-src", blockedUri: "https://y.test/a.png", disposition: "enforce" },
      ]),
    });
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    expect(check.details).toMatchObject({ reportOnly: 1 });
  });

  test("a browser extension's blocked script is not the site's to fix: no advice, no finding", () => {
    for (const blockedUri of ["chrome-extension://abcdefgh", "moz-extension://abcdefgh"]) {
      const check = run({ rendered: true, events: events([{ violatedDirective: "script-src-elem", blockedUri, disposition: "enforce" }]) });
      expect(check.status).toBe("pass");
      expect(check.items).toBeUndefined();
      expect(check.message).not.toContain("abcdefgh");
      expect(check.details).toMatchObject({ extensionViolations: 1 });
    }
    const fromExtension = run({
      rendered: true,
      events: events([{ violatedDirective: "img-src", blockedUri: "https://x.test/a.png", sourceFile: "chrome-extension://abcdefgh", disposition: "enforce" }]),
    });
    expect(fromExtension.status).toBe("pass");
  });

  test("inline and eval are counted as sources, not as hosts", () => {
    const check = run({
      rendered: true,
      events: events([
        { violatedDirective: "script-src-elem", blockedUri: "inline", disposition: "enforce" },
        { violatedDirective: "script-src", blockedUri: "eval", disposition: "enforce" },
        { violatedDirective: "img-src", blockedUri: "https://images.unknown-cdn.test/a.png", disposition: "enforce" },
      ]),
    });
    expect(check.message).toContain("1 host and 2 inline, eval or data sources");
    expect(check.message).not.toContain("3 hosts");
  });

  test("violations past the recorded cap say how many were not recorded", () => {
    const check = run({
      rendered: true,
      events: events([{ violatedDirective: "img-src", blockedUri: "https://y.test/a.png", disposition: "enforce" }], { droppedViolations: 40 }),
    });
    expect(check.message).toContain("40 more not recorded");
    expect(check.details).toMatchObject({ droppedViolations: 40 });
  });

  test("inline and eval blocks are warnings that name the code, not a host to add", () => {
    const check = run({ rendered: true, events: events([{ violatedDirective: "script-src-elem", blockedUri: "inline", disposition: "enforce" }]) });
    expect(check.status).toBe("warn");
    expect(check.items![0]!.label).toContain("blocked inline code");
  });

  test("a render that stopped at load says the late window was not watched", () => {
    const check = run({ rendered: true, events: events([], { listenedAfterLoad: false }) });
    expect(check.status).toBe("pass");
    expect(check.message).toContain("not watched after load");
  });

  test("more than 25 blocked hosts keep 25 items and count the rest", () => {
    const hits = Array.from({ length: 40 }, (_, i) => ({ violatedDirective: "img-src", blockedUri: `https://h${i}.cdn.test/a.png`, disposition: "enforce" as const }));
    const check = run({ rendered: true, events: events(hits) });
    expect(check.items).toHaveLength(25);
    expect(check.details).toMatchObject({ additional: 15 });
  });
});

test("the rule is registered once in the security category with page verdict scope", () => {
  const found = securityRules.filter((r) => r.meta.id === "security/csp-violations");
  expect(found).toHaveLength(1);
  expect(found[0]!.meta).toMatchObject({ category: "security", scope: "page", verdictScope: "page" });
});

describe("hostile text from the page reaches no evidence line", () => {
  // Control, bidi and invisible characters a page could put in a violation to forge or hide a report line.
  const hostile = ["\u001b", "\u009b", "\u009d", "\u0090", "\u202e", "\u2066", "\u2028", "\u200b", "\ufeff", "\u00ad", "\u3164", "\u{e0041}", "\t", "\n"].join("");
  const unsafe = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]|\\p{Default_Ignorable_Code_Point}", "u");

  test("events read through the contract carry no unsafe character into the check, its items or its details", () => {
    const sanitised = readBrowserEvents({
      cspViolations: [
        { violatedDirective: `script-src-elem${hostile}`, blockedUri: `https://www.googletagmanager.com/${hostile}gtm.js`, disposition: "enforce" },
        { violatedDirective: `img-src${hostile}`, blockedUri: `https://cdn${hostile}.test/a.png`, disposition: "enforce" },
      ],
      failedRequests: [],
          listenedAfterLoad: true,
    });
    const check = run({ rendered: true, events: sanitised });
    expect(check.status).not.toBe("skipped");
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(check);
    expect(strings.length).toBeGreaterThan(2);
    for (const text of strings) expect(unsafe.test(text)).toBe(false);
  });
});
