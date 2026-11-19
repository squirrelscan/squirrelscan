// ax/markdown-response - does the site serve Markdown via negotiation or a .md variant

import { STRICT_PROBE_UNANSWERED_SKIP_REASON } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { refusedCheck, refusedFor } from "../refused";

import { NOT_CHECKED, notCheckedCheck } from "./discovery-probe-state";

export const markdownResponseRule: Rule = {
  meta: {
    id: "ax/markdown-response",
    name: "Markdown Response",
    description:
      "Checks whether the site serves text/markdown via content negotiation (Accept: text/markdown) or exposes a .md variant of the homepage, and flags a server error on strict Markdown negotiation. Agents increasingly prefer clean Markdown over rendered HTML",
    solution:
      "Agents and answer engines parse Markdown more reliably than rendered HTML. Serve a Markdown representation of your key pages: honor `Accept: text/markdown` via content negotiation, and/or publish a `.md` variant (e.g. /index.md). Not serving Markdown is a recommendation only and never affects your score. A 5xx in answer to `Accept: text/markdown` does affect it: that breaks every agent that asks for Markdown. Return Markdown, fall back to HTML, or answer 406 Not Acceptable instead of erroring.",
    category: "ax",
    scope: "site",
    findingScope: "page",
    severity: "info",
    weight: 1,
    discoveryProbes: ["markdown"],
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const md = ctx.site?.markdownResponse;

    if (!md) {
      // A refused request is not an absent Markdown response.
      const refused = refusedFor(ctx.site, "markdown");
      checks.push(
        refused.length > 0
          ? refusedCheck("markdown-response", "Markdown response", refused, true)
          : notCheckedCheck("markdown-response", "Markdown response", undefined, "no-result"),
      );
      return { checks };
    }

    // A 5xx to strict `Accept: text/markdown` (what a Markdown-only agent
    // sends) is a defect, not an absent nice-to-have: it scores as a fail even in
    // this advisory rule (repo#1322). The probe only records it when the lenient
    // negotiation fetch was answered, so a site that is simply down never lands here.
    const strictStatus = md.strictNegotiatedStatus ?? null;
    let negotiationError: CheckResult | null = null;
    const negotiationDetails = {
      negotiatedUrl: md.negotiatedUrl,
      strictNegotiatedStatus: strictStatus,
      strictNegotiatedContentType: md.strictNegotiatedContentType ?? null,
      negotiatedStatus: md.negotiatedStatus ?? null,
      negotiatedContentType: md.negotiatedContentType,
    };
    if (strictStatus !== null && strictStatus >= 500 && strictStatus <= 599) {
      negotiationError = {
        name: "markdown-negotiation-error",
        status: "fail",
        message: `Homepage returns HTTP ${strictStatus} to Accept: text/markdown, so agents that negotiate Markdown get a server error instead of content`,
        value: strictStatus,
        expected: "2xx Markdown, an HTML fallback, or 406",
        details: negotiationDetails,
      };
    } else if (md.strictNegotiationAnswered === false) {
      // No answer to the strict request (refused, throttled, timed out, the probe
      // budget, or a 5xx on every Accept) is not a clean one: it may still 5xx. A
      // coded gap, so the check is listed as not checked and a stored finding of it
      // stays open instead of resolving (repo#1322).
      negotiationError = {
        name: "markdown-negotiation-error",
        status: "skipped",
        skipReason: STRICT_PROBE_UNANSWERED_SKIP_REASON,
        message:
          "Not checked: the homepage gave no answer to Accept: text/markdown (refused, throttled, timed out or out of probe budget), so a server error there cannot be ruled out",
        value: NOT_CHECKED,
        details: negotiationDetails,
      };
    } else if (md.strictNegotiationAnswered === true && strictStatus !== null) {
      // Answered without a server error: the verdict, as an info so this advisory
      // rule's score stays where it was for every healthy site.
      negotiationError = {
        name: "markdown-negotiation-error",
        status: "info",
        message: `Homepage answers Accept: text/markdown with HTTP ${strictStatus}, not a server error`,
        value: strictStatus,
        details: negotiationDetails,
      };
    }

    const negotiatedType = /markdown/i.test(md.negotiatedContentType ?? "")
      ? md.negotiatedContentType
      : (md.strictNegotiatedContentType ?? md.negotiatedContentType);
    const signals: string[] = [];
    if (md.servesMarkdown) signals.push(`content negotiation (${negotiatedType})`);
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
    } else if (md.mdVariantAnswered === false) {
      // `/index.md` got no answer, so an absent `.md` variant is not shown: say
      // not checked rather than "absent" (repo#1322).
      checks.push(
        notCheckedCheck(
          "markdown-response",
          "Markdown response",
          {
            negotiatedContentType: md.negotiatedContentType,
            negotiatedStatus: md.negotiatedStatus ?? null,
            mdVariantUrl: md.mdVariantUrl,
          },
          "no-answer",
        ),
      );
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
          negotiatedStatus: md.negotiatedStatus ?? null,
          strictNegotiatedStatus: md.strictNegotiatedStatus ?? null,
          mdVariantContentType: md.mdVariantContentType,
        },
      });
    }

    if (negotiationError) checks.push(negotiationError);

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
