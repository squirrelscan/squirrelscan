// content/cross-page-contradictions - the site contradicts itself (cloud, opt-in LLM rule pack)
//
// A language model reads a bounded sample of pages and extracts structured claims (prices, plan
// names, phone numbers, hours, shipping and returns terms, guarantees, headcount, founding year).
// That is all it does. Whether two claims contradict is decided here, by `findContradictions`,
// with no model involved: precision matters far more than recall, because a false "your pricing
// is inconsistent" costs more credibility than a missed one.
//
// A contradiction needs the same claim in the same context: same type, same subject, same
// context (currency, billing period, region), a different normalised value, stated on different
// pages. Everything that could be a legitimate difference is left out.

import type { PageClaim, PageClaimsResponse, PageClaimType } from "@squirrelscan/core-contracts";

import type { CheckItem } from "@squirrelscan/core-contracts";

import { humanizeCloudSkip, readCloudResult } from "../cloud";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** Claims below this extraction confidence never vote. */
export const CLAIM_MIN_CONFIDENCE = 0.8;

/** Contradictions listed as items. */
const MAX_ITEMS = 25;

export interface Contradiction {
  type: PageClaimType;
  subject: string;
  context: string;
  a: PageClaim;
  b: PageClaim;
}

const collapse = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Phone numbers compare by their last 9 digits, so a country code, a trunk `0` or a `00`
 * prefix never makes one number look like two. It errs toward agreeing: two numbers that
 * differ only in a country code are not reported.
 */
function normalisePhone(value: string): string | null {
  const digits = value.replace(/\D+/g, "");
  return digits.length >= 7 ? digits.slice(-9) : null;
}

/** A money amount compares by number. Thousands separators and decimal marks are both handled. */
function normaliseAmount(value: string): string | null {
  const m = value.match(/\d[\d.,\s]*/);
  if (!m) return null;
  let n = m[0].trim().replace(/\s+/g, "");
  const lastComma = n.lastIndexOf(",");
  const lastDot = n.lastIndexOf(".");
  const decimalAt = Math.max(lastComma, lastDot);
  // A trailing group of exactly 1-2 digits after the last separator is the decimal part.
  const tail = decimalAt >= 0 ? n.slice(decimalAt + 1) : "";
  if (decimalAt >= 0 && tail.length <= 2) {
    n = `${n.slice(0, decimalAt).replace(/[.,]/g, "")}.${tail}`;
  } else {
    n = n.replace(/[.,]/g, "");
  }
  const num = Number(n);
  return Number.isFinite(num) ? String(num) : null;
}

/** A plain count or year (headcount, founding year). */
function normaliseNumber(value: string): string | null {
  const m = value.replace(/[,\s]/g, "").match(/\d+/);
  return m ? String(Number(m[0])) : null;
}

/** The comparison value, or null when the claim cannot be compared safely (then it never votes). */
export function normaliseClaimValue(type: PageClaimType, value: string): string | null {
  switch (type) {
    case "phone":
      return normalisePhone(value);
    case "price":
      return normaliseAmount(value);
    case "headcount":
    case "founded":
      return normaliseNumber(value);
    default: {
      const v = collapse(value).replace(/[.!]+$/, "");
      return v.length > 0 ? v : null;
    }
  }
}

interface Voter {
  claim: PageClaim;
  norm: string;
}

/**
 * Deterministic conflict detection over a fixed claim set. Exported for the unit tests.
 *
 * Voting claims: confidence at least {@link CLAIM_MIN_CONFIDENCE}, a non-empty subject, a
 * non-empty verbatim quote, a value that normalises. Claims are grouped by type, subject and
 * context. A group is a contradiction only when it has two or more distinct normalised values
 * AND no single page states more than one of them (a page that lists two values has two
 * legitimate figures, such as a sale price beside the old one, and the group is dropped).
 * `plan` and `shipping`/`returns`/`guarantee` values are free text and compare after collapsing
 * case and whitespace.
 */
