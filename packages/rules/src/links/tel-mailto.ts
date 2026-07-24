// links/tel-mailto - Tel and mailto link validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { CheckItem } from "@squirrelscan/core-contracts";

/** Digits-only phone number, for comparison (drops +, spaces, punctuation) */
function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

// Min shared digits for a trunk-prefix match — guards coincidental short matches.
const MIN_TRUNK_MATCH_DIGITS = 5;

/** Drop a single leading national trunk prefix (e.g. AU "04xx", UK "020"). */
function stripTrunkZero(digits: string): string {
  return digits.length > 1 && digits.startsWith("0") ? digits.slice(1) : digits;
}

// 1-digit calling codes (NANP "+1", Russia "+7") don't use a domestic "0" trunk prefix, so only 2-3 digit codes qualify (not exhaustive, e.g. Spain "+34" is also trunk-less — full accuracy needs a libphonenumber-scale dialing-plan table).
function isPlausibleCallingCodeLength(n: number): boolean {
  return n === 2 || n === 3;
}

/** Same number in href vs text? Exact/suffix match, or E.164 href vs national trunk-zero text. */
function phoneNumbersMatch(hrefPhone: string, text: string): boolean {
  const hrefDigits = normalizePhone(hrefPhone);
  const textDigits = normalizePhone(text);
  if (hrefDigits === textDigits) return true;
  if (hrefDigits.endsWith(textDigits) || textDigits.endsWith(hrefDigits)) {
    return true;
  }

  const hrefNsn = stripTrunkZero(hrefDigits);
  const textNsn = stripTrunkZero(textDigits);
  if (
    textNsn.length >= MIN_TRUNK_MATCH_DIGITS &&
    hrefDigits.endsWith(textNsn) &&
    isPlausibleCallingCodeLength(hrefDigits.length - textNsn.length)
  ) {
    return true;
  }
  if (
    hrefNsn.length >= MIN_TRUNK_MATCH_DIGITS &&
    textDigits.endsWith(hrefNsn) &&
    isPlausibleCallingCodeLength(textDigits.length - hrefNsn.length)
  ) {
    return true;
  }
  return false;
}

export const telMailtoRule: Rule = {
  meta: {
    id: "links/tel-mailto",
    name: "Tel & Mailto Links",
    description: "Validates tel: and mailto: link formats",
    solution:
      "Tel links should use format: tel:+1234567890 (E.164 format preferred, no spaces/dashes). Mailto links should have valid email format: mailto:user@example.com. You can add subject and body parameters: mailto:user@example.com?subject=Hi&body=Hello. Invalid formats may not work on all devices. Ensure the displayed text matches the href — a mismatched phone number or email misleads users and may dial/email the wrong contact.",
    category: "links",
    scope: "page",
    severity: "info",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const telLinks: string[] = [];
    const mailtoLinks: string[] = [];
    const invalidTel: string[] = [];
    const invalidMailto: string[] = [];
    const telMismatches: CheckItem[] = [];
    const mailtoMismatches: CheckItem[] = [];

    const links = doc.querySelectorAll("a[href]");

    for (const link of links) {
      const href = link.getAttribute("href") || "";

      if (href.startsWith("tel:")) {
        telLinks.push(href);
        const phone = href.replace("tel:", "");
        // Basic validation - should have digits
        if (!/[\d+]/.test(phone) || phone.length < 7) {
          invalidTel.push(href);
        }

        // Mismatch check (#694: E.164 href vs national trunk-zero text, e.g. +61414… vs 0414…, is NOT a mismatch)
        const text = link.textContent?.trim() || "";
        if (/\d{3,}/.test(text) && !phoneNumbersMatch(phone, text)) {
          telMismatches.push({
            id: href,
            label: `href "${phone}" ≠ text "${text}"`,
            snippet: link.outerHTML.slice(0, 200),
          });
        }
      }

      if (href.startsWith("mailto:")) {
        mailtoLinks.push(href);
        const email = href.replace("mailto:", "").split("?")[0];
        // Address-less "mailto:?subject=…&body=…" is a valid email-share
        // pattern (recipient fills in) — only validate when an address is
        // present.
        const isShareLink = email === "" && href.includes("?");
        // Basic email validation
        if (!isShareLink && (!email.includes("@") || !email.includes("."))) {
          invalidMailto.push(href);
        }

        // Check for href/text email mismatch
        const text = link.textContent?.trim() || "";
        if (/.+@.+\..+/.test(text) && text.toLowerCase() !== email.toLowerCase()) {
          mailtoMismatches.push({
            id: href,
            label: `href "${email}" ≠ text "${text}"`,
            snippet: link.outerHTML.slice(0, 200),
          });
        }
      }
    }

    // Report findings
    if (telLinks.length > 0) {
      if (invalidTel.length > 0) {
        checks.push({
          name: "tel-links",
          status: "warn",
          message: `${invalidTel.length}/${telLinks.length} tel: link(s) may be invalid`,
          value: invalidTel[0],
        });
      } else {
        checks.push({
          name: "tel-links",
          status: "pass",
          message: `${telLinks.length} tel: link(s) found`,
        });
      }
    }

    if (mailtoLinks.length > 0) {
      if (invalidMailto.length > 0) {
        checks.push({
          name: "mailto-links",
          status: "warn",
          message: `${invalidMailto.length}/${mailtoLinks.length} mailto: link(s) may be invalid`,
          value: invalidMailto[0],
        });
      } else {
        checks.push({
          name: "mailto-links",
          status: "pass",
          message: `${mailtoLinks.length} mailto: link(s) found`,
        });
      }
    }

    if (telMismatches.length > 0) {
      checks.push({
        name: "tel-mismatch",
        status: "warn",
        message: `${telMismatches.length} tel link(s) have mismatched phone number in href vs display text`,
        items: telMismatches,
      });
    }

    if (mailtoMismatches.length > 0) {
      checks.push({
        name: "mailto-mismatch",
        status: "warn",
        message: `${mailtoMismatches.length} mailto link(s) have mismatched email in href vs display text`,
        items: mailtoMismatches,
      });
    }

    if (telLinks.length === 0 && mailtoLinks.length === 0) {
      checks.push({
        name: "tel-mailto",
        status: "info",
        message: "No tel: or mailto: links found",
      });
    }

    return { checks };
  },
};
