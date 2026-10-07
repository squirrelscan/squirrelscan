// content/placeholder-contact - Template-default contact details in production.
//
// A phone number from the reserved fictional ranges, an address at example.com,
// "123 Main St" and @yourhandle are what a theme ships so the contact block has
// something in it. Left in place they are a conversion bug (nobody can reach the
// business) and a trust signal (the page looks abandoned).
//
// Every one of these strings is also something a developer docs page prints on
// purpose, so the page type decides the verdict: a contact or checkout page FAILS,
// anywhere else WARNS, and a documentation page or a code sample is not judged.
//
// Precedence against eeat/contact-page and eeat/physical-address: this rule only
// ever reports a placeholder that IS on the page. It never reports an absent
// contact method, which stays with the eeat rules (and neither of those reads
// visible text), so one missing real address cannot be reported twice.

import type { CheckItem } from "@squirrelscan/core-contracts";
import { getPathname } from "@squirrelscan/utils";
import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";

import { getRenderedProseText, isInsideCodeOrUnrendered } from "./text-content";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export type PlaceholderContactKind = "email" | "phone" | "address" | "social";

export interface PlaceholderContactFinding {
  kind: PlaceholderContactKind;
  /** Distinct matched strings, deduped, in first-seen order. */
  samples: string[];
  /** Total occurrences, including repeats of the same sample. */
  count: number;
}

/* -------------------------------------------------------------------------- */
/* Patterns                                                                   */
/* -------------------------------------------------------------------------- */

// None of these carry nested or adjacent unbounded quantifiers: every run is a
// bounded class or a literal, so matching is linear in the page text.

/**
 * RFC 2606 reserved domains plus the usual theme defaults. The trailing guard is
 * `(?!\.?[\w-])`, not `(?![\w-])`, so `user@example.com.au` is a real address
 * while `write to user@example.com.` (end of a sentence) is still a match.
 */
const EMAIL_RE =
  /(?<![\w.%+-])(?:[\w.%+-]{1,64}@(?:[a-z0-9-]{1,63}\.)?(?:example\.(?:com|org|net)|test\.com|yourdomain\.com)|email@email\.com)(?!\.?[\w-])/gi;

/**
 * US 555-0100 to 555-0199 (the range reserved for fiction), UK Ofcom drama range
 * 07700 900000 to 900999 in national and +44 form, and a run of ten zeros.
 */
const PHONE_RES: readonly RegExp[] = [
  /(?<!\d)555[\s.-]?01\d{2}(?!\d)/g,
  /(?<!\d)(?:\+44[\s-]?\(?0?\)?[\s-]?|0)7700[\s-]?900[\s-]?\d{3}(?!\d)/g,
  /(?<!\d)0{3}[\s.-]?0{3}[\s.-]?0{4}(?!\d)/g,
];

/** Template street, locality and zip lines. */
const ADDRESS_RES: readonly RegExp[] = [
  /(?<!\d)123 Main (?:St(?:reet)?|Ave(?:nue)?|Rd|Road)\b/gi,
  /(?<!\d)\d{1,5} Street Address\b/gi,
  /\bCity, State,? (?:Zip(?: Code)?|\d{5}(?:-\d{4})?)(?![\w-])/gi,
];

/** `@yourhandle` as prose. The lookbehind keeps `user@username.com` out. */
const HANDLE_RE = /(?<![\w@.])@(?:yourhandle|your_handle|yourusername|username)(?![\w-])/gi;

