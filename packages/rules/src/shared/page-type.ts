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
// path and the heading as much as from the body), so it is corroborated by the page's MAIN content
// before it is allowed to relax a verdict (pub#841 review): a law-firm landing page at
// `/solutions/legal`, a marketing page at `/contact`, or a client-rendered shell at `/privacy` with
// no text is labelled legal or contact by the model, and skipping the thin-content floor there would
// hide a real finding and resolve an earlier one. Navigation, header, footer and aside are left out:
// every page's footer links "Privacy Policy | Terms | Cookies" and carries a mailto: or a phone number.

/** Policy phrases. A page needs {@link LEGAL_PHRASES_NEEDED} distinct ones. Whole words, left and right. */
const LEGAL_PHRASES = [
  "privacy policy",
  "personal data",
  "personal information",
  "terms of service",
  "terms of use",
  "terms and conditions",
  "governing law",
  "limitation of liability",
  "data controller",
  "data protection",
  "we collect",
  "you agree",
  "your rights",
  "gdpr",
  "intellectual property",
  "last updated",
  "effective date",
  "indemnify",
  "arbitration",
  "refund policy",
  "acceptable use",
  // The same vocabulary in the languages the classifier's training sites most often use.
  "datenschutzerklärung",
  "personenbezogene daten",
  "nutzungsbedingungen",
  "allgemeine geschäftsbedingungen",
  "données personnelles",
  "politique de confidentialité",
  "conditions générales",
  "mentions légales",
  "datos personales",
  "política de privacidad",
  "términos y condiciones",
  "aviso legal",
  "dati personali",
  "informativa sulla privacy",
  "termini e condizioni",
  "dados pessoais",
  "política de privacidade",
  "termos de uso",
  "persoonsgegevens",
  "privacybeleid",
  "algemene voorwaarden",
] as const;
const LEGAL_PHRASES_NEEDED = 3;

const LETTER = /\p{L}/u;

/** `phrase` in `text` as whole words (a letter right before or after it is not a match). */
function containsPhrase(text: string, phrase: string): boolean {
  let from = 0;
  for (let tries = 0; tries < 20; tries++) {
    const at = text.indexOf(phrase, from);
    if (at < 0) return false;
    const before = at > 0 ? text[at - 1]! : " ";
    const after = at + phrase.length < text.length ? text[at + phrase.length]! : " ";
    if (!LETTER.test(before) && !LETTER.test(after)) return true;
    from = at + 1;
  }
  return false;
}

/** How much of the text is read for a way to reach the organisation: a contact page is short. */
const CONTACT_SCAN_CHARS = 30_000;
/** At most this many "@" signs are tried, so a hostile page costs a fixed amount. */
const MAX_AT_SIGNS = 50;

const LOCAL_CHAR = /[a-z0-9._%+-]/;
// Anchored on a slice at most 300 characters long, with every repetition bounded: no backtracking blow-up.
const EMAIL_DOMAIN = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,5}\.[a-z]{2,24}/;

/** An email address in the text: a local part before an "@" and a dotted domain after it. */
function hasEmailAddress(text: string): boolean {
  let from = 0;
  for (let tries = 0; tries < MAX_AT_SIGNS; tries++) {
    const at = text.indexOf("@", from);
    if (at < 0) return false;
    from = at + 1;
    if (at > 0 && LOCAL_CHAR.test(text[at - 1]!) && EMAIL_DOMAIN.test(text.slice(at + 1, at + 301))) return true;
  }
  return false;
}

/** The most digit-and-separator characters one candidate run may span. */
const MAX_PHONE_RUN = 40;

function isPhoneRun(run: string, plus: boolean): boolean {
  const digits = run.replace(/\D/g, "").length;
  if (digits > 15) return false;
  const groups = run.split(/[^0-9]+/).filter(Boolean);
  if (plus) return digits >= 8;
  if (digits < 9) return false;
  // A phone number is written with a separator pattern or brackets; a bare run of digits is an id.
  if (!/[\s().-]/.test(run.trim())) return false;
  // An IPv4 address (four dotted groups) and a list of years ("2019 2020 2021") are not phone numbers.
  if (groups.length === 4 && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(run.trim())) return false;
  if (groups.every((g) => /^(?:19|20)\d{2}$/.test(g))) return false;
  return true;
}

