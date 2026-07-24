// ax/markdown-response - does the site serve Markdown via negotiation or a .md variant

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const markdownResponseRule: Rule = {
  meta: {
    id: "ax/markdown-response",
    name: "Markdown Response",
    description:
      "Checks whether the site serves text/markdown via content negotiation (Accept: text/markdown) or exposes a .md variant of the homepage — agents increasingly prefer clean Markdown over rendered HTML",
    solution:
      "Agents and answer engines parse Markdown more reliably than rendered HTML. Serve a Markdown representation of your key pages: honor `Accept: text/markdown` via content negotiation, and/or publish a `.md` variant (e.g. /index.md). This is a recommendation only — it never affects your score.",
    category: "ax",
    scope: "site",
    severity: "info",
    weight: 1,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const md = ctx.site?.markdownResponse;

    if (!md) {
      checks.push({ name: "markdown-response", status: "info", message: "markdown probe data not available" });
      return { checks };
    }

    const signals: string[] = [];
    if (md.servesMarkdown) signals.push(`content negotiation (${md.negotiatedContentType})`);
    if (md.mdVariantExists) signals.push(`.md variant (${md.mdVariantUrl})`);
    // A `Link: rel="alternate"; type="text/markdown"` header is a first-class
    // way to serve Markdown: it advertises a machine-discoverable twin even
    // when the homepage itself renders HTML (e.g. an app shell whose content
    // pages carry the header). Without this, a site that does everything right
    // except expose /index.md is scored as absent.
    if (md.alternateMarkdownUrl) signals.push(`link rel=alternate (${md.alternateMarkdownUrl})`);

    if (signals.length > 0) {
      checks.push({
        name: "markdown-response",
        status: "info",
        message: `Serves Markdown for agents via ${signals.join(" and ")}`,
        value: "available",
        details: {
          servesMarkdown: md.servesMarkdown,
          negotiatedContentType: md.negotiatedContentType,
          mdVariantExists: md.mdVariantExists,
          mdVariantUrl: md.mdVariantUrl,
          alternateMarkdownUrl: md.alternateMarkdownUrl,
        },
      });
    } else {
      // warn-status in an info-severity rule surfaces as a Recommendation in
      // the report issues list; advisory scoring keeps it score-neutral.
      checks.push({
        name: "markdown-response",
        status: "warn",
        message:
          "No Markdown response — consider honoring Accept: text/markdown or publishing a .md variant so agents get clean content",
        value: "absent",
        details: {
          negotiatedContentType: md.negotiatedContentType,
          mdVariantContentType: md.mdVariantContentType,
        },
      });
    }

    const headerSignals: string[] = [];
    if (md.negotiatedVary && /accept/i.test(md.negotiatedVary)) {
      headerSignals.push(`Vary: ${md.negotiatedVary}`);
    }
    if (md.markdownTokensHeader && md.originalTokensHeader) {
      const mdTokens = Number(md.markdownTokensHeader);
      const origTokens = Number(md.originalTokensHeader);
      const pct =
        Number.isFinite(mdTokens) && Number.isFinite(origTokens) && origTokens > 0
          ? Math.round((mdTokens / origTokens) * 100)
          : null;
      headerSignals.push(
        `Cloudflare markdown-transform fingerprint (x-markdown-tokens: ${md.markdownTokensHeader}, x-original-tokens: ${md.originalTokensHeader}${
          pct !== null ? `, ~${pct}% of original` : ""
        })`,
      );
    }
    // alternateMarkdownUrl is reported as a primary signal above, so it is not
    // repeated here; Vary + the Cloudflare token fingerprint are the remaining
    // supplementary signals.

    if (headerSignals.length > 0) {
      checks.push({
        name: "markdown-response-headers",
        status: "info",
        message: `Additional Markdown-negotiation signals: ${headerSignals.join("; ")}`,
        value: "present",
        details: {
          negotiatedVary: md.negotiatedVary ?? null,
          markdownTokensHeader: md.markdownTokensHeader ?? null,
          originalTokensHeader: md.originalTokensHeader ?? null,
        },
      });
    }

    return { checks };
  },
};