/** A social profile URL whose path is the theme's placeholder. */
const SOCIAL_HREF_RE =
  /(?:^|[/.])(?:facebook|twitter|x|instagram|linkedin|tiktok|youtube|pinterest)\.com\/(?:(?:company|in|user)\/|@)?(?:yourpage|yourhandle|yourusername|username|yourname|yourcompany)(?:[/?#]|$)/i;

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

const MAX_SAMPLES = 5;

function collect(
  kind: PlaceholderContactKind,
  text: string,
  patterns: readonly RegExp[],
): PlaceholderContactFinding | undefined {
  const hits: string[] = [];
  for (const re of patterns) for (const m of text.matchAll(re)) hits.push(m[0].trim());
  if (hits.length === 0) return undefined;
  return { kind, samples: [...new Set(hits)].slice(0, MAX_SAMPLES), count: hits.length };
}

/**
 * Every placeholder contact detail in `text` (visible prose) and `hrefs` (the
 * `href` of each anchor that is not inside a code sample). `mailto:` and `tel:`
 * targets are judged as emails and phone numbers, so a theme's
 * `<a href="mailto:info@example.com">Email us</a>` is caught even when the link
 * text is something else.
 */
export function findPlaceholderContacts(
  text: string,
  hrefs: readonly string[] = [],
): PlaceholderContactFinding[] {
  const prose = text.replace(/[^\S\n]+/g, " ");
  const targets: string[] = [];
  const socialHits: string[] = [];
  for (const href of hrefs) {
    if (/^(?:mailto|tel):/i.test(href)) {
      let decoded = href.replace(/^(?:mailto|tel):/i, "").split("?")[0]!;
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        // A malformed escape is judged as written.
      }
      targets.push(decoded);
    } else if (SOCIAL_HREF_RE.test(href)) {
      socialHits.push(href);
    }
  }
  const all = [prose, ...targets].join("\n");

  const handles = collect("social", prose, [HANDLE_RE]);
  const social: PlaceholderContactFinding | undefined =
    socialHits.length === 0
      ? handles
      : {
          kind: "social",
          samples: [...new Set([...(handles?.samples ?? []), ...socialHits])].slice(0, MAX_SAMPLES),
          count: (handles?.count ?? 0) + socialHits.length,
        };

  return [
    collect("email", all, [EMAIL_RE]),
    collect("phone", all, PHONE_RES),
    collect("address", prose, ADDRESS_RES),
    social,
  ].filter((f): f is PlaceholderContactFinding => f !== undefined);
}

/* -------------------------------------------------------------------------- */
/* Page type                                                                  */
/* -------------------------------------------------------------------------- */

/** A page a visitor uses to reach the business or pay it. */
const CHECKOUT_PATH_RE = /\/(?:checkout|cart|basket|payment|billing|order)(?:\/|\.html?)?$/i;

/** Developer and help documentation, where these strings are samples. */
const DOCS_PATH_RE =
  /\/(?:docs?|documentation|developers?|dev|api|reference|guides?|tutorials?|learn|sdk|examples?)(?:\/|$)/i;

export type ContactPageWeight = "critical" | "docs" | "standard";

export function classifyContactPage(url: string, pageType?: string): ContactPageWeight {
  const path = getPathname(url);
  if (
    pageType === "contact" ||
    EEAT_PAGE_PATTERNS.contact.some((p) => p.test(path)) ||
    CHECKOUT_PATH_RE.test(path)
  ) {
    return "critical";
  }
  if (DOCS_PATH_RE.test(path)) return "docs";
  return "standard";
}

const KIND_LABELS: Record<PlaceholderContactKind, string> = {
  email: "placeholder email address",
  phone: "placeholder phone number",
  address: "placeholder postal address",
  social: "placeholder social handle",
};

const MAX_SAMPLE_CHARS = 60;

const truncate = (s: string): string =>
  s.length <= MAX_SAMPLE_CHARS ? s : `${s.slice(0, MAX_SAMPLE_CHARS - 1)}…`;

export const placeholderContactRule: Rule = {
  meta: {
    id: "content/placeholder-contact",
    name: "Placeholder Contact Details",
    description: "Detects template-default emails, phone numbers, addresses and social handles",
    solution:
      "Replace every template-default contact detail with a real one, or remove the block. A fake phone number or an address at example.com on a contact or checkout page means customers cannot reach the business, and it reads as an abandoned site to visitors and search engines. Check the footer, the contact page, schema.org markup and any mailto: or tel: links, since themes repeat the same default in all of them. If the page is documentation that shows these values as samples, keep them in a code block.",
    category: "content",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) {
      checks.push({
        name: "placeholder-contact",
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }

    const body = doc.querySelector("body");
    if (!body) {
      checks.push({
        name: "placeholder-contact",
        status: "skipped",
        message: "No body element to read visible text from",
        skipReason: "no-body",
      });
      return { checks };
    }

    const weight = classifyContactPage(ctx.page.url, ctx.parsed.pageType);
    if (weight === "docs") {
      checks.push({
        name: "placeholder-contact",
        status: "skipped",
        message: "Documentation page: placeholder contact details are samples here",
        skipReason: "documentation-page",
      });
      return { checks };
    }

    const hrefs: string[] = [];
    for (const a of body.querySelectorAll("a[href]")) {
      if (isInsideCodeOrUnrendered(a)) continue;
      const href = a.getAttribute("href");
      if (href) hrefs.push(href.trim());
    }

    const found = findPlaceholderContacts(getRenderedProseText(body), hrefs);
    if (found.length === 0) {
      checks.push({
        name: "placeholder-contact",
        status: "pass",
        message: "No placeholder contact details in visible text or links",
      });
      return { checks };
    }

    const total = found.reduce((sum, f) => sum + f.count, 0);
    const items: CheckItem[] = found.map((f) => ({
      id: f.kind,
      label: KIND_LABELS[f.kind],
      snippet: f.samples.map(truncate).join(" | "),
      meta: { count: f.count },
    }));

    checks.push({
      name: "placeholder-contact",
      status: weight === "critical" ? "fail" : "warn",
      message: `${total} placeholder contact detail(s)${
        weight === "critical" ? " on a contact or checkout page" : ""
      }: ${found.map((f) => `${KIND_LABELS[f.kind]} (${truncate(f.samples[0]!)})`).join(", ")}`,
      value: total,
      items,
      details: {
        pageWeight: weight,
        kinds: found.map((f) => ({ kind: f.kind, count: f.count, samples: f.samples })),
      },
    });
    return { checks };
  },
};
