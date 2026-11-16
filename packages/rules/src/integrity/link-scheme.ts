// integrity/link-scheme - the site sells or arranges links, or paid links lack
// rel=sponsored (cloud-backed, repo#3003).
//
// Keywords alone cannot tell a link broker from an SEO blog that explains
// backlinks, so the rule is two-stage. Locally, `collectLinkSchemeCandidate`
// picks pages whose text mentions link exchanges, paid guest posts, link
// insertion or write-for-us offers, and packages their outbound links with
// their `rel`. A cloud LLM call judges those pages; this rule turns the verdict
// into a check and verifies the `rel` of the links the model called paid
// against the parsed page itself, so the model never decides what a link says.

import type { CheckResult, LinkSchemeLink, LinkSchemePagePayload, LinkSchemeResult } from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

/** Phrases that make a page worth a cloud judgement. A hit is a candidate, never a finding. */
export const LINK_SCHEME_PATTERNS: readonly RegExp[] = [
  /\blink (?:exchange|swap|insertion|placement|building service)s?\b/i,
  /\b(?:backlink|back-link) (?:exchange|swap|marketplace|placement)s?\b/i,
  /\b(?:buy|sell|purchase|order) (?:backlinks?|links?|guest posts?|sponsored posts?)\b/i,
  /\bpaid (?:links?|guest posts?|link placements?|posts?)\b/i,
  /\bguest posts? (?:for sale|service|opportunit(?:y|ies)|submissions?)\b/i,
  /\bsponsored posts?\b/i,
  /\bwrite for us\b/i,
  /\bniche edits?\b/i,
];

const MAX_EXCERPT_CHARS = 6000;
const MAX_LINKS = 100;
const LINK_SCHEME_SERVICE = "link-scheme";

/** The local half: a payload for a page that mentions link schemes, or null. */
export function collectLinkSchemeCandidate(ctx: RuleContext): LinkSchemePagePayload | null {
  const text = ctx.parsed.content?.textContent ?? "";
  if (!LINK_SCHEME_PATTERNS.some((re) => re.test(text))) return null;
  const links: LinkSchemeLink[] = [];
  for (const link of ctx.parsed.links ?? []) {
    if (link.isInternal || links.length >= MAX_LINKS) continue;
    links.push({ href: link.url, text: link.text || undefined, rel: link.rel ?? [] });
  }
  return {
    url: ctx.page.url,
    title: ctx.parsed.meta.title?.trim() || undefined,
    textExcerpt: text.slice(0, MAX_EXCERPT_CHARS),
    links,
  };
}

/** A link that passes no ranking credit: rel carries sponsored or nofollow. */
function isQualified(link: { rel?: string[]; isNofollow?: boolean }): boolean {
  if (link.isNofollow) return true;
  return (link.rel ?? []).some((t) => {
    const token = t.toLowerCase();
    return token === "sponsored" || token === "nofollow";
  });
}

export const linkSchemeRule: Rule = {
  meta: {
    id: "integrity/link-scheme",
    name: "Link Scheme",
    description:
      "AI judgement of whether a page sells or arranges links, or whether paid outbound links lack rel=sponsored or nofollow",
    solution:
      "Google's spam policies treat buying, selling and exchanging links that pass ranking credit as link spam. Remove the link-exchange or paid-placement offer, or keep it and mark every paid, sponsored or exchanged outbound link rel=\"sponsored\" (or rel=\"nofollow\"). Writing about backlinks is fine and is not flagged.",
    category: "integrity",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
    skipOnSoft404: true,
    cloud: { service: LINK_SCHEME_SERVICE, unit: "page", creditFeature: "llm_rules_page" },
    checks: [
      { name: "link-scheme", outcome: "problem" },
      { name: "link-scheme", outcome: "clean", clears: ["link-scheme"] },
      { name: "link-scheme", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    // Pages with no link-scheme wording are never sent, so there is nothing to judge.
    if (!collectLinkSchemeCandidate(ctx)) {
      checks.push({
        name: "link-scheme",
        status: "pass",
        message: "No link exchange or paid link wording on this page",
        pageUrl: ctx.page.url,
      });
      return { checks };
    }

    const envelope = readCloudResult<LinkSchemeResult>(ctx.cloudResults, LINK_SCHEME_SERVICE, ctx.page.url);
    if (!envelope || envelope.status === "skipped" || !envelope.data) {
      const reason = envelope?.status === "skipped" ? (envelope.skipReason ?? "not-prefetched") : "not-prefetched";
      checks.push({
        name: "link-scheme",
        status: "skipped",
        message: "Link scheme analysis skipped",
        pageUrl: ctx.page.url,
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    const { verdict, paidLinks, evidence } = envelope.data;
    const paid = new Set(paidLinks);
    const unqualified = (ctx.parsed.links ?? []).filter((l) => !l.isInternal && paid.has(l.url) && !isQualified(l));

    if (verdict === "sells-or-arranges") {
      checks.push({
        name: "link-scheme",
        status: "warn",
        message: "This page sells or arranges links",
        pageUrl: ctx.page.url,
        details: { verdict, evidence },
        items: unqualified.map((l, i) => ({ id: `link-${i}`, label: l.url })),
      });
    } else if (unqualified.length > 0) {
      checks.push({
        name: "link-scheme",
        status: "warn",
        message: `${unqualified.length} paid or sponsored outbound link(s) lack rel="sponsored" or rel="nofollow"`,
        pageUrl: ctx.page.url,
        details: { verdict, evidence },
        items: unqualified.map((l, i) => ({ id: `link-${i}`, label: l.url })),
      });
    } else {
      checks.push({
        name: "link-scheme",
        status: "pass",
        message:
          verdict === "writes-about"
            ? "The page discusses backlinks without selling or arranging them"
            : "No link scheme found on this page",
        pageUrl: ctx.page.url,
      });
    }
    return { checks };
  },
};
