// ax/content-without-js - flag main content that only exists after JS (invisible to raw-HTML agents)

import type { RenderResultItem } from "@squirrelscan/core-contracts";
import { extractContent, parseDocument } from "@squirrelscan/parser";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

// Only assess pages whose rendered DOM carries meaningful content.
const MIN_RENDERED_WORDS = 200;
// Absolute floor of JS-only words before a gap is worth surfacing.
const MIN_JS_ONLY_WORDS = 100;
// Flag when raw HTML covers at most this fraction of the rendered content.
const MAX_RAW_COVERAGE = 0.6;

export const contentWithoutJsRule: Rule = {
  meta: {
    id: "ax/content-without-js",
    name: "Content Without JavaScript",
    description:
      "Flags significant main content that only appears in the JS-rendered DOM — invisible to agents that read raw HTML",
    solution:
      "Many AI agents and crawlers read your raw HTML without executing JavaScript, so content injected client-side is invisible to them. Server-render or pre-render your primary content (SSR/SSG), or ship it in the initial HTML, so it's present before JS runs. This is a recommendation, not a penalty — interactive enhancements can stay client-side; only the core content an agent needs to understand the page should be in the raw HTML.",
    category: "ax",
    scope: "page",
    severity: "info",
    weight: 2,
    // On a soft-404, raw and rendered are both the error shell — the raw-vs-JS
    // content diff is meaningless, so skip (#1174).
    skipOnSoft404: true,
    cloud: { service: "render", unit: "page", creditFeature: "render" },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    // Design wrinkle (#673): this rule diffs the raw crawl HTML (ctx.parsed) against the cloud-rendered
    // DOM, which is ONLY meaningful when the crawl fetched RAW HTML. On a browser-rendered crawl,
    // ctx.parsed IS the rendered DOM, so raw==rendered — the comparison is self-identical (it would always
    // read "pass", masking real JS-gated content). Skip cleanly. (The render service isn't even prefetched
    // on a rendered crawl — see cloud-prefetch's crawlRendered gate — but guard here too for correctness.)
    if (ctx.page.rendered) {
      checks.push({
        name: "content-without-js",
        status: "skipped",
        message: "Raw-vs-rendered content comparison skipped",
        skipReason:
          "The crawl browser-rendered this page, so its raw and rendered HTML are identical — run a raw (non-rendered) audit to assess JS-gated content",
      });
      return { checks };
    }

    // Render is a cloud service — absent on CLI-only / non-rendered audits.
    const envelope = readCloudResult<RenderResultItem>(ctx.cloudResults, "render", ctx.page.url);
    if (!envelope || envelope.status === "skipped") {
      const reason = envelope?.skipReason ?? "not-prefetched";
      checks.push({
        name: "content-without-js",
        status: "skipped",
        message: "Raw-vs-rendered content comparison skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    // Service responded but this page produced no rendered HTML (nav timeout / JS crash / 404).
    const renderedHtml = envelope.data?.html;
    if (!renderedHtml) {
      checks.push({
        name: "content-without-js",
        status: "skipped",
        message: "No rendered HTML returned for this page",
        skipReason: humanizeCloudSkip("render-failed"),
      });
      return { checks };
    }

    // Same extraction pipeline as ctx.parsed.content, so raw vs rendered compare like-for-like.
    const rawWords = ctx.parsed.content.wordCount;
    const renderedWords = extractContent(parseDocument(renderedHtml), renderedHtml).wordCount;
    const jsOnlyWords = Math.max(0, renderedWords - rawWords);
    // Clamp coverage to [0,1]: raw can exceed rendered (e.g. noscript stripped on render).
    const rawCoverage = renderedWords > 0 ? Math.min(1, rawWords / renderedWords) : 1;
    const jsOnlyPct = Math.round((1 - rawCoverage) * 100);
    const details = { rawWords, renderedWords, jsOnlyWords, jsOnlyPct };

    const contentGatedByJs =
      renderedWords >= MIN_RENDERED_WORDS &&
      jsOnlyWords >= MIN_JS_ONLY_WORDS &&
      rawCoverage <= MAX_RAW_COVERAGE;

    if (contentGatedByJs) {
      checks.push({
        name: "content-without-js",
        status: "info",
        message: `~${jsOnlyPct}% of this page's content (${jsOnlyWords} words) appears only after JavaScript runs — agents that read raw HTML won't see it`,
        value: renderedWords,
        details,
      });
      return { checks };
    }

    checks.push({
      name: "content-without-js",
      status: "pass",
      message: "Raw HTML already contains the bulk of the rendered content",
      value: renderedWords,
      details,
    });
    return { checks };
  },
};
