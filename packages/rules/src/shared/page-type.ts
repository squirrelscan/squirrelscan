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

/** Whether the page's trusted type is one of `types`. */
export function isTrustedPageTypeIn(
  parsed: ParsedPage | null | undefined,
  types: readonly string[],
): boolean {
  const label = trustedPageType(parsed);
  return label !== null && types.includes(label);
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
