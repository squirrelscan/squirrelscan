// security/form-captcha - Detect public forms without CAPTCHA protection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import { elementsWithAttribute } from "../shared/attribute-lookup";

// CAPTCHA provider detection patterns
const CAPTCHA_PATTERNS = {
  recaptcha: {
    scripts: [/google\.com\/recaptcha/, /gstatic\.com\/recaptcha/],
    classes: ["g-recaptcha"],
    responseFields: ["g-recaptcha-response"],
  },
  turnstile: {
    scripts: [/challenges\.cloudflare\.com\/turnstile/],
    classes: ["cf-turnstile"],
    responseFields: ["cf-turnstile-response"],
  },
  hcaptcha: {
    // storefront-forms-hcaptcha = Shopify's native hCaptcha integration
    scripts: [/hcaptcha\.com/, /storefront-forms-hcaptcha/],
    classes: ["h-captcha"],
    responseFields: ["h-captcha-response"],
  },
  friendlycaptcha: {
    scripts: [/friendlycaptcha/],
    classes: ["frc-captcha"],
    responseFields: ["frc-captcha-solution"],
  },
} as const;

// FormShield (formshield.dev, our own product) protects every form on the page invisibly via one site-wide beacon script — no per-form widget to detect.
const FORMSHIELD_PATH_RE = /^\/js\/formshield(?:\.esm)?\.js$/i;
const FORMSHIELD_PROJECT_KEY_ATTR = "data-fs-project-key";

// Host-anchored: a substring test would let an unrelated path like
// https://evil.com/formshield.dev/js/formshield.js flip protection to pass.
function isFormShieldScriptSrc(src: string, baseUrl: string): boolean {
  try {
    const url = new URL(src, baseUrl);
    const host = url.hostname.toLowerCase();
    return (
      (host === "formshield.dev" || host.endsWith(".formshield.dev")) &&
      FORMSHIELD_PATH_RE.test(url.pathname)
    );
  } catch {
    return false;
  }
}

// Keywords identifying public-facing forms
const PUBLIC_FORM_KEYWORDS = [
  "contact",
  "comment",
  "feedback",
  "newsletter",
  "subscribe",
  "register",
  "signup",
  "sign-up",
  "inquiry",
  "enquiry",
  "request",
  "support",
  "message",
  "email",
];

// Keywords identifying excluded forms
const EXCLUDED_FORM_KEYWORDS = [
  "search",
  "login",
  "signin",
  "sign-in",
  "admin",
  "checkout",
  "cart",
];

type FormClassification = "public" | "excluded" | "unknown";

/**
 * Check if page has CAPTCHA via scripts.
 * Also scans inline bootstrap loaders: Shopify injects its native hCaptcha
 * via <script id="captcha-bootstrap"> that lazily loads the provider script
 * from the CDN, so no script[src] or widget markup exists in the HTML.
 * Also scans resource-hint links: explicit-render setups (e.g. Turnstile's
 * `render=explicit`) often declare the loader as `<link rel="preload"
 * as="script">`/`modulepreload`/`prefetch` instead of an actual script[src],
 * with the widget only mounted by JS later (#1173).
 */
function hasPageLevelCaptchaScript(doc: Document): boolean {
  const scripts = doc.querySelectorAll("script[src]");
  for (const script of scripts) {
    const src = script.getAttribute("src") || "";
    for (const provider of Object.values(CAPTCHA_PATTERNS)) {
      if (provider.scripts.some((pattern) => pattern.test(src))) {
        return true;
      }
    }
  }

  const hintLinks = doc.querySelectorAll("link[rel]");
  for (const link of hintLinks) {
    // `rel` is a space-separated token list (e.g. rel="preload modulepreload"),
    // so a CSS attribute-equals selector would miss valid combined markup.
    const relTokens = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    const asAttr = (link.getAttribute("as") || "").toLowerCase();
    const isHintLink =
      (relTokens.includes("preload") && asAttr === "script") ||
      relTokens.includes("modulepreload") ||
      relTokens.includes("prefetch");
    if (!isHintLink) continue;

    const href = link.getAttribute("href") || "";
    for (const provider of Object.values(CAPTCHA_PATTERNS)) {
      if (provider.scripts.some((pattern) => pattern.test(href))) {
        return true;
      }
    }
  }

  if (doc.querySelector("script#captcha-bootstrap")) {
    return true;
  }
  const inlineScripts = doc.querySelectorAll("script:not([src])");
  for (const script of inlineScripts) {
    const content = script.textContent || "";
    if (!content) continue;
    for (const provider of Object.values(CAPTCHA_PATTERNS)) {
      if (provider.scripts.some((pattern) => pattern.test(content))) {
        return true;
      }
    }
  }

  return false;
}

