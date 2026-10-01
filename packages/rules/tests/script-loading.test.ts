// Module, nomodule and non-JS scripts are not blocking (#424).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { parseHTML } from "@squirrelscan/parser/dom";

import { criticalRequestChainsRule } from "../src/performance/critical-request-chains";
import { scriptLoading } from "../src/performance/cwv";
import { inpHintsRule } from "../src/performance/inp-hints";
import { renderBlockingRule } from "../src/performance/render-blocking";
import type { CheckResult, Rule, RuleContext } from "../src/types";

const URL = "https://example.com/";

const THIRD_PARTY_SRCS = [
  "https://www.googletagmanager.com/gtm.js?id=GTM-XXXX",
  "https://connect.facebook.net/en_US/fbevents.js",
  "https://static.hotjar.com/c/hotjar-1.js",
  "https://cdn.segment.com/analytics.js/v1/x/analytics.min.js",
  "https://js.hs-scripts.com/1.js",
  "https://widget.intercom.io/widget/x",
];

function makeCtx(head: string): RuleContext {
  const html = `<!doctype html><html><head><title>scripts</title>${head}</head><body><h1>Test</h1></body></html>`;
  const parsed = parsePage(html, URL);
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
  };
}

function check(rule: Rule, ctx: RuleContext, name: string): CheckResult {
  const { checks } = rule.run(ctx) as { checks: CheckResult[] };
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no ${name} check`);
  return found;
}

function loadingOf(tag: string): string {
  const { document } = parseHTML(`<html><head>${tag}</head><body></body></html>`);
  const script = document.querySelector("script");
  if (!script) throw new Error("no script");
  return scriptLoading(script);
}

describe("scriptLoading", () => {
  test("classic scripts block unless async or defer", () => {
    expect(loadingOf(`<script src="/a.js"></script>`)).toBe("blocking");
    expect(loadingOf(`<script type="" src="/a.js"></script>`)).toBe("blocking");
    expect(loadingOf(`<script type="text/javascript" src="/a.js"></script>`)).toBe("blocking");
    expect(loadingOf(`<script type="Application/JavaScript" src="/a.js"></script>`)).toBe(
      "blocking",
    );
    expect(loadingOf(`<script language="javascript" src="/a.js"></script>`)).toBe("blocking");
    expect(loadingOf(`<script src="/a.js" async></script>`)).toBe("async");
    expect(loadingOf(`<script src="/a.js" defer></script>`)).toBe("defer");
    expect(loadingOf(`<script src="/a.js" async defer></script>`)).toBe("async");
  });

  test("module scripts defer by default and ignore defer and nomodule", () => {
    expect(loadingOf(`<script type="module" src="/a.js"></script>`)).toBe("defer");
    expect(loadingOf(`<script type=" MODULE " src="/a.js"></script>`)).toBe("defer");
    expect(loadingOf(`<script type="module" src="/a.js" defer></script>`)).toBe("defer");
    expect(loadingOf(`<script type="module" src="/a.js" async></script>`)).toBe("async");
    expect(loadingOf(`<script type="module" src="/a.js" async defer></script>`)).toBe("async");
    expect(loadingOf(`<script type="module" src="/a.js" nomodule></script>`)).toBe("defer");
  });

  test("only type is stripped, and only of ASCII whitespace", () => {
    expect(loadingOf(`<script type=" text/javascript\n" src="/a.js"></script>`)).toBe("blocking");
    expect(loadingOf(`<script type="&#160;text/javascript&#160;" src="/a.js"></script>`)).toBe(
      "inert",
    );
    expect(loadingOf(`<script type=" " src="/a.js"></script>`)).toBe("inert");
    expect(loadingOf(`<script language="javascript " src="/a.js"></script>`)).toBe("inert");
    expect(loadingOf(`<script type="" language="vbscript" src="/a.js"></script>`)).toBe(
      "blocking",
    );
    expect(loadingOf(`<script type="text/javascript; charset=utf-8" src="/a.js"></script>`)).toBe(
      "inert",
    );
  });

  test("nomodule and non-JS types never run in a modern browser", () => {
    expect(loadingOf(`<script nomodule src="/legacy.js"></script>`)).toBe("inert");
    expect(loadingOf(`<script type="text/plain" src="/gated.js"></script>`)).toBe("inert");
    expect(loadingOf(`<script type="text/partytown" src="/worker.js"></script>`)).toBe("inert");
    expect(loadingOf(`<script language="vbscript" src="/a.vbs"></script>`)).toBe("inert");
  });
});

describe("perf rules treat type=module as non-blocking (#424)", () => {
  const stylesheet = `<link rel="stylesheet" href="/style.css">`;
  const moduleHead =
    stylesheet + THIRD_PARTY_SRCS.map((src) => `<script type="module" src="${src}"></script>`).join("");
  const classicHead =
    stylesheet + THIRD_PARTY_SRCS.map((src) => `<script src="${src}"></script>`).join("");

  test("perf/inp-hints counts module scripts as deferred", () => {
    const c = check(inpHintsRule, makeCtx(moduleHead), "inp-blocking-scripts");
    expect(c.status).toBe("pass");
    expect(c.details).toEqual({ async: 0, defer: 6, blocking: 0 });
  });

  test("perf/inp-hints still flags classic blocking scripts", () => {
    const c = check(inpHintsRule, makeCtx(classicHead), "inp-blocking-scripts");
    expect(c.status).toBe("warn");
    expect(c.message).toBe("6 blocking scripts (consider async/defer)");
  });

  test("perf/inp-hints third-party count is unchanged by script type", () => {
    const c = check(inpHintsRule, makeCtx(moduleHead), "inp-third-party");
    expect(c.status).toBe("warn");
    expect(c.items).toHaveLength(6);
  });

  test("perf/render-blocking lists only the stylesheet next to module scripts", () => {
    const c = check(renderBlockingRule, makeCtx(moduleHead), "render-blocking");
    expect(c.status).toBe("info");
    expect(c.items).toEqual([{ id: "/style.css" }]);
  });

  test("perf/render-blocking still counts classic scripts", () => {
    const c = check(renderBlockingRule, makeCtx(classicHead), "render-blocking");
    expect(c.status).toBe("warn");
    expect(c.items).toHaveLength(7);
  });

  test("perf/render-blocking skips nomodule and text/plain scripts", () => {
    const head = `<script nomodule src="/legacy.js"></script><script type="text/plain" src="/gated.js"></script>`;
    const c = check(renderBlockingRule, makeCtx(head), "render-blocking");
    expect(c.status).toBe("pass");
  });

  test("perf/critical-request-chains agrees with the shared classification", () => {
    const head = `<script type="MODULE" src="/m.js"></script><script nomodule src="/legacy.js"></script><script src="/app.js"></script>`;
    const c = check(criticalRequestChainsRule, makeCtx(head), "critical-request-chains");
    expect(c.details?.blockingJs).toBe(1);
  });

  test("an empty src blocks nothing in any of the three rules", () => {
    const ctx = makeCtx(`<script src=""></script>`);
    expect(check(renderBlockingRule, ctx, "render-blocking").status).toBe("pass");
    expect(check(inpHintsRule, ctx, "inp-blocking-scripts").details).toEqual({
      async: 0,
      defer: 0,
      blocking: 0,
    });
    expect(check(criticalRequestChainsRule, ctx, "critical-request-chains").status).toBe("pass");
  });
});
