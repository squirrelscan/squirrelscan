// links/tel-mailto - Tel and mailto link validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { CheckItem } from "@squirrelscan/core-contracts";
import { MAX_CONTACT_LINKS, makeLinkSectionResolver } from "@squirrelscan/parser";
import { decodeCloudflareEmail, isCloudflareEmailProtectionUrl } from "@squirrelscan/utils";

import {
  addSection,
  countSection,
  pageRegionsField,
  sectionMeta,
  withSection,
  type SectionCounts,
} from "./link-section-label";

/**
 * The address a Cloudflare email-protection anchor stands for (pub#811): the link's `#<hex>`, or a
 * `data-cfemail` on the anchor or inside it, decoded. "" when the payload is not an address.
 */
function obfuscatedAddress(anchor: Element, href: string): string {
  const hash = href.indexOf("#");
  const payload =
    (hash >= 0 ? href.slice(hash + 1) : "") ||
    anchor.getAttribute("data-cfemail") ||
    anchor.querySelector("[data-cfemail]")?.getAttribute("data-cfemail") ||
    "";
  const decoded = decodeCloudflareEmail(payload.trim());
  return decoded?.includes("@") ? decoded : "";
}

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

/**
 * Calling codes whose national trunk prefix is "0" and is omitted after the
 * country code, so a display like "+49 (0)6061 …" means the destination
 * without the 0. Source for each: ITU-T, Dialling procedures (international
 * prefix, national (trunk) prefix and national (significant) number), annex to
 * ITU Operational Bulletin No. 994 (position on 15 December 2011), national
 * prefix "0" for Netherlands 31, Belgium 32, France 33, Switzerland 41,
 * Austria 43, United Kingdom 44, Germany 49, Australia 61, New Zealand 64 and
 * Ireland 353. Deliberately absent: countries with no trunk prefix, where a
 * leading 0 is part of the number (Italy 39, Spain 34, Norway 47, Denmark 45,
 * Portugal 351 in the same list), and the rest of the trunk-0 countries, whose
 * display text is read literally until there is a reason to add them.
 */
const TRUNK_ZERO_CALLING_CODES = new Set([
  "31",
  "32",
  "33",
  "41",
  "43",
  "44",
  "49",
  "61",
  "64",
  "353",
]);

// "+49 (0)6061 …": the parenthesised optional trunk prefix after a calling code.
const OPTIONAL_TRUNK_ZERO = /\+\s*(\d{1,3})\s*\(\s*0\s*\)\s*/;

// Fewest digits (calling code included) read as a number in that display form:
// seven, the length `tel-links` asks of an href.
const MIN_INTL_DISPLAY_DIGITS = 7;

/**
 * Display text with an optional trunk prefix "(0)" read as the destination
 * omits it (pub#663), e.g. "+49 (0)6061 630 980 0" → "+49 6061 630 980 0", the
 * ITU-T E.123 international form. Null when the text has no such prefix, or
 * its calling code is not one where the 0 is a trunk prefix. Interprets the
 * display text only; the href is never rewritten.
 */
export function withoutOptionalTrunkZero(text: string): string | null {
  const m = OPTIONAL_TRUNK_ZERO.exec(text);
  if (!m || !TRUNK_ZERO_CALLING_CODES.has(m[1])) return null;
  return (
    text.slice(0, m.index) +
    `+${m[1]} ` +
    text.slice(m.index + m[0].length)
  ).trim();
}

/**
 * `/.+@.+\..+/.test(text)` in linear time: some line has an "@" after its
 * first character, and a "." at least two characters later that is not the
 * line's last. The regex rescans to the end of the line from every start, so
 * a link wrapping one long unbroken run (inline base64, a minified blob) took
 * seconds per 50KB.
 */
