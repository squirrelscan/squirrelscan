// integrity/signals — shared compromise-signal detectors + correlation helper.
//
// Phase A heuristics (issue #116) deliberately share one detection module so the
// per-page rules can correlate WITHOUT a cross-rule aggregation point in the
// runner (rules stay pure — each reads only its own immutable `ctx`). Every
// page-scope integrity rule computes ALL page-level signals for its own page via
// `detectPageSignals`, then escalates its own finding to high severity only when
// >=2 distinct signals corroborate (`shouldEscalate`). A lone signal emits
// `info` — the false-positive discipline from the plan: a single brand mention,
// a single big inline script, etc. is never enough to shout "compromised".
//
// All detectors are conservative and operate only on data already in
// `RuleContext` (page.html, parsed.document, parsed.meta, parsed.content). No new
// context, infra, or external calls.

import { getDomain } from "tldts";

import { getAttrCI } from "@squirrelscan/utils";

import { getPageSeparatedText } from "../content/text-content";
import type { RuleContext } from "../types";

import { collectControls, readable, scanControls } from "./controls";
import { cssScanTruncated, overlayGeometry } from "./overlay-style";

/** Distinct page-level compromise signals (one per page-scope rule). */
export type IntegritySignal =
  | "brand-impersonation"
  | "obfuscated-script"
  | "fake-auth-overlay"
  | "seo-doorway";

/**
 * The exact subset of `RuleContext` the page-level signal detectors read: the
 * parsed page plus the page's own URL/finalUrl (for self-host resolution). A full
 * `RuleContext` satisfies it, so every existing caller still type-checks. The
 * streaming collector (#1021 E-E2 `buildCollectedPageSignal`) builds only this
 * subset with the DOM live — narrowing to it makes a future detector that reaches
 * for any other `ctx` field a COMPILE error, not a silent golden-only divergence.
 */
export interface PageSignalContext {
  parsed: RuleContext["parsed"];
  page: Pick<RuleContext["page"], "url" | "finalUrl">;
}

/**
 * High-severity integrity findings require at least this many DISTINCT
 * corroborating page signals. Below it, rules emit `info` only.
 */
export const CORRELATION_THRESHOLD = 2;

/**
 * The lowercased title and page copy the auth and brand cues are read from.
 * `content.textContent` glues adjacent elements, so `<h1>Welcome</h1><a>Sign
 * in with Google</a>` reads `welcomesign in with google` and the word-bounded
 * `sign in` test misses it (pub#696). The element-separated text is read too,
 * so whitespace between elements cannot decide whether a cue is seen. Every
 * test on this haystack asks whether a cue appears, so the extra text can only
 * find a cue, never hide one.
 */
function authHaystack(ctx: PageSignalContext): string {
  const doc = ctx.parsed.document;
  const cached = doc ? haystackCache.get(doc) : undefined;
  if (cached !== undefined) return cached;
  const title = readable(ctx.parsed.meta.title ?? "");
  const text = readable(ctx.parsed.content.textContent ?? "");
  const separated = doc ? readable(getPageSeparatedText(doc)) : "";
  const haystack = `${title}\n${text}\n${separated}`;
  if (doc) haystackCache.set(doc, haystack);
  return haystack;
}

/** One `authHaystack` per parsed document: several detectors read it. */
const haystackCache = new WeakMap<object, string>();

// ── Brand impersonation ─────────────────────────────────────────────
//
// Third-party brands whose login / funnel / scheduling surfaces are commonly
// cloned by injected phishing kits. Each entry: the brand, the lexicon that
// signals an impersonation of THAT brand's auth/booking surface, and the
// legitimate hostnames a real integration would point at (so a genuine
// "Sign in with Google" or a Calendly embed on the brand's own domain is spared).

export interface BrandSpec {
  brand: string;
  /** Lower-cased phrases; impersonation needs the brand AND an auth/action cue. */
  lexicon: string[];
  /** Auth/booking action cues that turn a mention into an impersonation. */
  actionCues: string[];
  /** Legit hosts for this brand — links here are treated as real integrations. */
  legitHosts: string[];
}

