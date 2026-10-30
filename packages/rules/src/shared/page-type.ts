// The page classifier's label as a rule input (pub#841).
//
// Some verdicts only make sense for pages people search for: a thin-content floor, a
// snippet-length floor. A contact or legal page is short on purpose. The classifier labels
// such pages (`ParsedPage.classification.pageType`), so a rule can leave them out.
//
// The trust rule is the one `schema/expected-type` uses: only a MODEL label at or above the
// confidence bar counts. The rules fallback labels a page from its own JSON-LD or og:type, so a
// rules-sourced label is circular or a low-confidence default and never changes a verdict.

import {
  CHECK_NOT_APPLICABLE_SKIP_REASON,
  PAGE_TYPE_SKIP_REASON,
} from "@squirrelscan/core-contracts/resolution";

import type { CheckResult, ParsedPage } from "../types";

/** Minimum classifier confidence before a page type changes a verdict. */
export const PAGE_TYPE_TRUST_CONFIDENCE = 0.9;

/**
 * The page's type, only when the model gave it with enough confidence. `null` for no
 * classification, a rules label, a low confidence, or a missing or NaN confidence.
 */
export function trustedPageType(
  parsed: ParsedPage | null | undefined,
  minConfidence: number = PAGE_TYPE_TRUST_CONFIDENCE,
): string | null {
  const pageType = parsed?.classification?.pageType;
  if (!pageType || pageType.source !== "model") return null;
  // `!(x >= y)`, not `x < y`: a missing or NaN confidence must read as not confident.
  if (!(pageType.confidence >= minConfidence)) return null;
  return pageType.label;
}

// The label alone is a URL-and-title reading (a model reads `/privacy` and `/contact` from the
// path and the heading as much as from the body), so it is corroborated by the page body before it
// is allowed to relax a verdict (pub#841 review): a law-firm landing page at `/solutions/legal`, a
// marketing page at `/contact`, or a client-rendered shell at `/privacy` with no text is labelled
// legal or contact by the model, and skipping the thin-content floor there would hide a real finding
// and resolve an earlier one.

/** Phrases a policy text carries. A page needs {@link LEGAL_PHRASES_NEEDED} distinct ones. */
const LEGAL_PHRASES = [
  "privacy policy",
  "personal data",
  "personal information",
  "cookies",
  "terms of service",
  "terms of use",
  "terms and conditions",
  "governing law",
  "limitation of liability",
  "third parties",
  "third-party",
  "data controller",
  "data protection",
  "we collect",
  "you agree",
  "your rights",
  "gdpr",
  "intellectual property",
  "disclaimer",
  "warranty",
  "warranties",
  "last updated",
  "effective date",
  "indemnif",
  "arbitration",
  "refund policy",
  "acceptable use",
  // The same vocabulary in the languages the classifier's training sites most often use.
  "datenschutz",
  "personenbezogene",
  "nutzungsbedingungen",
  "allgemeine geschäftsbedingungen",
  "haftung",
  "données personnelles",
  "politique de confidentialité",
  "conditions générales",
  "mentions légales",
  "responsabilité",
  "datos personales",
  "política de privacidad",
  "términos y condiciones",
  "aviso legal",
  "responsabilidad",
  "dati personali",
  "informativa",
  "termini e condizioni",
  "dados pessoais",
  "política de privacidade",
  "termos de uso",
  "persoonsgegevens",
  "privacybeleid",
  "algemene voorwaarden",
] as const;
const LEGAL_PHRASES_NEEDED = 3;

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;
const PHONE = /\+?\d[\d\s().-]{6,}\d/;

/** A phone number has nine digits, or eight after a leading "+": a year range or a price is not one. */
function hasPhoneNumber(text: string): boolean {
  for (const match of text.matchAll(new RegExp(PHONE.source, "g"))) {
    const digits = match[0].replace(/\D/g, "").length;
    if (digits >= 9 || (match[0].startsWith("+") && digits >= 8)) return true;
  }
  return false;
}

/**
 * Whether the page body bears out a `contact` or `legal` label. A page with no text never does: a
 * client-rendered shell is judged by the rules like any other thin page. `contact` needs a way to
 * reach the organisation on the page (a `tel:` or `mailto:` link, an email address or phone number in
 * the text, or a message box); a newsletter field or a site search is not one. `legal` needs policy
 * vocabulary, not the word "legal".
 */
export function bodyCorroboratesPageType(parsed: ParsedPage | null | undefined, label: string): boolean {
  const content = parsed?.content;
  const text = (content?.textContent ?? "").toLowerCase();
  if (!parsed || !((content?.wordCount ?? 0) > 0) || text.length === 0) return false;
  if (label === "legal") {
    let found = 0;
    for (const phrase of LEGAL_PHRASES) {
      if (text.includes(phrase) && ++found >= LEGAL_PHRASES_NEEDED) return true;
    }
    return false;
  }
  if (label === "contact") {
    if ((parsed.contactLinks?.length ?? 0) > 0) return true;
    if (EMAIL.test(text) || hasPhoneNumber(text)) return true;
    return parsed.document?.querySelector("form textarea") != null;
  }
  return false;
}

/**
 * The page's type when it may relax a verdict: a trusted model label (see {@link trustedPageType})
 * in `types` that the page body bears out. `null` otherwise.
 */
export function skippablePageType(
  parsed: ParsedPage | null | undefined,
  types: readonly string[],
): string | null {
  const label = trustedPageType(parsed);
  if (label === null || !types.includes(label)) return null;
  return bodyCorroboratesPageType(parsed, label) ? label : null;
}

/**
 * The runner's skip for a rule left out of a page because of its type (`skipOnPageType`). It is
 * a rule-wide "does not apply" verdict like the noindex gate (`page-type`, keyed by the RULE in the
 * resolution signal), so the page reads as evaluated and clean for every check of the rule and a
 * finding from an earlier audit on it resolves. `skippedByType` counts the page so a report can say
 * why it was not judged; `pageType` names the label.
 */
export function pageTypeRuleSkip(ruleId: string, label: string, ruleName: string): CheckResult {
  return {
    name: ruleId,
    status: "skipped",
    message: `Skipped: ${ruleName} is not judged on a ${label.replace(/_/g, " ")} page`,
    skipReason: PAGE_TYPE_SKIP_REASON,
    details: { foldKey: PAGE_TYPE_SKIP_REASON, pageType: label, skippedByType: 1 },
  };
}

/**
 * The skip for ONE check a rule decided not to make on a page because of its type (a short title on
 * a contact page). `name` must be the check's real name, because the resolution signal keys a
 * per-check "does not apply" on `ruleId|checkName`; the page then reads as evaluated and clean for
 * that check only and its earlier finding resolves.
 */
export function pageTypeSkip(name: string, label: string, what: string): CheckResult {
  return {
    name,
    status: "skipped",
    message: `Skipped: ${what} is not judged on a ${label.replace(/_/g, " ")} page`,
    skipReason: CHECK_NOT_APPLICABLE_SKIP_REASON,
    details: { foldKey: CHECK_NOT_APPLICABLE_SKIP_REASON, pageType: label, skippedByType: 1 },
  };
}