/**
 * A phone number: nine to fifteen digits with a separator pattern or brackets, or eight after a
 * leading "+". Scanned by hand over a bounded prefix, one pass.
 */
function hasPhoneNumber(text: string): boolean {
  let run = "";
  let plus = false;
  const flush = (): boolean => {
    const hit = run.length > 0 && isPhoneRun(run, plus);
    run = "";
    return hit;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const isDigit = char >= "0" && char <= "9";
    if (isDigit || (run.length > 0 && (char === " " || char === "(" || char === ")" || char === "-" || char === "." || char === "\u00a0"))) {
      if (run.length === 0) plus = i > 0 && text[i - 1] === "+";
      run += char;
      if (run.length > MAX_PHONE_RUN) {
        if (flush()) return true;
        plus = false;
      }
    } else {
      if (flush()) return true;
      plus = char === "+";
    }
  }
  return flush();
}

/** Elements that are page furniture, not the page's own content. */
const CHROME = "header, nav, footer, aside, [role='banner'], [role='navigation'], [role='contentinfo'], [role='complementary'], script, style, noscript, template";

interface MainContent {
  text: string;
  hasContactLink: boolean;
  hasMessageBox: boolean;
}

/** Most nodes read when flattening the content to text, and the deepest nesting followed. */
const MAX_TEXT_NODES = 200_000;
const MAX_TEXT_DEPTH = 256;

/**
 * Text of `node` with a space between elements, so a heading and the paragraph after it do not run
 * together into one word (`textContent` joins them), which would defeat the whole-word phrase match.
 */
function textWithSpaces(node: Node): string {
  const out: string[] = [];
  let visited = 0;
  const walk = (current: Node, depth: number): void => {
    if (visited++ > MAX_TEXT_NODES || depth > MAX_TEXT_DEPTH) return;
    if (current.nodeType === 3) {
      out.push(current.nodeValue ?? "");
      return;
    }
    for (const child of Array.from(current.childNodes)) walk(child, depth + 1);
    out.push(" ");
  };
  walk(node, 0);
  return out.join("");
}

/**
 * The page's own content: the `<main>` landmark, else the body, with the header, navigation, footer
 * and aside (and scripts and styles) taken out. Null without a document. Works on a copy, so the page
 * is not changed.
 */
function mainContent(parsed: ParsedPage): MainContent | null {
  const document = parsed.document;
  if (!document) return null;
  const root = document.querySelector("main, [role='main']") ?? document.body ?? document.documentElement;
  if (!root) return null;
  const copy = root.cloneNode(true) as Element;
  for (const chrome of Array.from(copy.querySelectorAll(CHROME))) chrome.remove();
  return {
    text: textWithSpaces(copy).replace(/\s+/g, " ").trim().toLowerCase(),
    hasContactLink: copy.querySelector("a[href^='mailto:' i], a[href^='tel:' i]") != null,
    hasMessageBox: copy.querySelector("form textarea") != null,
  };
}

/**
 * Whether the page's main content bears out a `contact` or `legal` label. A page with no text never
 * does: a client-rendered shell is judged by the rules like any other thin page. `contact` needs a
 * way to reach the organisation in the content itself (a `tel:` or `mailto:` link, an email address
 * or phone number in the text, or a message box); a newsletter field or a site search is not one,
 * and neither is a footer. `legal` needs policy vocabulary, not the word "legal". A support page
 * with a contact form is a contact surface and is accepted.
 */
export function bodyCorroboratesPageType(parsed: ParsedPage | null | undefined, label: string): boolean {
  if (!parsed || (label !== "legal" && label !== "contact")) return false;
  const main = mainContent(parsed);
  if (!main || main.text.length === 0) return false;
  if (label === "legal") {
    let found = 0;
    for (const phrase of LEGAL_PHRASES) {
      if (containsPhrase(main.text, phrase) && ++found >= LEGAL_PHRASES_NEEDED) return true;
    }
    return false;
  }
  if (main.hasContactLink || main.hasMessageBox) return true;
  const head = main.text.slice(0, CONTACT_SCAN_CHARS);
  return hasEmailAddress(head) || hasPhoneNumber(head);
}

/**
 * The page's type when it may relax a verdict: a trusted model label (see {@link trustedPageType})
 * in `types` that the page's main content bears out. `null` otherwise.
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