export const BRAND_SPECS: BrandSpec[] = [
  {
    brand: "Google",
    lexicon: [
      "sign in with google",
      "continue with google",
      "log in with google",
      "login with google",
      "google account",
      "google login",
    ],
    actionCues: ["sign in", "log in", "continue", "verify"],
    legitHosts: ["accounts.google.com", "google.com"],
  },
  {
    brand: "Microsoft",
    lexicon: [
      "sign in with microsoft",
      "continue with microsoft",
      "log in with microsoft",
      "login with microsoft",
      "microsoft account",
      "office 365 login",
      "outlook login",
    ],
    actionCues: ["sign in", "log in", "continue", "verify"],
    legitHosts: [
      "login.microsoftonline.com",
      "login.microsoftonline.us",
      "login.windows.net",
      "login.live.com",
      "b2clogin.com",
      "microsoft.com",
    ],
  },
  {
    brand: "Calendly",
    lexicon: ["calendly"],
    actionCues: [
      "discovery call",
      "book a call",
      "schedule",
      "sign in",
      "log in",
    ],
    legitHosts: ["calendly.com"],
  },
  {
    brand: "DocuSign",
    lexicon: ["docusign"],
    actionCues: ["sign in", "log in", "review document", "sign document"],
    legitHosts: ["docusign.com", "docusign.net"],
  },
  {
    brand: "ClickFunnels",
    lexicon: ["clickfunnels"],
    actionCues: ["sign in", "log in", "members login"],
    legitHosts: ["clickfunnels.com", "myclickfunnels.com"],
  },
  {
    brand: "Kajabi",
    lexicon: ["kajabi"],
    actionCues: ["sign in", "log in", "members login"],
    legitHosts: ["kajabi.com", "mykajabi.com"],
  },
];

/**
 * Hosts the page presents as part of itself (its own origin + any explicit
 * canonical / og:url host). A brand link pointing at one of these is the site's
 * own surface, not an off-origin credential grab.
 */
export function selfHosts(ctx: PageSignalContext): Set<string> {
  const hosts = new Set<string>();
  const add = (raw: string | null | undefined, base?: string) => {
    if (!raw) return;
    try {
      hosts.add(new URL(raw, base).hostname.toLowerCase());
    } catch {
      /* ignore unparsable */
    }
  };
  add(ctx.page.url);
  add(ctx.page.finalUrl);
  add(ctx.parsed.meta.canonical, ctx.page.url);
  add(ctx.parsed.og.url, ctx.page.url);
  return hosts;
}

/**
 * Registrable domain (eTLD+1) of a hostname — resolved against the real Public
 * Suffix List (via `tldts`) and used by `isSelfOrSameSite` so a sign-in link to a
 * sibling app subdomain (`app.acme.com` from `www.acme.com`) is treated as the
 * site's own surface.
 *
 * `app.acme.com` → `acme.com`; `app.victim.com.au` → `victim.com.au` (the PSL
 * knows `com.au` is a public suffix); `treasury.gov.au` and `health.gov.au` stay
 * distinct. This supersedes the earlier curated multi-label-suffix table (#144),
 * which only covered ~50 common ccTLD second-levels and over-collapsed deeper
 * tiers (`nsw.edu.au`, `qld.gov.au`, …) it could not represent.
 *
 * `allowPrivateDomains` is enabled so PRIVATE-section suffixes count as public:
 * `victim.blogspot.com` and `evil.blogspot.com` resolve to DISTINCT registrable
 * domains rather than collapsing to `blogspot.com`. Free-hosting platforms
 * (`*.blogspot.com`, `*.github.io`, `*.vercel.app`, `*.pages.dev`, …) are exactly
 * where phishing kits live, so per-tenant resolution lets a brand-labeled
 * credential link from one tenant to another be flagged. The residual
 * false-positive risk (a legit site spanning two sibling platform subdomains) is
 * bounded by the rule's correlation gating — a lone signal only ever emits
 * `info`, never a failure.
 *
 * Falls back to the trailing-dot-stripped, lowercased host whenever tldts cannot
 * derive a registrable domain (bare public suffix, single-label host, IP literal,
 * `localhost`, otherwise unparseable input) so both sides of a same-site
 * comparison still normalize identically.
 */
function registrableDomain(host: string): string {
  const normalized = host.replace(/\.$/, "").toLowerCase();
  return getDomain(normalized, { allowPrivateDomains: true }) ?? normalized;
}

