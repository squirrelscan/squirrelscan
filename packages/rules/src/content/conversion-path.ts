// content/conversion-path - money pages whose only calls to action leave the site.
//
// A pricing, services or product page exists to convert. When every prominent
// button sends the visitor to a social profile and the page has no form, no
// mailto: or tel: link and no link to a contact, booking or checkout page, the
// lead leaves the site and attribution goes with it. An off-site booking or
// checkout tool (Calendly, Stripe Checkout) is a real conversion path, so it is
// only noted.
//
// Money pages are found from the URL path and from schema.org types. The CLI
// page-type classifier is deliberately not used: its pricing, service and
// product classes are not certified yet.

import { getPathname } from "@squirrelscan/utils";
import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";
import {
  CHECK_NOT_APPLICABLE_SKIP_REASON,
  SCAN_TRUNCATED_SKIP_REASON,
} from "@squirrelscan/core-contracts/resolution";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import { htmlReadState } from "../shared/structured-nodes";

const CHECK = "conversion-path";

/** `/pricing`, `/plans`, `/services/web-design`, `/products/widget`, localised forms excluded on purpose. */
const MONEY_PATH_RE =
  /\/(?:pricing|prices|plans|packages|services?|products?|solutions)(?:\/[^/]{1,128}){0,2}\/?$/i;

/** Editorial and help content that mentions pricing without selling on the page. */
const EDITORIAL_PATH_RE =
  /\/(?:blog|news|articles?|posts?|press|docs?|documentation|help|support|learn|guides?|changelog|stories|case-studies)(?:\/|$)/i;

const MONEY_SCHEMA_TYPES = ["Product", "Offer", "AggregateOffer", "Service"] as const;
const EDITORIAL_SCHEMA_TYPES = ["Article", "BlogPosting", "NewsArticle", "TechArticle"] as const;

const SOCIAL_HOSTS = [
  "linkedin.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "threads.net",
  "bsky.app",
  "t.me",
  "wa.me",
  "discord.gg",
  "discord.com",
];

const BOOKING_HOSTS = [
  "calendly.com",
  "cal.com",
  "savvycal.com",
  "tidycal.com",
  "youcanbook.me",
  "acuityscheduling.com",
  "meetings.hubspot.com",
  "checkout.stripe.com",
  "buy.stripe.com",
  "book.stripe.com",
  "paypal.com",
  "gumroad.com",
  "lemonsqueezy.com",
  "paddle.com",
  "fastspring.com",
  "typeform.com",
];

/** Same-site paths that are a conversion path in themselves. */
const ONSITE_PATH_RES: readonly RegExp[] = [
  ...EEAT_PAGE_PATTERNS.contact,
  /\/(?:contact|book|booking|schedule|demo|quote|get-a-quote|checkout|cart|buy|order|enquir(?:y|e)|inquiry)(?:[-/][^/]{0,64})?\/?$/i,
];

const CTA_CLASS_RE = /(?:^|[\s_-])(?:btn|button|cta)(?:$|[\s_-])/i;
const MAX_CTAS = 200;
const MAX_LINKS = 2000;
const MAX_SAMPLES = 5;

const hostMatches = (host: string, list: readonly string[]): boolean =>
  list.some((h) => host === h || host.endsWith(`.${h}`));

const bareHost = (host: string): string => host.toLowerCase().replace(/^www\./, "");

