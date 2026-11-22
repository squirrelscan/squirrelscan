// security/csp-violations (#425): what the browser blocked under the page's CSP while it rendered.
//
// The renderer records `securitypolicyviolation` events; these fixtures stand in for it. `browserBlocks`
// plays the browser: it judges each load the page makes against the policy with the same source matcher
// the static CSP rules use, and reports a violation the way the browser would. So the "corrected policy"
// cases below pass because the policy now allows the load, not because the fixture was emptied by hand.

import type {
  RenderCspViolation,
  RenderRuntimeDiagnostics,
} from "@squirrelscan/core-contracts";

import { RUNTIME_NOT_RECORDED_SKIP_REASON } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { RuleContext } from "../src/types";

import { rules as securityRules } from "../src/security";
import {
  type CspFetchKind,
  parseCspPolicies,
  policiesAllow,
} from "../src/security/csp-source-match";
import { cspViolationsRule } from "../src/security/csp-violations";

const PAGE = "https://www.example.com/book";

/** The directive the browser reports as `effectiveDirective` for a load of this kind. */
const EFFECTIVE: Record<CspFetchKind, string> = {
  script: "script-src-elem",
  style: "style-src-elem",
  frame: "frame-src",
  img: "img-src",
  font: "font-src",
  connect: "connect-src",
};

/** The violations a browser enforcing `csp` raises for `loads`. */
function browserBlocks(
  csp: string,
  loads: Array<{ url: string; kind: CspFetchKind; from?: string }>
): RenderCspViolation[] {
  const policies = parseCspPolicies(csp);
  const page = new URL(PAGE);
  const out: RenderCspViolation[] = [];
  for (const load of loads) {
    const verdict = policiesAllow(policies, new URL(load.url), load.kind, page);
    if (verdict.allowed !== false) continue;
    out.push({
      effectiveDirective: EFFECTIVE[load.kind],
      violatedDirective: verdict.directive,
      blockedURI: load.url,
      disposition: "enforce",
      ...(load.from ? { sourceFile: load.from, lineNumber: 12 } : {}),
    });
  }
  return out;
}

function run(opts: { rendered?: boolean; runtime?: RenderRuntimeDiagnostics }) {
  const html =
    "<!DOCTYPE html><html><head><title>t</title></head><body>hi</body></html>";
  const ctx = {
    page: {
      url: PAGE,
      html,
      statusCode: 200,
      loadTime: 0,
      headers: {},
      ...(opts.rendered === false ? {} : { rendered: true }),
      ...(opts.runtime ? { renderRuntime: opts.runtime } : {}),
    },
    parsed: parsePage(html, PAGE),
    options: {},
  } as unknown as RuleContext;
  const checks = cspViolationsRule.run(ctx as RuleContext);
  if (checks instanceof Promise) throw new Error("rule is synchronous");
  expect(checks.checks).toHaveLength(1);
  return checks.checks[0]!;
}

// A booking widget injected as a <script> after hydration, from a host script-src leaves out.
const WIDGET_LOADS = [
  {
    url: "https://widget.bookingvendor.example.com/embed.js",
    kind: "script" as const,
    from: "https://www.example.com/assets/app.js",
  },
  { url: "https://www.example.com/assets/app.js", kind: "script" as const },
];
const WIDGET_CSP_BROKEN = "default-src 'self'; script-src 'self'";
const WIDGET_CSP_FIXED =
  "default-src 'self'; script-src 'self' https://widget.bookingvendor.example.com";

// An Ads-linked GA4 property: the tag posts to three collect endpoints, connect-src allows one host.
const GTAG_LOADS = [
  {
    url: "https://www.googletagmanager.com/gtag/js?id=G-ABC1234567",
    kind: "script" as const,
  },
  {
    url: "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC1234567&cid=1.2",
    kind: "connect" as const,
  },
  {
    url: "https://analytics.google.com/g/collect?v=2&tid=G-ABC1234567&cid=1.2",
    kind: "connect" as const,
  },
  {
    url: "https://www.google.com/g/collect?v=2&tid=G-ABC1234567&cid=1.2",
    kind: "connect" as const,
  },
  {
    url: "https://stats.g.doubleclick.net/g/collect?v=2&tid=G-ABC1234567",
    kind: "connect" as const,
  },
];
const GTAG_CSP_BROKEN =
  "default-src 'self'; script-src 'self' https://www.googletagmanager.com; connect-src 'self' https://www.google-analytics.com";
const GTAG_CSP_FIXED =
  "default-src 'self'; script-src 'self' https://www.googletagmanager.com; connect-src 'self' https://www.google-analytics.com https://analytics.google.com https://www.google.com https://stats.g.doubleclick.net";