// A provider's site key in the page's own config (pub#919). Client-rendered
// widgets (`@nuxtjs/turnstile`, a React reCAPTCHA component) mount after
// hydration, so the static HTML holds no widget, no response field and no
// provider script, only the key the runtime will render with: Nuxt's
// `window.__NUXT__.config = {public:{turnstile:{siteKey:"0x4…"}}}`, or a
// `"recaptchaSiteKey":"6L…"` entry in a JSON data script. The key has to sit
// under the provider's name, as a `siteKey` in the provider's own object or as
// `<provider>SiteKey`, so a script that merely mentions a provider is not
// protection, and the value has to have that provider's key format, so a
// translated "Site key" label is not one either. A provider object that
// switches itself off (`enabled: false`) is not protection.
const UUID_KEY = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SITE_KEY_FORMATS: Record<string, string> = {
  // Production keys start 0x4. Cloudflare documents the test keys
  // 1x00000000000000000000AA (passes), 2x00000000000000000000AB (blocks) and
  // 3x00000000000000000000FF (forces a challenge).
  turnstile: "(?:0x4[\\w-]{10,60}|[123]x0{20}[A-F]{2})",
  recaptcha: "6L[\\w-]{38}",
  hcaptcha: UUID_KEY,
  friendlycaptcha: `(?:FC[A-Z0-9]{8,40}|${UUID_KEY})`,
};
const CAPTCHA_PROVIDERS = Object.keys(SITE_KEY_FORMATS);
// Not `\b`: an env-style name (`NUXT_PUBLIC_TURNSTILE_SITE_KEY`) puts an
// underscore, a word character, before the provider.
const PROVIDER_OBJECT_START = new RegExp(
  `(?<![a-z0-9])(${CAPTCHA_PROVIDERS.join("|")})["']?\\s*:\\s*\\{`,
  "gi",
);
const NESTED_SITE_KEY = Object.fromEntries(
  Object.entries(SITE_KEY_FORMATS).map(([provider, key]) => [
    provider,
    new RegExp(`(?<![a-z0-9])site_?key["']?\\s*:\\s*["']${key}["']`, "i"),
  ]),
);
const FLAT_SITE_KEYS = Object.entries(SITE_KEY_FORMATS).map(([provider, key]) => ({
  key: new RegExp(`(?<![a-z0-9])${provider}_?site_?key["']?\\s*[:=]\\s*["']${key}["']`, "i"),
  // A sibling switch for the same provider: `recaptchaEnabled: false`,
  // `TURNSTILE_ENABLED = "false"`, `hcaptchaDisabled: true`.
  off: new RegExp(
    `(?<![a-z0-9])${provider}_?(?:(?:enabled?|active)["']?\\s*[:=]\\s*(?:false|0|["']false["'])|disabled["']?\\s*[:=]\\s*(?:true|1|["']true["']))`,
    "i",
  ),
}));
const PROVIDER_SWITCHED_OFF =
  /(?<![a-z0-9])(?:enabled?|active)["']?\s*:\s*(?:false|0|["']false["'])|(?<![a-z0-9])disabled["']?\s*:\s*(?:true|1|["']true["'])/i;
/** How far one provider object is read, and how many are read per script. */
const PROVIDER_OBJECT_MAX_CHARS = 4000;
const PROVIDER_OBJECTS_PER_SCRIPT = 50;

/**
 * The top level of the object that opens at `start` (just past its `{`):
 * nested objects are skipped, strings are kept whole, so a flag or key inside
 * a sub-object (`options: {…}`) is not read as the provider's own. Null when
 * the object does not close within the bound: an unread switch-off flag could
 * follow, so a half-read object is never credited.
 */
function objectTopLevel(content: string, start: number): string | null {
  let out = "";
  let depth = 1;
  const end = Math.min(content.length, start + PROVIDER_OBJECT_MAX_CHARS);
  for (let i = start; i < end; i++) {
    const ch = content[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < end && content[j] !== ch) j += content[j] === "\\" ? 2 : 1;
      if (depth === 1) out += content.slice(i, j + 1);
      i = j;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      if (--depth === 0) return out;
    } else if (depth === 1) {
      out += ch;
    }
  }
  return null;
}