export function findContradictions(claims: readonly PageClaim[]): Contradiction[] {
  const groups = new Map<string, Voter[]>();
  for (const claim of claims) {
    if (claim.confidence < CLAIM_MIN_CONFIDENCE) continue;
    const subject = collapse(claim.subject);
    if (!subject || !claim.quote.trim() || !claim.url) continue;
    const norm = normaliseClaimValue(claim.type, claim.value);
    if (norm === null) continue;
    const key = `${claim.type}\u0000${subject}\u0000${collapse(claim.context)}`;
    const list = groups.get(key) ?? [];
    list.push({ claim, norm });
    groups.set(key, list);
  }

  const out: Contradiction[] = [];
  for (const voters of groups.values()) {
    const valuesByUrl = new Map<string, Set<string>>();
    for (const v of voters) {
      const set = valuesByUrl.get(v.claim.url) ?? new Set<string>();
      set.add(v.norm);
      valuesByUrl.set(v.claim.url, set);
    }
    if ([...valuesByUrl.values()].some((s) => s.size > 1)) continue;

    const byValue = new Map<string, Voter>();
    for (const v of voters) if (!byValue.has(v.norm)) byValue.set(v.norm, v);
    if (byValue.size < 2) continue;

    // Deterministic pair: the two values sorted by (url, value), first claim of each.
    const pair = [...byValue.values()].sort(
      (x, y) => x.claim.url.localeCompare(y.claim.url) || x.norm.localeCompare(y.norm),
    );
    const [a, b] = pair as [Voter, Voter];
    out.push({
      type: a.claim.type,
      subject: collapse(a.claim.subject),
      context: collapse(a.claim.context),
      a: a.claim,
      b: b.claim,
    });
  }

  return out.sort(
    (x, y) =>
      x.type.localeCompare(y.type) ||
      x.subject.localeCompare(y.subject) ||
      x.context.localeCompare(y.context),
  );
}

const describe = (c: Contradiction): string =>
  `${c.type}: ${c.subject}${c.context ? ` (${c.context})` : ""}`;

export const crossPageContradictionsRule: Rule = {
  meta: {
    id: "content/cross-page-contradictions",
    name: "Cross-Page Contradictions",
    description:
      "Finds claims the site states two ways on different pages: a price, phone number, opening hours or policy that does not agree with itself",
    solution:
      "Decide which value is right and make every page say it, ideally from one shared source " +
      "(a single pricing component, one contact record). A reader or an agent that meets two " +
      "figures cannot tell which one is real and may quote the wrong one to a customer.",
    category: "content",
    scope: "site",
    severity: "warning",
    weight: 4,
    // Opt-in LLM rule pack (+2 credits per page evaluated), off by default, cloud only.
    optIn: true,
    cloud: { service: "page-claims", unit: "site", creditFeature: "llm_rules_page" },
  },

  run(ctx: RuleContext): RuleResult {
    const envelope = readCloudResult<PageClaimsResponse>(ctx.cloudResults, "page-claims");
    if (!envelope || envelope.status === "skipped" || !envelope.data) {
      const reason =
        envelope?.status === "skipped" ? (envelope.skipReason ?? "not-prefetched") : "not-prefetched";
      return {
        checks: [
          {
            name: "cross-page-contradictions",
            status: "skipped",
            message: "Cross-page contradiction check skipped",
            skipReason: humanizeCloudSkip(reason),
          },
        ],
      };
    }

    const { claims, pagesSampled } = envelope.data;
    const found = findContradictions(claims);

    if (found.length === 0) {
      return {
        checks: [
          {
            name: "cross-page-contradictions",
            status: "pass",
            message: `No contradicting claims across ${pagesSampled} sampled page(s)`,
            details: { pagesSampled, claimsRead: claims.length },
          },
        ],
      };
    }

    const items: CheckItem[] = found.slice(0, MAX_ITEMS).map((c) => ({
      id: `${c.type}:${c.subject}:${c.context}`,
      label: describe(c),
      sourcePages: [c.a.url, c.b.url],
      snippet: `${c.a.url}: "${c.a.quote}" | ${c.b.url}: "${c.b.quote}"`,
    }));

    const check: CheckResult = {
      name: "cross-page-contradictions",
      status: "warn",
      message: `${found.length} claim${found.length === 1 ? "" : "s"} contradict${found.length === 1 ? "s" : ""} another page of the site. Decide which value is right and make every page agree.`,
      value: found.length,
      items,
      details: {
        pagesSampled,
        contradictions: found.map((c) => ({
          type: c.type,
          subject: c.subject,
          context: c.context,
          first: { url: c.a.url, quote: c.a.quote },
          second: { url: c.b.url, quote: c.b.quote },
        })),
      },
    };
    return { checks: [check] };
  },
};