describe("security/csp-violations", () => {
  test("is registered in the security category", () => {
    expect(securityRules).toContain(cspViolationsRule);
    expect(cspViolationsRule.meta.id).toBe("security/csp-violations");
    expect(cspViolationsRule.meta.scope).toBe("page");
  });

  test("a script injected after load from a host script-src omits: one finding naming the host and script-src-elem", () => {
    const check = run({
      runtime: {
        cspViolations: browserBlocks(WIDGET_CSP_BROKEN, WIDGET_LOADS),
      },
    });
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    const item = check.items![0]!;
    expect(item.meta?.directive).toBe("script-src-elem");
    expect(item.meta?.host).toBe("widget.bookingvendor.example.com");
    expect(item.label).toContain("script-src-elem");
    expect(item.label).toContain(
      "add https://widget.bookingvendor.example.com to script-src-elem"
    );
    expect(item.snippet).toBe("from https://www.example.com/assets/app.js:12");
    expect(check.message).toContain("widget.bookingvendor.example.com");
  });

  test("an Ads-linked gtag page with connect-src limited to www.google-analytics.com: an error listing the blocked /g/collect endpoints", () => {
    const check = run({
      runtime: { cspViolations: browserBlocks(GTAG_CSP_BROKEN, GTAG_LOADS) },
    });
    expect(check.status).toBe("fail");
    const blocked = (check.items ?? []).map((i) => ({
      directive: i.meta?.directive,
      host: i.meta?.host,
      endpoints: i.meta?.endpoints,
      category: i.meta?.category,
    }));
    expect(blocked).toEqual([
      {
        directive: "connect-src",
        host: "analytics.google.com",
        endpoints: ["analytics.google.com/g/collect"],
        category: "analytics",
      },
      {
        directive: "connect-src",
        host: "www.google.com",
        endpoints: ["www.google.com/g/collect"],
        category: "analytics",
      },
      {
        directive: "connect-src",
        host: "stats.g.doubleclick.net",
        endpoints: ["stats.g.doubleclick.net/g/collect"],
        category: "ads",
      },
    ]);
    for (const item of check.items ?? []) {
      expect(item.label).toContain("/g/collect");
      // The query carries visitor and property ids: never printed.
      expect(item.label).not.toContain("cid=");
    }
  });

  test("the same pages with a corrected policy pass", () => {
    for (const [csp, loads] of [
      [WIDGET_CSP_FIXED, WIDGET_LOADS],
      [GTAG_CSP_FIXED, GTAG_LOADS],
    ] as const) {
      const violations = browserBlocks(csp, [...loads]);
      expect(violations).toEqual([]);
      expect(run({ runtime: { cspViolations: violations } }).status).toBe(
        "pass"
      );
    }
  });

  test("an HTTP-only (non-rendered) page skips with a reason that says a render is needed", () => {
    const check = run({
      rendered: false,
      runtime: { cspViolations: browserBlocks(GTAG_CSP_BROKEN, GTAG_LOADS) },
    });
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("not rendered in a browser");
    expect(check.skipReason).toContain("--render");
  });

  test("a rendered page whose renderer did not record CSP violations is a coded gap, never a pass", () => {
    expect(run({}).skipReason).toBe(RUNTIME_NOT_RECORDED_SKIP_REASON);
    // Runtime from a renderer that records errors but does not listen for violations.
    const partial = run({ runtime: { pageErrors: [] } });
    expect(partial.status).toBe("skipped");
    expect(partial.skipReason).toBe(RUNTIME_NOT_RECORDED_SKIP_REASON);
  });

  test("a report-only violation blocked nothing and is not reported", () => {
    const violations = browserBlocks(GTAG_CSP_BROKEN, GTAG_LOADS).map((v) => ({
      ...v,
      disposition: "report" as const,
    }));
    expect(run({ runtime: { cspViolations: violations } }).status).toBe("pass");
  });

  test("repeated blocks of one host under one directive are one item with a count", () => {
    const one = browserBlocks(WIDGET_CSP_BROKEN, WIDGET_LOADS)[0]!;
    const check = run({
      runtime: {
        cspViolations: [
          one,
          {
            ...one,
            blockedURI: "https://widget.bookingvendor.example.com/v2/frame.js",
          },
          one,
        ],
      },
    });
    expect(check.items).toHaveLength(1);
    expect(check.items![0]!.meta?.count).toBe(3);
    expect(check.items![0]!.meta?.endpoints).toEqual([
      "widget.bookingvendor.example.com/embed.js",
      "widget.bookingvendor.example.com/v2/frame.js",
    ]);
  });

  test("blocked inline code is reported with nonce or hash advice, never 'unsafe-inline'", () => {
    const check = run({
      runtime: {
        cspViolations: [
          {
            effectiveDirective: "script-src-elem",
            blockedURI: "inline",
            disposition: "enforce",
          },
        ],
      },
    });
    expect(check.status).toBe("warn");
    expect(check.items![0]!.meta?.blocked).toBe("inline");
    expect(check.items![0]!.label).toContain("nonce or hash");
    expect(check.items![0]!.label).not.toContain("unsafe-inline");
  });

  test("malformed entries are ignored: bad directive, prototype-key blockedURI, non-http scheme", () => {
    const check = run({
      runtime: {
        cspViolations: [
          {
            effectiveDirective: "script-src<b>",
            blockedURI: "https://a.example.com/x.js",
          },
          { effectiveDirective: "script-src-elem", blockedURI: "constructor" },
          { effectiveDirective: "script-src-elem", blockedURI: "__proto__" },
          {
            effectiveDirective: "img-src",
            blockedURI: "ftp://files.example.com/a.png",
          },
          null as unknown as RenderCspViolation,
        ],
      },
    });
    expect(check.status).toBe("pass");
  });
});