function parseHref(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

export function isMoneyPage(url: string, schemaTypes: readonly string[]): boolean {
  const path = getPathname(url);
  if (EDITORIAL_PATH_RE.test(path)) return false;
  if (schemaTypes.some((t) => (EDITORIAL_SCHEMA_TYPES as readonly string[]).includes(t))) {
    return false;
  }
  return (
    MONEY_PATH_RE.test(path) ||
    schemaTypes.some((t) => (MONEY_SCHEMA_TYPES as readonly string[]).includes(t))
  );
}

type CtaKind = "onsite" | "social" | "booking" | "other";

function classify(target: URL, pageHost: string): CtaKind {
  const host = bareHost(target.hostname);
  if (host === pageHost || host.endsWith(`.${pageHost}`)) return "onsite";
  if (hostMatches(host, SOCIAL_HOSTS)) return "social";
  if (hostMatches(host, BOOKING_HOSTS)) return "booking";
  return "other";
}

function isButtonStyled(el: Element): boolean {
  if (el.getAttribute("role")?.toLowerCase() === "button") return true;
  if (CTA_CLASS_RE.test(el.getAttribute("class") ?? "")) return true;
  return el.closest("button") !== null;
}

/** The main content region, or the body without site chrome when there is none. */
function inChrome(el: Element): boolean {
  return el.closest("header, nav, footer, aside") !== null;
}

export const conversionPathRule: Rule = {
  meta: {
    id: "content/conversion-path",
    name: "Money Page Conversion Path",
    description:
      "Detects pricing, service and product pages whose only calls to action leave the site",
    solution:
      "Give the page a way to convert on your own site: a contact or enquiry form, a mailto: or tel: link, or a link to a contact, booking or checkout page. Calls to action that open a personal social profile send the lead off-site, and your analytics and attribution lose them. An embedded or linked booking tool such as Calendly or Stripe Checkout is fine; keep it, and consider also offering a form or an email address.",
    category: "content",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
    skipOnSoft404: true,
    // Check names by outcome class (#1741). The booking-tool info is an advisory problem; a page read
    // in part with no call to action found is an inconclusive info, a skip to resolution.
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CHECK, outcome: "clean", clears: [CHECK] },
      { name: CHECK, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) {
      checks.push({
        name: CHECK,
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }

    let body: Element | null = null;
    try {
      body = doc.querySelector("body");
    } catch {
      body = null;
    }
    if (!body) {
      checks.push({
        name: CHECK,
        status: "skipped",
        message: "No body element to read links from",
        skipReason: "no-body",
      });
      return { checks };
    }

    const schemaTypes = ctx.parsed.schemas?.types ?? [];
    // JSON-LD past the cut of a page read in part may make it a money page (or an editorial one), so
    // "not a money page" is only a verdict when the page was read whole or the path already settles it.
    const readState = htmlReadState(ctx);
    if (!isMoneyPage(ctx.page.url, schemaTypes)) {
      if (readState !== "complete" && !EDITORIAL_PATH_RE.test(getPathname(ctx.page.url))) {
        checks.push({
          name: CHECK,
          status: "skipped",
          message:
            "Not judged: the page was not read completely and its schema types may sit past the cut",
          skipReason: SCAN_TRUNCATED_SKIP_REASON,
          details: { foldKey: SCAN_TRUNCATED_SKIP_REASON, readState },
        });
        return { checks };
      }
      checks.push({
        name: CHECK,
        status: "skipped",
        message: "Not a pricing, service or product page",
        skipReason: CHECK_NOT_APPLICABLE_SKIP_REASON,
        details: { foldKey: CHECK_NOT_APPLICABLE_SKIP_REASON },
      });
      return { checks };
    }

    let pageHost: string;
    try {
      pageHost = bareHost(new URL(ctx.page.url).hostname);
    } catch {
      checks.push({
        name: CHECK,
        status: "skipped",
        message: "Page URL could not be parsed",
        skipReason: "bad-url",
      });
      return { checks };
    }

    // A form that is only site search is not a way to convert.
    let hasForm = false;
    for (const form of body.querySelectorAll("form")) {
      if (form.getAttribute("role")?.toLowerCase() === "search") continue;
      if (form.querySelector('input[type="search"]') && !form.querySelector("textarea, select")) {
        continue;
      }
      hasForm = true;
      break;
    }

    let hasDirectContact = false;
    let hasOnsitePath = false;
    const ctaKinds: { kind: CtaKind; host: string }[] = [];
    let seen = 0;
    let linkCapHit = false;
    for (const a of body.querySelectorAll("a[href]")) {
      if (++seen > MAX_LINKS) {
        linkCapHit = true;
        break;
      }
      const href = (a.getAttribute("href") ?? "").trim();
      if (!href) continue;
      if (/^(?:mailto|tel):/i.test(href)) {
        hasDirectContact = true;
        continue;
      }
      const target = parseHref(href, ctx.page.url);
      if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) continue;
      const kind = classify(target, pageHost);
      if (kind === "onsite" && ONSITE_PATH_RES.some((re) => re.test(target.pathname))) {
        hasOnsitePath = true;
      }
      if (ctaKinds.length < MAX_CTAS && isButtonStyled(a) && !inChrome(a)) {
        ctaKinds.push({ kind, host: bareHost(target.hostname) });
      }
    }

    const details = {
      ctaCount: ctaKinds.length,
      hasForm,
      hasDirectContact,
      hasOnsitePath,
    };

    if (ctaKinds.length === 0 && htmlReadState(ctx) !== "complete") {
      // The calls to action may sit past the cut of a page read in part, so it was not judged and a
      // stored finding on it stays open (#1031).
      checks.push({
        name: CHECK,
        status: "info",
        message: "Calls to action not checked: the page was not read completely",
        details: { ...details, inconclusive: true },
      });
      return { checks };
    }

    if (ctaKinds.length === 0 && linkCapHit) {
      // The scan stopped at its link cap: a call to action may sit past it, so this is a gap.
      checks.push({
        name: CHECK,
        status: "skipped",
        message: `Calls to action not checked: the page has more than ${MAX_LINKS} links and none of the first ${MAX_LINKS} was a call to action`,
        skipReason: SCAN_TRUNCATED_SKIP_REASON,
        details: { ...details, foldKey: SCAN_TRUNCATED_SKIP_REASON, linkCap: MAX_LINKS },
      });
      return { checks };
    }

    if (ctaKinds.length === 0) {
      checks.push({
        name: CHECK,
        status: "pass",
        message: "No prominent call-to-action links to judge",
        details,
      });
      return { checks };
    }

    if (hasForm || hasDirectContact || hasOnsitePath || ctaKinds.some((c) => c.kind === "onsite")) {
      checks.push({
        name: CHECK,
        status: "pass",
        message: "Page has a conversion path on the site",
        details,
      });
      return { checks };
    }

    const hosts = [...new Set(ctaKinds.map((c) => c.host))].slice(0, MAX_SAMPLES);
    const booking = ctaKinds.some((c) => c.kind === "booking");
    if (booking) {
      checks.push({
        name: CHECK,
        status: "info",
        message: `The only conversion path is off-site, to a booking or checkout tool (${hosts.join(", ")})`,
        details: { ...details, hosts },
      });
      return { checks };
    }

    if (ctaKinds.every((c) => c.kind === "social")) {
      checks.push({
        name: CHECK,
        status: "warn",
        message: `Every prominent call to action (${ctaKinds.length}) leaves the site for a social profile (${hosts.join(", ")}), and the page has no form, mailto:, tel: or contact, booking or checkout link`,
        value: ctaKinds.length,
        details: { ...details, hosts },
      });
      return { checks };
    }

    checks.push({
      name: CHECK,
      status: "pass",
      message: "Calls to action lead to a site or tool that is not a social profile",
      details: { ...details, hosts },
    });
    return { checks };
  },
};
