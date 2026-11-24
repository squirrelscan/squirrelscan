// security/card-fields-third-party - Card inputs in the page's own document
// alongside third-party scripts (pub#2088).
//
// Any script in a document can read what is typed into that document's inputs.
// A card skimmer injected through a third-party script (a tag manager, an A/B
// testing snippet, a chat widget) reads card numbers typed into the site's own
// fields, but not those typed into a payment provider's cross-origin iframe.
// This rule reads the HTML the audit fetched: a card form a script builds after
// load is not seen, and fields inside an iframe are never in this document.

import type { CheckItem } from "@squirrelscan/core-contracts";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import {
  buildLabelIndex,
  fieldSelector,
  fieldSnippet,
  inputType,
  isDataField,
  type LabelIndex,
  parseAutocomplete,
  segmentsOf,
} from "../shared/form-fields";
import {
  formatScriptHosts,
  scriptHostDetails,
  thirdPartyScriptHosts,
} from "./third-party-script-hosts";

/** Input types a card number can be typed into. */
const CARD_INPUT_TYPES = new Set(["text", "tel", "number", "password"]);

/**
 * Segment runs that name a card number in a field's name, id or placeholder.
 * Matched as consecutive segments, never substrings, so `discard_note` is not a
 * card field.
 */
const CARD_NUMBER_SEQS: readonly (readonly string[])[] = [
  ["card", "number"],
  ["cardnumber"],
  ["card", "num"],
  ["card", "no"],
  ["cardno"],
  ["cc", "number"],
  ["ccnumber"],
  ["cc", "num"],
  ["ccnum"],
  ["ccno"],
  ["credit", "card"],
  ["creditcard"],
  ["debit", "card"],
  ["debitcard"],
];

/**
 * Words that make a "card number" something other than a payment card: a gift
 * card, voucher, loyalty or membership card, or a search box. A field that
 * declares `autocomplete="cc-number"` is a payment card whatever it is named.
 */
const NON_PAYMENT_SEGMENTS = new Set([
  "gift",
  "giftcard",
  "voucher",
  "coupon",
  "promo",
  "discount",
  "redeem",
  "loyalty",
  "reward",
  "rewards",
  "member",
  "membership",
  "club",
  "library",
  "points",
  "bonus",
  "search",
]);

const MAX_ITEMS = 20;

function containsSequence(
  haystack: readonly string[],
  needle: readonly string[]
): boolean {
  if (needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Text that says what kind of card a field is for: its own attributes and its
 * labels. Used only to rule a field OUT (a gift or loyalty card), never to
 * identify one. The form's own name is left out on purpose: a membership
 * signup form takes real card payments.
 */
function contextSegments(el: Element, labels: LabelIndex): string[] {
  const texts: (string | null | undefined)[] = [
    el.getAttribute("name"),
    el.getAttribute("id"),
    el.getAttribute("placeholder"),
    el.getAttribute("aria-label"),
    el.closest("label")?.textContent,
  ];
  const id = el.getAttribute("id");
  if (id) texts.push(labels.get(id));
  return texts.flatMap((t) => (t ? segmentsOf(t.slice(0, 200)) : []));
}

/** How a field was identified as a card number, or null when it is not one. */
function cardNumberEvidence(el: Element, labels: LabelIndex): string | null {
  if (!isDataField(el)) return null;
  if (el.tagName.toLowerCase() !== "input") return null;
  if (!CARD_INPUT_TYPES.has(inputType(el))) return null;
  if (el.closest('[role="search" i], search')) return null;

  const autocomplete = el.getAttribute("autocomplete");
  if (autocomplete !== null) {
    const parsed = parseAutocomplete(autocomplete);
    if (parsed.kind === "field") {
      return parsed.token === "cc-number" ? 'autocomplete="cc-number"' : null;
    }
  }

  for (const attr of ["name", "id", "placeholder"] as const) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const segments = segmentsOf(value.slice(0, 200));
    if (!CARD_NUMBER_SEQS.some((seq) => containsSequence(segments, seq)))
      continue;
    if (contextSegments(el, labels).some((s) => NON_PAYMENT_SEGMENTS.has(s)))
      return null;
    return `${attr}="${value.slice(0, 80)}"`;
  }
  return null;
}

export const cardFieldsThirdPartyRule: Rule = {
  meta: {
    id: "security/card-fields-third-party",
    name: "Card fields and third-party scripts",
    description:
      "Checks for card number fields in the page's own document on a page that loads third-party scripts",
    solution:
      "Any script running in a document can read what is typed into that document's inputs, so a compromised or malicious third-party script (a tag manager, A/B testing snippet, chat or analytics tag) can skim card numbers typed into the site's own fields. A payment provider's hosted fields or hosted checkout (Stripe Elements or Checkout, Adyen, Braintree Hosted Fields and similar) put the card inputs in a cross-origin iframe that page scripts cannot read. Move card entry into the provider's hosted fields, or remove every third-party script from the payment page. This rule reads the HTML the audit fetched: a card form that JavaScript builds after the page loads is not seen by a local audit.",
    category: "security",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 6,
    checks: [
      { name: "card-fields-third-party", outcome: "problem" },
      {
        name: "card-fields-third-party",
        outcome: "clean",
        clears: ["card-fields-third-party"],
      },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const labels = buildLabelIndex(doc);
    const cardFields: { el: Element; evidence: string }[] = [];
    for (const el of querySelectorAllOutsideNoscript(doc, "input")) {
      const evidence = cardNumberEvidence(el, labels);
      if (evidence) cardFields.push({ el, evidence });
    }
    // No card field in this document. Info, not pass: a pass would lift the
    // score of every page for a risk it does not have. Moving card entry into
    // a provider's hosted iframe removes the field, so a fixed page lands here.
    if (cardFields.length === 0) {
      return {
        checks: [
          {
            name: "card-fields-third-party",
            status: "info",
            message: "No card number field in this page's own document",
            details: { cardFields: 0 },
          },
        ],
      };
    }

    const pageUrl = ctx.page.finalUrl || ctx.page.url;
    const hosts = thirdPartyScriptHosts(doc, pageUrl);
    const checks: CheckResult[] = [];

    if (hosts.length === 0) {
      checks.push({
        name: "card-fields-third-party",
        status: "pass",
        message:
          "Card number fields are in this page's own document, and no third-party script loads on it",
        details: { cardFields: cardFields.length },
      });
      return { checks };
    }

    const hostList = formatScriptHosts(hosts);
    const items: CheckItem[] = cardFields.slice(0, MAX_ITEMS).map((f) => ({
      id: fieldSelector(f.el),
      label: `Card number field ${fieldSelector(f.el)} (${f.evidence}) can be read by scripts from ${hostList}`,
      snippet: fieldSnippet(f.el, 240),
      meta: { evidence: f.evidence, ...scriptHostDetails(hosts) },
    }));
    checks.push({
      name: "card-fields-third-party",
      status: "warn",
      message: `${cardFields.length} card number field(s) in this page's own document, which loads third-party scripts from ${hostList}: any script in the document can read what is typed. Use the payment provider's hosted fields, or remove third-party scripts from this page`,
      items,
      details: {
        cardFields: cardFields.length,
        ...scriptHostDetails(hosts),
      },
    });
    return { checks };
  },
};
