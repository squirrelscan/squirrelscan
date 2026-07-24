// ax/token-weight - per-page raw-HTML token estimate + text-to-HTML ratio

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Below this, a page is almost certainly a redirect, error stub, or otherwise
// too small to say anything meaningful about its content-to-markup ratio.
const MIN_HTML_BYTES = 1_024;
// Vercel's Agent Readability spec budget line: below this, an agent is paying
// mostly for markup/scripts/styles to reach a small amount of usable content.
const MIN_TEXT_RATIO = 0.15;
// Generous single-page fetch budget before a page is flatly too heavy for an agent's context.
const MAX_ESTIMATED_TOKENS = 100_000;
// Rough bytes-per-token heuristic for raw (non-tokenizer-specific) HTML — good
// enough to flag order-of-magnitude bloat, not meant to match any one model's tokenizer.
const BYTES_PER_TOKEN = 4;

export const tokenWeightRule: Rule = {
  meta: {
    id: "ax/token-weight",
    name: "Token Weight",
    description:
      "Estimates the LLM token cost of a page's raw HTML and reports the text-to-HTML ratio — how much of that cost is actual content versus markup, scripts, and styles",
    solution:
      "Strip or externalize inline <script>/<style> blocks, avoid deeply nested wrapper divs and long utility-class strings on content-bearing elements, and serve lean server-rendered markup rather than a client framework's verbose hydration output — especially on content pages. Consider Markdown content negotiation, which sidesteps the ratio problem by removing HTML markup from the response entirely.",
    category: "ax",
    scope: "page",
    severity: "warning",
    weight: 2,
    // A soft-404 error shell's token/ratio numbers describe the error template,
    // not a real page — skip rather than report misleading bloat (#1174).
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    // No parsed DOM (4xx/5xx) or too small to be a real content page — skip
    // rather than false-positive on a redirect stub or tiny error page.
    const htmlBytes = new TextEncoder().encode(ctx.page.html).length;
    if (!ctx.parsed.document || htmlBytes < MIN_HTML_BYTES) {
      checks.push({
        name: "token-weight",
        status: "skipped",
        message: "Page too small (or not a real content page) to assess token weight",
        skipReason: "below minimum size",
      });
      return { checks };
    }

    const ratio = ctx.parsed.content.textToHtmlRatio;
    const ratioPct = Math.round(ratio * 100);
    // bytes/4 heuristic: a rough stand-in for a real tokenizer, fine for flagging bloat at a glance.
    const estimatedTokens = Math.round(htmlBytes / BYTES_PER_TOKEN);

    if (ratio < MIN_TEXT_RATIO) {
      // Keep the warn message free of per-page numbers: report grouping merges
      // same-named checks by normalized message, and differing digits collapse
      // the shared headline to a literal "N". The per-page ratio lives in the
      // explicit item instead.
      checks.push({
        name: "token-weight-ratio",
        status: "warn",
        message:
          "Visible text is under 15% of the page HTML — agents pay token cost mostly for markup, scripts, and styles",
        value: ratioPct,
        expected: Math.round(MIN_TEXT_RATIO * 100),
        items: [
          {
            id: ctx.page.url,
            label: `~${ratioPct}% of HTML is visible text (~${estimatedTokens.toLocaleString()} est. tokens)`,
          },
        ],
        details: { textLength: ctx.parsed.content.textLength, htmlLength: ctx.parsed.content.htmlLength },
      });
    } else {
      checks.push({
        name: "token-weight-ratio",
        status: "pass",
        message: `~${ratioPct}% of this page's HTML is visible text, above the 15% floor`,
        value: ratioPct,
        details: { textLength: ctx.parsed.content.textLength, htmlLength: ctx.parsed.content.htmlLength },
      });
    }

    if (estimatedTokens > MAX_ESTIMATED_TOKENS) {
      // Number-free message for the same grouping reason as above.
      checks.push({
        name: "token-weight-budget",
        status: "warn",
        message:
          "Raw HTML exceeds a generous 100,000-token budget for a single page fetch — too heavy for an agent's context window",
        value: estimatedTokens,
        expected: MAX_ESTIMATED_TOKENS,
        items: [
          {
            id: ctx.page.url,
            label: `~${estimatedTokens.toLocaleString()} estimated tokens (${htmlBytes.toLocaleString()} bytes)`,
          },
        ],
        details: { htmlBytes },
      });
    } else {
      checks.push({
        name: "token-weight-budget",
        status: "pass",
        message: `~${estimatedTokens.toLocaleString()} estimated tokens (${htmlBytes.toLocaleString()} bytes), within budget`,
        value: estimatedTokens,
        details: { htmlBytes },
      });
    }

    return { checks };
  },
};