export function looksLikeEmail(text: string): boolean {
  for (const line of text.split(/[\n\r\u2028\u2029]/)) {
    const at = line.indexOf("@", 1);
    if (at >= 0 && line.lastIndexOf(".", line.length - 2) >= at + 2) return true;
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
    verdictScope: "page",
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
    const telTrunkPrefixes: CheckItem[] = [];
    const mailtoMismatches: CheckItem[] = [];

    const links = doc.querySelectorAll("a[href]");

    // #2307: where each tel:/mailto: anchor sits, from the page's carried contact links, keyed by
    // scheme, value and display text (how the parse stores them). A parse without sections leaves
    // this empty and the items bare.
    const sectionsByContact = new Map<string, SectionCounts>();
    for (const contact of ctx.parsed.contactLinks ?? []) {
      addSection(
        sectionsByContact,
        `${contact.scheme}\n${contact.value}\n${contact.text}`,
        contact.section
      );
    }
    // The parse keeps the first MAX_CONTACT_LINKS contact anchors only. Past that, an anchor's
    // landmark is read from the DOM here (markup only: the classifier's answer is not kept for it).
    const contactsCapped = (ctx.parsed.contactLinks?.length ?? 0) >= MAX_CONTACT_LINKS;
    const markupSectionOf = makeLinkSectionResolver();
    const placed = (
      item: CheckItem,
      scheme: "tel" | "mailto",
      href: string,
      text: string,
      anchor: Element
    ): CheckItem => {
      const value = href.trim().slice(scheme.length + 1).split(/[?;]/)[0] ?? "";
      let sections = sectionsByContact.get(`${scheme}\n${value}\n${text}`);
      if (!sections && contactsCapped) {
        const own: SectionCounts = {};
        countSection(own, markupSectionOf(anchor).section);
        if (Object.keys(own).length > 0) sections = own;
      }
      // pub#846: `regions` lets the report scope a contact link repeated in the footer to it.
      return sections
        ? {
            ...item,
            label: withSection(item.label ?? item.id, sections),
            meta: sectionMeta(sections),
            ...pageRegionsField(sections),
          }
        : item;
    };

    for (const link of links) {
      let href = link.getAttribute("href") || "";
      // Cloudflare's email-protection link (`/cdn-cgi/l/email-protection#<hex>`) is a mailto to
      // a browser (pub#811, pub#838): read it as one, with the decoded address when the payload
      // decodes. An undecodable one stays a mailto with no address, counted but never judged
      // invalid, since the address cannot be seen.
      const obfuscated = isCloudflareEmailProtectionUrl(href);
      if (obfuscated) href = `mailto:${obfuscatedAddress(link, href)}`;

      if (href.startsWith("tel:")) {
        telLinks.push(href);
        const phone = href.replace("tel:", "");
        // Basic validation - should have digits
        if (!/[\d+]/.test(phone) || phone.length < 7) {
          invalidTel.push(href);
        }

        // Mismatch check (#694: E.164 href vs national trunk-zero text, e.g. +61414… vs 0414…, is NOT a mismatch)
        const text = link.textContent?.trim() || "";
        // "+49 (0)6061 …" with href "+496061…" is the same destination in a
        // non-recommended display form: formatting advice, never a mismatch.
        // Read before the 3-digit gate so grouped numbers ("+33 (0)1 23 45 67
        // 89") count; the length floor keeps a bare "+49 (0)" from suffix-matching.
        const intlForm = withoutOptionalTrunkZero(text);
        if (
          intlForm !== null &&
          normalizePhone(intlForm).length >= MIN_INTL_DISPLAY_DIGITS &&
          phoneNumbersMatch(phone, intlForm)
        ) {
          telTrunkPrefixes.push(
            placed(
              {
                id: href,
                label: `text "${text}": use "${intlForm}"`,
                snippet: link.outerHTML.slice(0, 200),
              },
              "tel",
              href,
              text,
              link
            )
          );
        } else if (/\d{3,}/.test(text) && !phoneNumbersMatch(phone, text)) {
          telMismatches.push(
            placed(
              {
                id: href,
                label: `href "${phone}" ≠ text "${text}"`,
                snippet: link.outerHTML.slice(0, 200),
              },
              "tel",
              href,
              text,
              link
            )
          );
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
        const hidden = obfuscated && email === "";
        if (!isShareLink && !hidden && (!email.includes("@") || !email.includes("."))) {
          invalidMailto.push(href);
        }

        // Check for href/text email mismatch. An obfuscated link whose address did not decode
        // has none to compare.
        const text = link.textContent?.trim() || "";
        if (!hidden && looksLikeEmail(text) && text.toLowerCase() !== email.toLowerCase()) {
          mailtoMismatches.push(
            placed(
              {
                id: href,
                label: `href "${email}" ≠ text "${text}"`,
                snippet: link.outerHTML.slice(0, 200),
              },
              "mailto",
              href,
              text,
              link
            )
          );
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

    // Advice, a level below a mismatch: the link dials the number shown.
    if (telTrunkPrefixes.length > 0) {
      checks.push({
        name: "tel-trunk-prefix",
        status: "info",
        message: `${telTrunkPrefixes.length} tel link(s) show the optional trunk prefix (0) in an international number; drop it (ITU-T E.123)`,
        items: telTrunkPrefixes,
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