/** True if `host` is one of `self` or shares its registrable domain (eTLD+1). */
function isSelfOrSameSite(host: string, self: Set<string>): boolean {
  if (self.has(host)) return true;
  const reg = registrableDomain(host);
  for (const s of self) {
    if (registrableDomain(s) === reg) return true;
  }
  return false;
}

export interface BrandImpersonationHit {
  brand: string;
  /** Why we think it's an impersonation (human-readable). */
  reason: string;
}

function hostMatches(host: string, hosts: string[]): boolean {
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

function hrefPath(raw: string | null, base: string): string {
  if (!raw) return "";
  try {
    return new URL(raw, base).pathname;
  } catch {
    return "";
  }
}

function hrefHost(raw: string | null, base: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw, base).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Identity brokers: hosted sign-in services a site puts between itself and Google or Microsoft. A "Sign in
 * with Google" or "Sign in with Microsoft" control that goes to a broker's AUTHORIZE ENDPOINT is a real
 * integration, not an off-brand credential grab (#784). Narrow on purpose: the hosts are open to anyone who
 * registers a tenant (a free Auth0, Supabase or Firebase project can serve any page), so a broker host alone
 * proves nothing; only the endpoint shape does, and only for the two providers brokers federate. Other
 * brands, and any other path on these hosts, are judged as before.
 */
const IDENTITY_BROKER_ENDPOINTS: Array<{ host: string; path: RegExp }> = [
  { host: "auth0.com", path: /^\/authorize(?:\/|$)/ },
  { host: "okta.com", path: /^\/oauth2\/(?:[\w.-]+\/)?v1\/authorize(?:\/|$)|^\/oauth2\/authorize(?:\/|$)/ },
  { host: "oktapreview.com", path: /^\/oauth2\/(?:[\w.-]+\/)?v1\/authorize(?:\/|$)|^\/oauth2\/authorize(?:\/|$)/ },
  { host: "okta-emea.com", path: /^\/oauth2\/(?:[\w.-]+\/)?v1\/authorize(?:\/|$)|^\/oauth2\/authorize(?:\/|$)/ },
  { host: "amazoncognito.com", path: /^\/oauth2\/authorize(?:\/|$)/ },
  { host: "supabase.co", path: /^\/auth\/v1\/authorize(?:\/|$)/ },
  { host: "firebaseapp.com", path: /^\/__\/auth\/handler(?:\/|$)/ },
];

/** The brands an identity broker can legitimately stand in for. */
const BROKERED_BRANDS = new Set(["Google", "Microsoft"]);

function isBrokerEndpoint(brand: string, host: string, path: string): boolean {
  if (!BROKERED_BRANDS.has(brand)) return false;
  return IDENTITY_BROKER_ENDPOINTS.some((e) => hostMatches(host, [e.host]) && e.path.test(path));
}

interface CredentialDestination {
  host: string;
  /** The destination's path (no query or fragment), for the broker endpoint shape. */
  path: string;
  brandLabeled: string;
  signIn: boolean;
}

const phraseRegexes = new Map<string, RegExp>();

/**
 * `phrase` in `label` as whole words, with a space optional between its words. The label forms keep the
 * spaces the page had and glue elements together, so `Sign<br>in with Goo<i>gle</i> to continue` reads
 * `signin with google to continue`: the optional spaces see through the splice while the word boundaries at
 * each end keep `Redesign in with Google` and `Login with GoogleMail` out.
 */
function hasPhrase(label: string, phrase: string): boolean {
  let regex = phraseRegexes.get(phrase);
  if (!regex) {
    const body = phrase
      .split(" ")
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(" ?");
    regex = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "u");
    phraseRegexes.set(phrase, regex);
  }
  return regex.test(label);
}

/**
 * Collect the destination hosts of the page's actual CREDENTIAL SURFACE — not
 * every outbound link (a legit Google-SSO page with a footer Twitter link must
 * not be read as "credentials go to twitter.com"). The credential surface is:
 *   - `<form>` actions for forms that contain a password field, and
 *   - auth-labeled controls: `<a>`, `<button>`, `<input type=submit|button|image>` and
 *     `role=button` whose label says "sign in"/"log in"/"continue with"/names the brand,
 *     read from their text, `aria-label`, `title`, `value` and a logo's `alt` (#784).
 * Returns the destination hosts tied to those, paired with whether each came
 * from a control whose label actually names the brand. A broker host counts as
 * the brand's own (see {@link IDENTITY_BROKER_ENDPOINTS}).
 */
function credentialDestinations(
  doc: NonNullable<RuleContext["parsed"]["document"]>,
  base: string
): CredentialDestination[] {
  const out: CredentialDestination[] = [];

  // Password-form actions (or the page URL when the action is empty → self-post).
  for (const form of doc.querySelectorAll("form")) {
    if (!form.querySelector('input[type="password"]')) continue;
    const action = getAttrCI(form, "action");
    const host = hrefHost(action, base) ?? hrefHost(base, base);
    if (host) out.push({ host, path: hrefPath(action, base), brandLabeled: "", signIn: false });
  }

  // Auth-labeled controls: only those whose own label is a sign-in affordance.
  const AUTH_LABEL = /\b(sign in|log in|login|continue with|verify)\b/;
  const SIGN_IN_LABEL = /\b(sign in|log in|login)\b/;
  // "Continue with Google" / "Continue with Microsoft": the providers' own button wording. "Continue with
  // Microsoft account" is a link about an account, not the button (pub#696).
  // A space is optional between the words, so a label split by markup (`Sign<br>in with Goo<i>gle</i>`, read as
  // `signin with google`) is the same cue; the boundaries at each end are whole-word.
  const PROVIDER_BUTTON =
    /(?<![\p{L}\p{N}])(?:continue|sign ?in|log ?in|logon) ?with ?(?:google|microsoft)(?![\p{L}\p{N}])(?! ?account)/u;
  for (const control of collectControls(doc)) {
    const { labels } = control;
    const providerButton =
      labels.some((label) => PROVIDER_BUTTON.test(label));
    if (!providerButton && !labels.some((label) => AUTH_LABEL.test(label))) continue;
    // A link's destination is its href; a button's is its formaction or its form's action. A control with
    // neither (a script-driven button) has no destination to judge.
    const host =
      control.href === null ? null : (hrefHost(control.href, base) ?? hrefHost(base, base));
    if (!host) continue;
    const brandSpec = BRAND_SPECS.find((s) =>
      s.lexicon.some(
        (p) => labels.some((label) => hasPhrase(label, p))
      )
    );
    const brand = brandSpec?.brand ?? "";
    // "Continue with Google" is the provider's own button wording: a control that names the brand in an
    // "<action> with <brand>" phrase is a sign-in affordance by itself.
    const signIn = providerButton || labels.some((label) => SIGN_IN_LABEL.test(label));
    out.push({ host, path: hrefPath(control.href, base), brandLabeled: brand, signIn });
  }

  return out;
}

/**
 * Detect a third-party brand auth/booking surface that is NOT backed by that
 * brand's legitimate host and NOT on the site's own origin. Requires the brand
 * lexicon AND an action cue AND a credential surface whose DESTINATION is
 * off-brand — a bare mention (e.g. "we integrate with Calendly") never fires,
 * and a legit "Sign in with Google" → accounts.google.com is spared even if the
 * page also links to unrelated third parties (footer/social links are ignored).
 */
export function detectBrandImpersonation(
  ctx: PageSignalContext
): BrandImpersonationHit | null {
  const doc = ctx.parsed.document;
  if (!doc) return null;

  const haystack = authHaystack(ctx);

  const self = selfHosts(ctx);
  const credDests = credentialDestinations(doc, ctx.page.url);

  // A credential affordance must exist at all: a password field, auth copy, or
  // a control whose own label says sign in or log in, so a missing page-wide
  // word boundary cannot override the control's evidence (pub#696). A link
  // labelled only "verify" or "continue with" is not one by itself.
  const hasCredentialAffordance =
    doc.querySelector('input[type="password"]') !== null ||
    credDests.some((d) => d.signIn) ||
    /\b(sign in|log in|login|enter your password|verify your account)\b/.test(
      haystack
    );
  if (!hasCredentialAffordance) return null;

  for (const spec of BRAND_SPECS) {
    // The brand and an action cue are in the page's text, or in the label of a control that names the brand
    // (a label held only in `aria-label`, `title` or a logo's `alt` is in no text).
    const controlNamesBrand = credDests.some((d) => d.brandLabeled === spec.brand);
    const matchedBrand = controlNamesBrand || spec.lexicon.some((p) => haystack.includes(p));
    if (!matchedBrand) continue;

    const hasAction = controlNamesBrand || spec.actionCues.some((c) => haystack.includes(c));
    if (!hasAction) continue; // bare mention → not impersonation

    // The decisive, FP-safe condition: a credential control EXPLICITLY LABELED
    // with THIS brand ("Sign in with Google") whose destination is neither the
    // brand's legit host nor our own site (sibling subdomains on the same
    // registrable domain count as self — www.acme.com → app.acme.com). A bare
    // prose mention, a generic self-app "Sign in", or a real
    // accounts.google.com link are all spared.
    const offBrandDests = credDests.filter(
      (d) =>
        !hostMatches(d.host, spec.legitHosts) &&
        !isBrokerEndpoint(spec.brand, d.host, d.path) &&
        !isSelfOrSameSite(d.host, self)
    );
    const brandLabeledOffBrand = offBrandDests.filter(
      (d) => d.brandLabeled === spec.brand
    );

    if (brandLabeledOffBrand.length > 0) {
      const where = `"${spec.brand}" sign-in control targets off-brand host(s): ${brandLabeledOffBrand
        .map((d) => d.host)
        .slice(0, 3)
        .join(", ")}`;
      return {
        brand: spec.brand,
        reason: `Page impersonates ${spec.brand} — ${where}`,
      };
    }
  }

  return null;
}

// ── Obfuscated inline script ────────────────────────────────────────

const PACKER_MARKERS = [
  "eval(",
  'function("return this")',
  "function('return this')",
  "atob(",
  "unescape(",
  "fromcharcode",
  "the code has been tampered",
  "_0x", // common hex-mangled identifier prefix from JS obfuscators
];

/** Shannon entropy (bits/char) of a string — high for packed/encoded blobs. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export interface ObfuscatedScriptHit {
  sizeBytes: number;
  entropy: number;
  markers: string[];
}

/**
 * Score INLINE scripts on length + entropy + packer markers. Fires only when a
 * large inline script combines high entropy with obfuscation markers — a normal
 * (even large) minified bundle has packer-ish density but lacks eval/anti-tamper
 * cues, and a small inline snippet never trips regardless of markers.
 */
export function detectObfuscatedScript(
  ctx: PageSignalContext,
  opts: { minBytes: number; minEntropy: number } = {
    minBytes: 4096,
    minEntropy: 4.5,
  }
): ObfuscatedScriptHit | null {
  const doc = ctx.parsed.document;
  if (!doc) return null;

  let best: ObfuscatedScriptHit | null = null;
  for (const script of doc.querySelectorAll("script")) {
    // Inline only — external scripts are out of scope for this signal.
    if (getAttrCI(script, "src")) continue;
    const code = script.textContent ?? "";
    if (code.length < opts.minBytes) continue;

    const lower = code.toLowerCase();
    const markers = PACKER_MARKERS.filter((m) => lower.includes(m));
    if (markers.length === 0) continue;

    const entropy = shannonEntropy(code);
    if (entropy < opts.minEntropy) continue;

    const hit: ObfuscatedScriptHit = {
      sizeBytes: code.length,
      entropy: Math.round(entropy * 100) / 100,
      markers,
    };
    if (!best || hit.sizeBytes > best.sizeBytes) best = hit;
  }
  return best;
}

// ── Fake auth overlay ───────────────────────────────────────────────

/** `src` as an origin and path only, at most 120 characters: never userinfo, a query token or a fragment. */
function safeSrc(src: string, base: string): string {
  if (!src) return "";
  try {
    const url = new URL(src, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return `(${url.protocol.replace(":", "")} source)`;
    return `${url.origin}${url.pathname}`.slice(0, 120);
  } catch {
    return "(unparsed source)";
  }
}

/**
 * What the bounded scans left unread on this page (#784): sign-in controls whose text was past the reading
 * budget, and CSS past the amount read. Both are work bounds, spent most-relevant first; this says when one
 * was hit, so a clean result on such a page is not read as "nothing there".
 */
export function integrityScanNotes(ctx: PageSignalContext): { controlsUnread?: number; cssTruncated?: true } {
  const doc = ctx.parsed.document;
  if (!doc) return {};
  const unread = scanControls(doc).unread;
  return {
    ...(unread > 0 ? { controlsUnread: unread } : {}),
    ...(cssScanTruncated(doc) ? { cssTruncated: true as const } : {}),
  };
}

export interface FakeAuthOverlayHit {
  reason: string;
}

/**
 * Detect a credential-overlay pattern: a full-viewport, fixed-position,
 * high-z-index iframe (the classic injected `#google-auth` overlay) OR a
 * "Sign in with <brand>" control whose target is an off-brand host. Conservative
 * — a fixed cookie-banner iframe won't match (it lacks the viewport-filling
 * dimensions + the auth affordance).
 */
export function detectFakeAuthOverlay(
  ctx: PageSignalContext
): FakeAuthOverlayHit | null {
  const doc = ctx.parsed.document;
  if (!doc) return null;

  const self = selfHosts(ctx);

  // Page-level auth corroboration — required for the iframe-overlay branch so a
  // legitimate full-page app-shell / portal iframe doesn't trip it.
  const haystack = authHaystack(ctx);
  const pageHasAuthAffordance =
    doc.querySelector('input[type="password"]') !== null ||
    /\b(sign in|log in|enter your password|verify your account)\b/.test(
      haystack
    );

  // 1) Full-viewport fixed high-z iframe overlay. To avoid flagging legitimate
  // full-page app shells/portals, require BOTH the overlay geometry AND auth
  // intent: an auth-suggestive iframe id/class/src, OR an off-self iframe source
  // combined with page-level auth copy / a password field.
  for (const frame of doc.querySelectorAll("iframe")) {
    const id = (getAttrCI(frame, "id") ?? "").toLowerCase();
    const cls = (getAttrCI(frame, "class") ?? "").toLowerCase();
    const src = getAttrCI(frame, "src") ?? "";
    const srcHost = hrefHost(src, ctx.page.url);
    const srcIsSelf = srcHost ? self.has(srcHost) : true; // no/empty src → self

    // Auth-suggestive identifier (the injected `#google-auth` pattern).
    const authIdentifier =
      /(auth|login|signin|sign-in|oauth|verify|credential)/.test(
        `${id} ${cls}`
      ) || /(auth|login|signin|sign-in|oauth|verify)/.test(src.toLowerCase());

    // Fire only when the overlay carries auth intent: either an auth-suggestive identifier, or it loads an
    // off-self source AND the page shows auth copy. A frame with neither cannot fire, so its CSS is never
    // resolved: padding with ordinary frames costs the loop and nothing more.
    if (!(authIdentifier || (!srcIsSelf && pageHasAuthAffordance))) continue;

    const geometry = overlayGeometry(doc, frame);
    const zIndex = geometry.zIndex;
    if (!(geometry.fixed && zIndex >= 1000 && geometry.fillsViewport && geometry.pinned)) continue;

    {
      // The reason reaches reports: what the page chose (id, src) is shown as an origin and path only, with no
      // userinfo, query token or fragment, and bounded (#784).
      const shownId = id.replace(/[^\w-]/g, "").slice(0, 60);
      const shownSrc = safeSrc(src, ctx.page.url);
      return {
        reason: `Full-viewport fixed iframe (z-index ${zIndex}${
          shownId ? `, #${shownId}` : ""
        })${shownSrc ? ` loading ${shownSrc}` : ""} overlays the page — credential-overlay pattern`,
      };
    }
  }

  // NOTE: the "Sign in with <brand> → off-brand host" link pattern is owned by
  // detectBrandImpersonation. It is deliberately NOT re-detected here so the two
  // signals stay DISTINCT — otherwise one off-brand sign-in link would count as
  // two corroborating signals and wrongly satisfy the >=2-signal gate on its own.
  return null;
}

// ── SEO doorway ─────────────────────────────────────────────────────
//
// Injected affiliate/keyword-stuffed posts that are off-topic vs the rest of the
// site. Detected from this page alone via: brand-funnel doorway lexicon in the
// title + thin/keyword-stuffed body. Site-wide topic divergence (the stronger
// signal) is handled by the site-scope template-discontinuity / orphan rules and
// folds in via correlation.

const DOORWAY_LEXICON = [
  "clickfunnels",
  "kajabi",
  "affiliate",
  "make money online",
  "passive income",
  "best funnel",
  "sales funnel",
];

export interface SeoDoorwayHit {
  reason: string;
  matchedTerms: string[];
}

/**
 * Detect an injected doorway post: doorway-lexicon terms in the title AND a thin,
 * keyword-stuffed body. Requires multiple distinct lexicon hits so a single
 * legitimate "affiliate disclosure" mention doesn't fire.
 */
export function detectSeoDoorway(ctx: PageSignalContext): SeoDoorwayHit | null {
  const title = (ctx.parsed.meta.title ?? "").toLowerCase();
  const text = (ctx.parsed.content.textContent ?? "").toLowerCase();

  const titleHits = DOORWAY_LEXICON.filter((t) => title.includes(t));
  if (titleHits.length === 0) return null;

  const bodyHits = DOORWAY_LEXICON.filter((t) => text.includes(t));
  const distinct = new Set([...titleHits, ...bodyHits]);
  if (distinct.size < 2) return null; // need real keyword stuffing, not one mention

  // Keyword density of the most-repeated doorway term — stuffed posts hammer it.
  // Count PHRASE occurrences (not loose token membership), so a multi-word term
  // like "make money online" isn't inflated by every lone "make" in the body.
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length || 1;
  const countOccurrences = (haystack: string, phrase: string): number => {
    if (!phrase) return 0;
    let count = 0;
    let idx = haystack.indexOf(phrase);
    while (idx !== -1) {
      count++;
      idx = haystack.indexOf(phrase, idx + phrase.length);
    }
    return count;
  };
  let topCount = 0;
  for (const term of distinct) {
    // Weight by the term's own word length so single- and multi-word terms are
    // density-comparable (a phrase covers more of the document per occurrence).
    const occ = countOccurrences(text, term);
    const coverage = occ * term.split(" ").length;
    if (coverage > topCount) topCount = coverage;
  }
  const density = topCount / wordCount;

  const isThin = ctx.parsed.content.isThinContent || wordCount < 500;
  const isStuffed = density > 0.03; // >3% single-term density is anomalous

  if (!isThin && !isStuffed) return null;

  return {
    reason: `Off-topic affiliate doorway: title pushes ${titleHits
      .slice(0, 2)
      .join(", ")}; ${isThin ? "thin body" : ""}${
      isThin && isStuffed ? " + " : ""
    }${isStuffed ? `keyword density ${(density * 100).toFixed(1)}%` : ""}`.trim(),
    matchedTerms: [...distinct],
  };
}

// ── Correlation ─────────────────────────────────────────────────────

/**
 * Per-document memo of the computed signal set. Every page-scope rule calls
 * detectPageSignals for its OWN page, and the two site rules call it again for
 * each outlier/hidden page — so without memoization a single page's four
 * sub-detectors (incl. the Shannon-entropy pass over a large inline script) run
 * many times per audit. Keyed on the parsed `Document` object (stable for a
 * page's lifetime within a run) via a WeakMap so entries are GC'd with the doc
 * and never leak across runs. Pages with a null document (error pages) are not
 * cached — they always return an empty set cheaply.
 */
const signalCache = new WeakMap<object, Set<IntegritySignal>>();

/**
 * Compute the set of DISTINCT page-level integrity signals present on this page.
 * Shared by every page-scope rule so each can correlate without a cross-rule
 * aggregation point in the runner. Memoized per parsed document.
 */
export function detectPageSignals(ctx: PageSignalContext): Set<IntegritySignal> {
  const doc = ctx.parsed.document;
  if (doc) {
    const cached = signalCache.get(doc);
    if (cached) return cached;
  }

  const signals = new Set<IntegritySignal>();
  if (detectBrandImpersonation(ctx)) signals.add("brand-impersonation");
  if (detectObfuscatedScript(ctx)) signals.add("obfuscated-script");
  if (detectFakeAuthOverlay(ctx)) signals.add("fake-auth-overlay");
  if (detectSeoDoorway(ctx)) signals.add("seo-doorway");

  if (doc) signalCache.set(doc, signals);
  return signals;
}

/**
 * Given the full signal set on a page, decide whether a rule whose own signal is
 * `own` should escalate to high severity. Escalate only when >=2 DISTINCT
 * signals fire (the owning rule's signal counts as one). A lone signal → `info`.
 */
export function shouldEscalate(
  signals: Set<IntegritySignal>,
  own: IntegritySignal
): boolean {
  return signals.has(own) && signals.size >= CORRELATION_THRESHOLD;
}