function hasPageLevelCaptchaConfig(doc: Document): boolean {
  for (const script of doc.querySelectorAll("script:not([src])")) {
    const content = script.textContent || "";
    if (!content) continue;
    // A flat key has no object of its own: a sibling switch for the same
    // provider anywhere in the script turns it off.
    if (FLAT_SITE_KEYS.some(({ key, off }) => key.test(content) && !off.test(content))) return true;
    let seen = 0;
    for (const match of content.matchAll(PROVIDER_OBJECT_START)) {
      if (++seen > PROVIDER_OBJECTS_PER_SCRIPT) break;
      const provider = match[1]!.toLowerCase();
      const own = objectTopLevel(content, match.index + match[0].length);
      if (own === null) continue;
      if (NESTED_SITE_KEY[provider]?.test(own) && !PROVIDER_SWITCHED_OFF.test(own)) return true;
    }
  }
  return false;
}

// #696: matches by host-anchored script src OR data-fs-project-key attr (covers proxied/self-hosted script paths).
function hasFormShieldProtection(doc: Document, baseUrl: string): boolean {
  const scripts = doc.querySelectorAll("script[src]");
  for (const script of scripts) {
    const src = script.getAttribute("src") || "";
    if (isFormShieldScriptSrc(src, baseUrl) || script.hasAttribute(FORMSHIELD_PROJECT_KEY_ATTR)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if page has CAPTCHA via iframe (reCAPTCHA renders in iframe)
 */
function hasPageLevelCaptchaIframe(doc: Document): boolean {
  const iframes = doc.querySelectorAll("iframe[src]");
  for (const iframe of iframes) {
    const src = iframe.getAttribute("src") || "";
    for (const provider of Object.values(CAPTCHA_PATTERNS)) {
      if (provider.scripts.some((pattern) => pattern.test(src))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if page has CAPTCHA widget class
 */
function hasPageLevelCaptchaClass(doc: Document): boolean {
  for (const provider of Object.values(CAPTCHA_PATTERNS)) {
    for (const className of provider.classes) {
      if (doc.querySelector(`.${className}`)) {
        return true;
      }
    }
  }
  return false;
}

// Explicit-render widgets (Turnstile's `render=explicit`, reCAPTCHA's
// `grecaptcha.render`, ...) mount into a plain container element that the
// caller picks — id/class don't match the provider's own widget class
// (`.cf-turnstile` etc.) until JS runs, and it may never gain an iframe if
// the widget renders lazily/on interaction. These tokens are provider-anchored
// enough to stand alone as a page-level signal.
const EXPLICIT_CONTAINER_TOKENS = ["turnstile", "g-recaptcha", "h-captcha", "frc-captcha"];

// Bare "captcha" is too generic to anchor alone — ids like "captcha-help-text"
// reference a captcha without being its container. Unlike the provider tokens
// above, it's only accepted as part of the SAME hyphen/underscore/camelCase
// compound as a container-ish hint word (captcha-widget, captcha_container,
// captchaBox) — co-occurring with a hint word via a separate, unrelated id or
// class on the same element (e.g. id="captcha-help-text" class="footer-widget")
// is not a signal and must not downgrade a real warning to a false pass.
const GENERIC_CAPTCHA_TOKEN = "captcha";
const CONTAINER_HINT_WORDS = ["widget", "container", "box", "embed", "frame", "wrapper"];

// Precompiled once at module scope, not per element/audit run (containsToken
// used to build a new RegExp per call against a page-wide "[id], [class]" scan).
const EXPLICIT_CONTAINER_TOKEN_PATTERNS = EXPLICIT_CONTAINER_TOKENS.map(tokenBoundaryPattern);
const GENERIC_CAPTCHA_TOKEN_PATTERN = tokenBoundaryPattern(GENERIC_CAPTCHA_TOKEN);
const CONTAINER_HINT_WORD_PATTERNS = CONTAINER_HINT_WORDS.map(tokenBoundaryPattern);

function tokenBoundaryPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i");
}

// CamelCase compounds (captchaBox) have no non-alphanumeric boundary between
// words, so normalize the case transition into a hyphen before matching —
// hyphen/underscore-delimited compounds are untouched by this. Known gap:
// all-caps compounds (CAPTCHABox) aren't split, since real provider widget
// ids (turnstile-widget, cf-turnstile, ...) are never written that way.
function normalizeCompoundBoundaries(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
}

function containsToken(value: string, pattern: RegExp): boolean {
  return pattern.test(normalizeCompoundBoundaries(value));
}

// Each id and each individual class name is its own identifier — the generic
// "captcha" + hint-word check must match within one identifier, not merely
// across the concatenation of unrelated id/class values on the same element.
function getElementIdentifiers(el: Element): string[] {
  const identifiers: string[] = [];
  const id = el.getAttribute("id");
  if (id) identifiers.push(id);
  const className = el.getAttribute("class");
  if (className) {
    for (const cls of className.split(/\s+/)) {
      if (cls) identifiers.push(cls);
    }
  }
  return identifiers;
}

// A bare word like "turnstile" is common enough to false-match unrelated
// markup: physical-turnstile sites (id="turnstile-status"), or heading anchor
// slugs auto-generated from prose ABOUT Turnstile (e.g. rehype-slug turning
// "Cloudflare Turnstile vs reCAPTCHA" into <h2 id="cloudflare-turnstile-...">).
// An explicit-render widget mounts into an empty div/span the JS SDK fills in
// later — never a heading or link — so require the matched element to
// actually look like that kind of mount point (#1173 review round 2).
const MOUNT_POINT_EXCLUDED_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "a"]);

function looksLikeMountPoint(el: Element): boolean {
  const tag = el.tagName?.toLowerCase() ?? "";
  if (MOUNT_POINT_EXCLUDED_TAGS.has(tag)) return false;
  return (el.textContent || "").trim() === "";
}

function isExplicitCaptchaContainerElement(el: Element): boolean {
  const combined = `${el.getAttribute("id") || ""} ${el.getAttribute("class") || ""}`.trim();
  if (!combined || !looksLikeMountPoint(el)) return false;

  if (EXPLICIT_CONTAINER_TOKEN_PATTERNS.some((pattern) => containsToken(combined, pattern))) {
    return true;
  }

  return getElementIdentifiers(el).some(
    (identifier) =>
      containsToken(identifier, GENERIC_CAPTCHA_TOKEN_PATTERN) &&
      CONTAINER_HINT_WORD_PATTERNS.some((pattern) => containsToken(identifier, pattern)),
  );
}

/**
 * Check if page has an explicit-render CAPTCHA container: an element whose
 * id/class references a provider token (or a hinted generic "captcha" token),
 * anchored to the attribute value so unrelated text elsewhere on the page
 * can't match (#1173).
 */
function hasExplicitCaptchaContainer(doc: Document): boolean {
  for (const el of doc.querySelectorAll("[id], [class]")) {
    if (isExplicitCaptchaContainerElement(el)) return true;
  }
  return false;
}

/**
 * Form-scoped variant of hasExplicitCaptchaContainer, for deciding whether a
 * *specific* form (not just the page) owns an explicit-render CAPTCHA
 * container — e.g. a Turnstile div nested inside an excluded nav-search form
 * rather than the public form being evaluated (#1173 review).
 */
function formHasExplicitCaptchaContainer(form: Element): boolean {
  if (isExplicitCaptchaContainerElement(form)) return true;
  for (const el of form.querySelectorAll("[id], [class]")) {
    if (isExplicitCaptchaContainerElement(el)) return true;
  }
  return false;
}

/**
 * Check if form has CAPTCHA response field
 */
function formHasCaptchaResponseField(form: Element): boolean {
  for (const provider of Object.values(CAPTCHA_PATTERNS)) {
    for (const fieldName of provider.responseFields) {
      if (elementsWithAttribute(form, "name", fieldName).length > 0 || form.querySelector(`#${fieldName}`)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if form contains a CAPTCHA widget
 */
function formHasCaptchaWidget(form: Element): boolean {
  for (const provider of Object.values(CAPTCHA_PATTERNS)) {
    for (const className of provider.classes) {
      if (form.querySelector(`.${className}`)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Classify form as public, excluded, or unknown
 */
function classifyForm(form: Element): FormClassification {
  const action = (form.getAttribute("action") || "").toLowerCase();
  const id = (form.getAttribute("id") || "").toLowerCase();
  const className = (form.getAttribute("class") || "").toLowerCase();
  const name = (form.getAttribute("name") || "").toLowerCase();
  const combinedAttrs = `${action} ${id} ${className} ${name}`;

  // Check for password field → login form (excluded)
  if (form.querySelector('input[type="password"]')) {
    return "excluded";
  }

  // Check for excluded keywords
  for (const keyword of EXCLUDED_FORM_KEYWORDS) {
    if (combinedAttrs.includes(keyword)) {
      return "excluded";
    }
  }

  // Check for public form keywords
  for (const keyword of PUBLIC_FORM_KEYWORDS) {
    if (combinedAttrs.includes(keyword)) {
      return "public";
    }
  }

  // Check for textarea (likely comment/feedback form)
  if (form.querySelector("textarea")) {
    return "public";
  }

  // Check for email input without password (newsletter/contact)
  const hasEmailInput = form.querySelector('input[type="email"]') !== null;
  const hasPasswordInput = form.querySelector('input[type="password"]') !== null;
  if (hasEmailInput && !hasPasswordInput) {
    return "public";
  }

  return "unknown";
}

/**
 * Get form identifier for reporting
 */
function getFormIdentifier(form: Element, index: number): string {
  const id = form.getAttribute("id");
  if (id) return `#${id}`;

  const name = form.getAttribute("name");
  if (name) return `[name="${name}"]`;

  const action = form.getAttribute("action");
  if (action) return `[action="${action}"]`;

  return `form[${index}]`;
}

export const formCaptchaRule: Rule = {
  meta: {
    id: "security/form-captcha",
    name: "Form CAPTCHA",
    description: "Checks for CAPTCHA protection on public forms",
    solution:
      "Add CAPTCHA protection (reCAPTCHA, Cloudflare Turnstile, hCaptcha, FormShield, etc.) to public-facing forms to prevent spam and bot submissions. Contact forms, comment forms, newsletter signups, and registration forms are common targets for automated abuse. Modern solutions like Turnstile and FormShield offer invisible protection with minimal user friction.",
    category: "security",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const forms = doc.querySelectorAll("form");
    if (forms.length === 0) {
      checks.push({
        name: "form-captcha",
        status: "info",
        message: "No forms on page",
      });
      return { checks };
    }

    // Detect page-level CAPTCHA
    const hasPageCaptcha =
      hasPageLevelCaptchaScript(doc) ||
      hasPageLevelCaptchaIframe(doc) ||
      hasPageLevelCaptchaClass(doc) ||
      hasExplicitCaptchaContainer(doc) ||
      hasPageLevelCaptchaConfig(doc);

    // FormShield covers every public form regardless of form count (no per-form widget to check).
    const hasFormShield = hasFormShieldProtection(doc, ctx.page.url);

    // Classify forms first so `publicForms.length` below reflects the final
    // count rather than a running tally (a second, later public form used to
    // silently un-assume protection granted to the first one).
    const publicForms: { form: Element; index: number }[] = [];
    let formIndex = 0;
    for (const form of forms) {
      if (classifyForm(form) === "public") {
        publicForms.push({ form, index: formIndex });
      }
      formIndex++;
    }

    // If some *other* form already owns a CAPTCHA widget/response field/
    // explicit-render container of its own (e.g. a login form with its own
    // reCAPTCHA, or a nav-search form wrapping the Turnstile div), the
    // page-level signal belongs to that form, not to our public form — don't
    // credit it twice.
    const singlePublicForm = publicForms.length === 1 ? publicForms[0].form : null;
    const anotherFormOwnsCaptcha = singlePublicForm
      ? Array.from(forms).some(
          (form) =>
            form !== singlePublicForm &&
            (formHasCaptchaWidget(form) ||
              formHasCaptchaResponseField(form) ||
              formHasExplicitCaptchaContainer(form)),
        )
      : false;

    const unprotectedForms: string[] = [];
    for (const { form, index } of publicForms) {
      const formHasCaptcha =
        formHasCaptchaWidget(form) ||
        formHasCaptchaResponseField(form) ||
        formHasExplicitCaptchaContainer(form);

      // A page-level CAPTCHA signal protects a single public form regardless
      // of how many *other* (e.g. nav search) forms are on the page (#1173),
      // unless one of those other forms already owns the CAPTCHA itself.
      const assumeProtected =
        hasFormShield || (hasPageCaptcha && publicForms.length === 1 && !anotherFormOwnsCaptcha);

      if (!formHasCaptcha && !assumeProtected) {
        unprotectedForms.push(getFormIdentifier(form, index));
      }
    }

    // Generate result
    if (publicForms.length === 0) {
      checks.push({
        name: "form-captcha",
        status: "info",
        message: "No public forms detected",
        details: { totalForms: forms.length },
      });
    } else if (unprotectedForms.length > 0) {
      checks.push({
        name: "form-captcha",
        status: "warn",
        message: `${unprotectedForms.length} public form(s) without CAPTCHA`,
        items: unprotectedForms.map((id) => ({ id })),
      });
    } else {
      checks.push({
        name: "form-captcha",
        status: "pass",
        message: `All ${publicForms.length} public form(s) have CAPTCHA`,
        details: { publicForms: publicForms.length },
      });
    }

    return { checks };
  },
};
