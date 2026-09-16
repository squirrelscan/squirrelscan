// The full case list: every generator in every context that accepts it, the
// hand-written negatives, and the known-defect probes. Each case says exactly
// what the rule must report for it (pattern, check, location) after its own
// dedup-by-value.

import { CONTEXT_PATTERNS, FAST_PATTERNS, scanContent } from "../../../src/security/leaked-secrets";
import { CONTEXTS, type Location } from "./contexts";
import {
  algoliaSecuredKey,
  awsKeySuffix,
  GENERATORS,
  githubToken,
  githubTokenFrom,
  issuerJwt,
  mixedRun,
  runOf,
  seededRng,
  supabaseJwt,
  tripsFalsePositiveFilter,
  type Generated,
  type Generator,
} from "./generators";
import { NEGATIVES } from "./negatives";
import { DEDUP_CASES, REAL_WORLD, ROUND_3 } from "./real-world";

/** `info`: the `leaked-secrets-info` check (#361): expired or session tokens, never a leak. */
export type Check = "high" | "medium" | "public" | "info";

export interface Expectation {
  pattern: string;
  check: Check;
  location: Location;
}

export interface Case {
  id: string;
  url: string;
  html: string;
  scripts?: Array<{ url: string; content: string }>;
  /** Exact set of rule-level findings, order-insensitive. */
  expect: Expectation[];
  /** Patterns that must not appear at all, whatever else does. */
  mustNotFire?: string[];
  /** The sensitive core: the masked report must never contain it. */
  secret?: string;
  /**
   * Set when `expect` encodes CURRENT behaviour that is wrong. The test suite
   * asserts it as-is (so the suite is green today) and lists it as a todo.
   */
  knownGap?: string;
}

/** The check a pattern's finding lands in, from the detector's own tables. */
export function checkFor(pattern: string): Check {
  const fast = FAST_PATTERNS.find((p) => p.name === pattern);
  if (fast) return fast.publicByDesign ? "public" : fast.confidence;
  const ctx = CONTEXT_PATTERNS.find((p) => p.name === pattern);
  if (ctx) return ctx.publicByDesign ? "public" : ctx.confidence;
  throw new Error(`no such pattern: ${pattern}`);
}

/** FNV-1a over the id, so a case's seed does not depend on list order. */
function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** `Stripe Live Key` -> `stripeLiveKey`, the object key a prefixed value sits under. */
function keyNameFor(g: Generator): string {
  if (g.keyName) return g.keyName;
  const words = g.pattern.replace(/[()]/g, "").split(/\s+/);
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
}

// Defects the corpus encodes as CURRENT behaviour. Keyed by pattern name.
const PATTERN_GAPS: Record<string, { expectPattern: string | null; gap: string }> = {
  "Clerk Secret Key": {
    expectPattern: "Stripe Live Key",
    gap: "Clerk `sk_live_[a-zA-Z0-9]{40,}` can never fire: Stripe Live `sk_live_{24,}` runs first and the overlap dedup drops it",
  },
};

/**
 * A value that trips the detector's substring false-positive list (`xxx`,
 * `fake`, `sample`…) is redrawn: the corpus wants every positive to be a
 * positive, and the filter's behaviour on random keys is its own probe below.
 */
function draw(g: Generator, id: string): Generated {
  for (let attempt = 0; ; attempt++) {
    const value = g.make(seededRng(seedOf(attempt === 0 ? id : `${id}#${attempt}`)));
    if (tripsFalsePositiveFilter(value.text)) continue;
    // A positive has to fire when scanned bare: a random draw can land under
    // the generic tier's entropy floor (#357) the way it can land on a
    // placeholder word, and a case built on such a draw would pin nothing.
    if (!firesBare(g, value)) continue;
    return value;
  }
}

/** Does the value fire its own pattern in the plainest assignment there is? */
function firesBare(g: Generator, value: Generated): boolean {
  const keyName = g.keyName ?? "value";
  const js = g.tier === "assignment" ? `var c={${value.text}};` : `var c={${keyName}:${JSON.stringify(value.text)}};`;
  return scanContent(js, "inline-script").length > 0;
}

// The Bearer pattern's own value class. A value carrying a character outside
// it (`.` in a JWT, `;` in an Azure string) is matched only up to that
// character, and that shorter match neither contains nor sits inside the
// value's own finding, so it is reported as a second, unrelated Bearer Token.
const BEARER_RE = /Bearer\s+[a-zA-Z0-9_+/-]{20,}={0,2}/;

// The detector's generic-value entropy floor, mirrored: a Bearer prefix that
// is mostly one repeated character (Twitter's nineteen `A`s) or a small
// alphabet (base64 of a decimal snowflake) is not reported as a token.
function shannon(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

function bearerDuplicate(text: string): boolean {
  const m = BEARER_RE.exec(`Bearer ${text}`);
  if (m === null || m[0].includes(text)) return false;
  // A JWT head is the JWT pattern's, never a second Bearer finding.
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]/.test(text)) return false;
  const body = m[0].replace(/^Bearer\s+/, "").replace(/=+$/, "");
  return shannon(body) >= 3.5 && !tripsFalsePositiveFilter(body);
}

const POSITIVES: Case[] = GENERATORS.flatMap((g) =>
  CONTEXTS.filter((c) => c.accepts.includes(g.tier) && !g.notIn?.includes(c.id)).map((c): Case => {
    const id = `${slug(g.pattern)}@${c.id}`;
    const value = draw(g, id);
    const keyName = keyNameFor(g);
    const embedded = c.embedTiered(value, keyName, g.tier);

    const gap = PATTERN_GAPS[g.pattern];
    const claimed = g.tier === "keyed" && c.claims ? c.claims : g.pattern;
    const pattern = gap ? gap.expectPattern : claimed === g.pattern && g.reportedAs ? g.reportedAs : claimed;
    // A generator says which check its value lands in when a decoder (#361)
    // moves it off the pattern's tier; a context that claims the value first
    // (`Bearer …`) reports under its own pattern's tier instead.
    const check =
      pattern === (g.reportedAs ?? g.pattern) && g.check ? g.check : pattern ? checkFor(pattern) : "medium";
    const expect: Expectation[] = pattern ? [{ pattern, check, location: c.location }] : [];
    let knownGap = gap?.gap;

    if (c.claims === "Bearer Token" && g.tier === "keyed" && !BEARER_RE.test(`Bearer ${value.text}`)) {
      // Under the Bearer pattern's 20-char floor, and the context tier does
      // not read `Bearer ` as a value position: nothing reports.
      expect.length = 0;
      knownGap =
        "`Authorization: Bearer <value>` with a value under 20 chars (LinkedIn's 16) is reported by neither tier: Bearer has a 20-char floor and isInValuePosition does not treat `Bearer ` as an assignment";
    }

    if (c.claims === "Bearer Token" && g.tier === "prefixed" && bearerDuplicate(value.text)) {
      expect.push({ pattern: "Bearer Token", check: "medium", location: c.location });
      knownGap =
        "`Authorization: Bearer <value>` around a value with a `.`, `;` or `%` (JWTs, OAuth client ids, Azure strings) reports a second medium \"Bearer Token\" for the prefix: a duplicate, and for a public-tier key a false warning";
    }

    return {
      id,
      url: "https://app.acme.test/dashboard",
      html: embedded.html,
      scripts: embedded.scripts,
      expect,
      secret: value.secret,
      knownGap,
    };
  }),
);

// Probes for defects that are about interaction between patterns or about the
// FP filters, rather than about one pattern's shape.
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGIT = "0123456789";
const HEX = "0123456789abcdef";
const UPPER = LOWER.toUpperCase();
const ALNUM = LOWER + UPPER + DIGIT;
const URL = "https://app.acme.test/dashboard";
const inline = (js: string) =>
  `<!DOCTYPE html><html><head><title>x</title></head><body><script>${js}</script></body></html>`;

// Each probe draws from its own id-seeded RNG, so adding or reordering one
// changes nothing else (and nothing in the snapshot but its own rows).
const probe = (id: string, build: (r: ReturnType<typeof seededRng>) => Omit<Case, "id" | "url">): Case => ({
  id: `probe:${id}`,
  url: URL,
  ...build(seededRng(seedOf(`probe:${id}`))),
});

const PROBES: Case[] = [
  probe("paypal-eats-azure-account-key", (r) => ({
    html: inline(
      `window.__AZ__={conn:"DefaultEndpointsProtocol=https;AccountName=acmeprod;AccountKey=az${runOf(r, LOWER + DIGIT, 84)}==;EndpointSuffix=core.windows.net"};`,
    ),
    // PayPal used to run before Azure and claim a 60+ lowercase run inside
    // the AccountKey, and the whole connection string was then an "overlap"
    // of it. Azure runs first now, and PayPal needs a value position (#357).
    expect: [{ pattern: "Azure Storage Key", check: "high", location: "inline-script" }],
    mustNotFire: ["PayPal Client ID"],
  })),
  probe("cohere-window-claims-together-key", (r) => ({
    html: inline(
      `window.__AI__={provider:"cohere",fallback:"together",togetherKey:"${runOf(r, DIGIT, 1)}${runOf(r, HEX, 63)}"};`,
    ),
    // Cohere's `[a-zA-Z0-9]{40}` used to take the first 40 hex chars and
    // Together's 64-char match was suppressed as an overlap. Values are
    // word-bounded now, so a 40-run inside a 64-run is not a value (#357).
    expect: [{ pattern: "Together AI Key", check: "medium", location: "inline-script" }],
    mustNotFire: ["Cohere API Key"],
  })),
  // A QUOTED value under a key that says credential is a string literal, and
  // reads as one however it is spelt (#357). The identifier heuristic still
  // applies to unquoted values (`apiKey: getSegmentKey`).
  probe("keyed-value-opening-camelcase-is-kept-when-quoted", (r) => ({
    html: inline(`window.__CFG__={cohereKey:"ab${runOf(r, "CDEFGHJKLMNPQRSTUVWXYZ", 1)}${runOf(r, ALNUM, 37)}"};`),
    expect: [{ pattern: "Cohere API Key", check: "medium", location: "inline-script" }],
  })),
  probe("keyed-value-with-underscore-is-kept-when-quoted", (r) => ({
    html: inline(`window.__CFG__={cloudflareToken:"${runOf(r, DIGIT, 1)}${runOf(r, LOWER + DIGIT, 20)}_${runOf(r, LOWER + DIGIT, 18)}"};`),
    expect: [{ pattern: "Cloudflare API Token", check: "medium", location: "inline-script" }],
  })),
  probe("keyed-value-with-verb-prefix-is-kept-when-quoted", (r) => ({
    html: inline(`window.__CFG__={mistralKey:"on${runOf(r, DIGIT, 30)}"};`),
    expect: [{ pattern: "Mistral API Key", check: "medium", location: "inline-script" }],
  })),
  probe("naming-attribute-after-the-value-in-the-same-tag", (r) => ({
    // The tag-scoped exception to the keyword gap: the naming attribute may
    // follow the value, with other attributes between them.
    html: `<!DOCTYPE html><html><head><title>x</title><meta content="${runOf(r, DIGIT, 1)}${runOf(r, HEX, 31)}" lang="en" dir="ltr" data-testid="row" name="algolia-search-key"></head><body></body></html>`,
    expect: [{ pattern: "Algolia API Key", check: "medium", location: "html" }],
  })),
  probe("keyed-identifier-unquoted-is-still-dropped", () => ({
    html: inline(`window.__CFG__={segmentKey:segmentAnalyticsMiddlewareFactoryInstance,mistralKey:getMistralCredential()};`),
    expect: [],
  })),
  probe("digitalocean-spaces-eats-new-relic", (r) => ({
    html: inline(`window.__NR__={licenseKey:"${runOf(r, "ABCEFGHJKLMNPQRSTUVWXYZ0123456789", 20)}DO${runOf(r, "ABCEFGHJKLMNPQRSTUVWXYZ0123456789", 18)}${["NR", "AL"].join("")}"};`),
    // DigitalOcean Spaces `DO[A-Z0-9]{20,}` used to run before New Relic and
    // claim the tail. It runs after now, and the tail is mid-token anyway.
    expect: [{ pattern: "New Relic License Key", check: "high", location: "inline-script" }],
    mustNotFire: ["DigitalOcean Spaces Key"],
  })),
  probe("fp-filter-is-a-substring-test", (r) => ({
    // A GitHub token whose random body happens to contain `xxx`. The filter
    // list used to be substring tests over the whole value and dropped it;
    // it is anchored to the value's head and tail now (#357). The checksum
    // is valid (#361), so the token reports.
    html: inline(`window.__T__={${["gh", "p_"].join("")}:"${githubTokenFrom(["gh", "p_"].join(""), `${runOf(r, ALNUM, 14)}Xxx${runOf(r, ALNUM, 13)}`)}"};`),
    expect: [{ pattern: "GitHub Personal Access Token", check: "high", location: "inline-script" }],
  })),
  probe("supabase-service-role-jwt-is-called-public", (r) => ({
    html: inline(`const supabase=createClient("https://${runOf(r, LOWER, 20)}.supabase.co",${JSON.stringify(supabaseJwt(r, "service_role"))});`),
    // The anon and service-role keys are both HS256 JWTs from the same
    // issuer; only the `role` claim differs, and the detector decodes it (#361).
    expect: [{ pattern: "Supabase Service Role JWT", check: "high", location: "inline-script" }],
    mustNotFire: ["Supabase Anon Key"],
  })),

  // ── Token structure (#361) ────────────────────────────────────────────
  probe("aws-key-id-outside-base32-is-medium", (r) => ({
    // `0`, `1`, `8`, `9` are not base32: no account id decodes, so not high.
    html: inline(`window.__S3__={accessKeyId:"${["AK", "IA"].join("")}${runOf(r, "0189", 4)}${awsKeySuffix(r).slice(4)}"};`),
    expect: [{ pattern: "AWS Access Key ID", check: "medium", location: "inline-script" }],
  })),
  probe("aws-key-id-in-base32-is-high", (r) => ({
    html: inline(`window.__S3__={accessKeyId:"${["AK", "IA"].join("")}${awsKeySuffix(r)}"};`),
    expect: [{ pattern: "AWS Access Key ID", check: "high", location: "inline-script" }],
  })),
  probe("github-token-with-wrong-checksum-is-dropped", (r) => {
    const valid = githubToken(r, ["gh", "p_"].join(""));
    // Flip the last checksum character to a different one.
    const last = valid.slice(-1);
    const wrong = valid.slice(0, -1) + (last === "0" ? "1" : "0");
    return {
      html: inline(`window.__GH__={token:"${wrong}"};`),
      expect: [],
      mustNotFire: ["GitHub Personal Access Token"],
    };
  }),
  probe("github-token-with-valid-checksum-is-high", (r) => ({
    html: inline(`window.__GH__={token:"${githubToken(r, ["gh", "p_"].join(""))}"};`),
    expect: [{ pattern: "GitHub Personal Access Token", check: "high", location: "inline-script" }],
  })),
  probe("supabase-anon-jwt-is-public", (r) => ({
    html: inline(`const supabase=createClient("https://${runOf(r, LOWER, 20)}.supabase.co",${JSON.stringify(supabaseJwt(r, "anon"))});`),
    expect: [{ pattern: "Supabase Anon Key", check: "public", location: "inline-script" }],
  })),
  probe("expired-supabase-jwt-is-info", (r) => ({
    html: inline(`const supabase=createClient("https://${runOf(r, LOWER, 20)}.supabase.co",${JSON.stringify(supabaseJwt(r, "service_role", 1600000000))});`),
    expect: [{ pattern: "Supabase JWT (expired)", check: "info", location: "inline-script" }],
    mustNotFire: ["Supabase Service Role JWT", "Supabase Anon Key"],
  })),
  probe("long-lived-first-party-jwt-is-medium-never-supabase", (r) => ({
    // A subject, but `exp` seven years out with no `iat`: not a session.
    html: inline(
      `window.__SESSION__={token:${JSON.stringify(issuerJwt(r, { iss: "https://auth.acme.test", sub: `usr_${runOf(r, ALNUM, 12)}`, aud: "acme-web", exp: 2000000000 }))}};`,
    ),
    expect: [{ pattern: "JSON Web Token", check: "medium", location: "inline-script" }],
    mustNotFire: ["Supabase Anon Key"],
  })),
  // Session tokens: the crawl is an anonymous visitor, and what it sees on
  // the page is at most its own session. Info, not a warning.
  probe("first-party-session-jwt-with-sub-is-info", (r) => ({
    html: inline(
      `window.__SESSION__={token:${JSON.stringify(issuerJwt(r, { iss: "https://auth.acme.test", sub: `usr_${runOf(r, ALNUM, 12)}`, aud: "acme-web", iat: 2000000000 - 3600, exp: 2000000000 }))}};`,
    ),
    expect: [{ pattern: "Session Token (JWT)", check: "info", location: "inline-script" }],
    mustNotFire: ["JSON Web Token", "Supabase Anon Key"],
  })),
  probe("session-jwt-with-user-id-and-two-day-exp-is-info", (r) => ({
    // The studyfrcr / store-api shape: `user_id` for the subject, two days of life.
    html: inline(
      `window.__USER__={token:${JSON.stringify(issuerJwt(r, { user_id: Math.floor(r() * 1e6), email: `u${runOf(r, DIGIT, 4)}@acme.test`, iat: 2000000000 - 86400 * 2, exp: 2000000000 }))}};`,
    ),
    expect: [{ pattern: "Session Token (JWT)", check: "info", location: "inline-script" }],
  })),
  probe("first-party-session-jwt-with-sid-and-no-issuer-is-info", (r) => ({
    html: inline(
      `window.__SESSION__={token:${JSON.stringify(issuerJwt(r, { sid: runOf(r, ALNUM, 24), iat: 2000000000 - 86400 * 14, exp: 2000000000 }))}};`,
    ),
    expect: [{ pattern: "Session Token (JWT)", check: "info", location: "inline-script" }],
  })),
  probe("session-shaped-jwt-without-exp-is-medium", (r) => ({
    html: inline(
      `window.__SESSION__={token:${JSON.stringify(issuerJwt(r, { iss: "https://auth.acme.test", sub: `usr_${runOf(r, ALNUM, 12)}` }))}};`,
    ),
    expect: [{ pattern: "JSON Web Token", check: "medium", location: "inline-script" }],
  })),
  probe("session-shaped-jwt-living-past-thirty-days-is-medium", (r) => ({
    html: inline(
      `window.__SESSION__={token:${JSON.stringify(issuerJwt(r, { iss: "https://auth.acme.test", sub: `usr_${runOf(r, ALNUM, 12)}`, iat: 2000000000 - 86400 * 31, exp: 2000000000 }))}};`,
    ),
    expect: [{ pattern: "JSON Web Token", check: "medium", location: "inline-script" }],
  })),
  probe("short-lived-jwt-from-a-third-party-issuer-is-medium", (r) => ({
    html: inline(
      `window.__AUTH__={token:${JSON.stringify(issuerJwt(r, { iss: "https://acme.eu.auth0.com/", sub: `auth0|${runOf(r, HEX, 24)}`, iat: 2000000000 - 3600, exp: 2000000000 }))}};`,
    ),
    expect: [{ pattern: "JSON Web Token", check: "medium", location: "inline-script" }],
    mustNotFire: ["Session Token (JWT)"],
  })),
  // A session-shaped payload does not make a token the visitor's own when
  // the page is SENDING it: an Authorization literal (any quoting, including
  // an RSC flight payload's escaped JSON) or a credential key keeps the tier
  // the claims decode to, minimum medium.
  probe("session-shaped-jwt-in-an-rsc-flight-authorization-header-is-medium", (r) => {
    const token = issuerJwt(r, { iss: "https://vercel.acme.test", sub: `dpl_${runOf(r, ALNUM, 12)}`, iat: 2000000000 - 600, exp: 2000000000 }, "RS256");
    return {
      html: inline(
        `self.__next_f.push([1,"3:{\\"x-vercel-sc-headers\\":\\"{\\\\\\"Authorization\\\\\\":\\\\\\"Bearer ${token}\\\\\\"}\\",\\"x-vercel-sc-host\\":\\"sc.acme.test\\"}\n"])`,
      ),
      secret: token,
      expect: [{ pattern: "JSON Web Token", check: "medium", location: "inline-script" }],
      mustNotFire: ["Session Token (JWT)", "Bearer Token"],
    };
  }),
  probe("session-shaped-rs256-jwt-in-a-bearer-literal-is-medium", (r) => ({
    html: inline(
      `const h={Authorization:"Bearer ${issuerJwt(r, { iss: "https://auth.acme.test", sub: `usr_${runOf(r, ALNUM, 12)}`, iat: 2000000000 - 3600, exp: 2000000000 }, "RS256")}"};`,
    ),
    expect: [{ pattern: "JSON Web Token", check: "medium", location: "inline-script" }],
    mustNotFire: ["Session Token (JWT)", "Bearer Token"],
  })),
  probe("session-shaped-jwt-under-a-credential-key-is-medium", (r) => ({
    html: inline(
      `window.__CFG__={apiKey:"${issuerJwt(r, { iss: "https://auth.acme.test", sub: `usr_${runOf(r, ALNUM, 12)}`, iat: 2000000000 - 3600, exp: 2000000000 })}"};`,
    ),
    expect: [{ pattern: "JSON Web Token", check: "medium", location: "inline-script" }],
    mustNotFire: ["Session Token (JWT)"],
  })),
  probe("standalone-rs256-session-jwt-is-info", (r) => ({
    html: inline(
      `var session="${issuerJwt(r, { iss: "https://auth.acme.test", sub: `usr_${runOf(r, ALNUM, 12)}`, iat: 2000000000 - 3600, exp: 2000000000 }, "RS256")}";`,
    ),
    expect: [{ pattern: "Session Token (JWT)", check: "info", location: "inline-script" }],
  })),
  probe("session-jwt-in-a-data-attribute-is-info", (r) => {
    const token = issuerJwt(r, { sid: runOf(r, ALNUM, 24), iat: 2000000000 - 3600, exp: 2000000000 }, "ES256");
    return {
      html: `<!DOCTYPE html><html><head><title>x</title></head><body><div id="app" data-session="${token}"></div></body></html>`,
      expect: [{ pattern: "Session Token (JWT)", check: "info", location: "html" }],
    };
  }),
  probe("session-jwt-under-a-token-key-is-info", (r) => ({
    html: inline(
      `window.__AUTH__={token:"${issuerJwt(r, { iss: "https://auth.acme.test", sub: `usr_${runOf(r, ALNUM, 12)}`, iat: 2000000000 - 3600, exp: 2000000000 })}",jwt:null};`,
    ),
    expect: [{ pattern: "Session Token (JWT)", check: "info", location: "inline-script" }],
  })),
  probe("rs256-supabase-service-role-jwt-is-high", (r) => ({
    // Which token it is comes from the claims, not from the header literal.
    html: inline(`const supabase=createClient("https://${runOf(r, LOWER, 20)}.supabase.co","${issuerJwt(r, { iss: "supabase", ref: runOf(r, LOWER, 20), role: "service_role", exp: 2000000000 }, "RS256")}");`),
    expect: [{ pattern: "Supabase Service Role JWT", check: "high", location: "inline-script" }],
  })),
  probe("shopify-storefront-jwt-is-public", (r) => ({
    // Shopify's boot code on every page of a shop: issued by the shop's own
    // myshopify.com domain, seven days, no subject.
    html: inline(
      `window.ShopifyAnalytics={meta:{page:{}}};window.__st={a:1};var storefrontToken="${issuerJwt(r, { iss: `${runOf(r, LOWER, 8)}.myshopify.com`, aud: "storefront", exp: 2000000000 })}";`,
    ),
    expect: [{ pattern: "Shopify Storefront JWT", check: "public", location: "inline-script" }],
    mustNotFire: ["JSON Web Token", "Session Token (JWT)"],
  })),
  probe("standalone-short-lived-jwt-without-a-subject-is-info", (r) => ({
    // The techmeme shape: no issuer, no subject, seven days of life, assigned
    // to a plain variable. A page cannot hand every visitor a secret that
    // expires next week.
    html: inline(
      `window.__FEED__={token:"${issuerJwt(r, { aud: "river", iat: 2000000000 - 86400 * 7, exp: 2000000000 })}",refresh:900};`,
    ),
    expect: [{ pattern: "Session Token (JWT)", check: "info", location: "inline-script" }],
    mustNotFire: ["JSON Web Token"],
  })),
  probe("short-lived-jwt-without-a-subject-in-an-authorization-literal-is-medium", (r) => ({
    html: inline(
      `const h={Authorization:"Bearer ${issuerJwt(r, { aud: "river", iat: 2000000000 - 86400 * 7, exp: 2000000000 })}"};`,
    ),
    expect: [{ pattern: "JSON Web Token", check: "medium", location: "inline-script" }],
    mustNotFire: ["Session Token (JWT)", "Bearer Token"],
  })),
  probe("short-lived-jwt-with-an-admin-scope-is-still-high", (r) => ({
    html: inline(
      `window.__API__={token:${JSON.stringify(issuerJwt(r, { iss: "https://api.acme.test", sub: runOf(r, ALNUM, 12), scope: "admin", iat: 2000000000 - 3600, exp: 2000000000 }))}};`,
    ),
    expect: [{ pattern: "JSON Web Token (admin scope)", check: "high", location: "inline-script" }],
  })),
  probe("anon-role-jwt-from-another-issuer-is-public", (r) => ({
    html: inline(
      `window.__HASURA__={token:${JSON.stringify(issuerJwt(r, { iss: "https://hasura.acme.test", role: "anon", sub: runOf(r, ALNUM, 12), exp: 2000000000 }))}};`,
    ),
    expect: [{ pattern: "JSON Web Token (anon role)", check: "public", location: "inline-script" }],
  })),
  probe("admin-scope-jwt-is-high", (r) => ({
    html: inline(
      `window.__API__={token:${JSON.stringify(issuerJwt(r, { iss: "https://api.acme.test", scope: "read:all write:all admin", sub: runOf(r, ALNUM, 12), exp: 2000000000 }))}};`,
    ),
    expect: [{ pattern: "JSON Web Token (admin scope)", check: "high", location: "inline-script" }],
  })),
  probe("algolia-secured-key-without-restrictions-is-medium", (r) => ({
    html: inline(`window.__ALGOLIA__={appId:"${runOf(r, UPPER, 10)}",algoliaSearchKey:"${algoliaSecuredKey(r, "")}"};`),
    expect: [{ pattern: "Algolia Secured API Key", check: "medium", location: "inline-script" }],
  })),
  probe("algolia-admin-shaped-hex-is-medium", (r) => ({
    html: inline(`window.__ALGOLIA__={appId:"${runOf(r, UPPER, 10)}",algoliaKey:"${runOf(r, DIGIT, 1)}${runOf(r, HEX, 31)}"};`),
    expect: [{ pattern: "Algolia API Key", check: "medium", location: "inline-script" }],
  })),
  probe("base64-near-algolia-that-is-not-a-secured-key-is-silent", (r) => ({
    html: inline(`window.__ALGOLIA__={appId:"${runOf(r, UPPER, 10)}",algoliaSearchKey:"${Buffer.from(runOf(r, LOWER + " ", 90)).toString("base64")}"};`),
    expect: [],
    mustNotFire: ["Algolia Secured API Key"],
  })),

  // ── Encoded content (#360): the boundaries ────────────────────────────
  probe("entity-encoded-prefix-characters-still-report", (r) => {
    const key = ["s", "k_li", "ve_"].join("") + runOf(r, ALNUM, 24);
    const encoded = [...key].map((c, i) => (i % 2 ? `&#${c.charCodeAt(0)};` : `&#x${c.charCodeAt(0).toString(16)};`)).join("");
    return {
      html: `<!DOCTYPE html><html><head><title>x</title></head><body><div data-stripe-key="${encoded}"></div></body></html>`,
      secret: key,
      expect: [{ pattern: "Stripe Live Key", check: "high", location: "html" }],
    };
  }),
  probe("escaped-backslash-before-u-is-not-an-escape", (r) => ({
    // `\\u0073` is a backslash followed by the letters `u0073`: the engine
    // never decodes it, so neither does the scanner.
    html: inline(`var re="\\\\u0073${["k_li", "ve_"].join("")}${runOf(r, ALNUM, 24)}";`),
    expect: [],
    mustNotFire: ["Stripe Live Key"],
  })),
  probe("base64-image-data-uri-is-never-decoded", (r) => {
    // A data URI whose base64 payload happens to decode to text carrying a
    // key. Real images never do; a data URI is skipped without decoding it.
    //
    // 200 KB, the acceptance criterion's size. The decoders add under a
    // millisecond to it (pinned in tests/security/secrets-decode.test.ts).
    const key = githubToken(r, ["gh", "p_"].join(""));
    const text = `{"token":"${key}","padding":"${runOf(r, LOWER + " ", 200_000)}"}`;
    const blob = Buffer.from(text).toString("base64");
    return {
      html: `<!DOCTYPE html><html><head><title>x</title></head><body><img alt="chart" src="data:image/png;base64,${blob}"></body></html>`,
      secret: key,
      expect: [],
    };
  }),
  probe("sri-hash-is-never-decoded", (r) => {
    // 48 bytes of text that carry a token, as a 64-character base64 hash.
    const key = githubToken(r, ["gh", "p_"].join(""));
    const blob = Buffer.from(`{"t":"${key}"}`).toString("base64");
    return {
      html: `<!DOCTYPE html><html><head><title>x</title><script src="/vendor.js" integrity="sha384-${blob}" crossorigin="anonymous"></script></head><body></body></html>`,
      secret: key,
      expect: [],
    };
  }),
  probe("base64-is-unwrapped-two-levels-and-no-further", (r) => {
    const key = githubToken(r, ["gh", "p_"].join(""));
    const one = Buffer.from(`{"config":{"token":"${key}","locale":"en-GB","theme":"dark"}}`).toString("base64");
    const two = Buffer.from(`{"payload":"${one}","v":2}`).toString("base64");
    const three = Buffer.from(`{"outer":"${two}","v":3}`).toString("base64");
    return {
      html: inline(`window.__TWO__="${two}";window.__THREE__="${three}";`),
      secret: key,
      // Two levels reports it, three does not; one finding for the value.
      expect: [{ pattern: "GitHub Personal Access Token", check: "high", location: "inline-script (base64)" }],
    };
  }),
  probe("url-encoded-settings-with-a-publishable-key-and-a-keyed-value", (r) => {
    // The real-corpus shape: a Stripe publishable key and a hex value under a
    // keyed name, both inside one URL-encoded JSON document.
    const pk = ["p", "k_li", "ve_"].join("") + runOf(r, ALNUM, 24);
    const settings = JSON.stringify({ key: pk, currency: "usd", algoliaKey: runOf(r, DIGIT, 1) + runOf(r, HEX, 31), locale: "en" });
    return {
      html: `<!DOCTYPE html><html><head><title>x</title></head><body><div data-stripe-settings="${encodeURIComponent(settings)}"></div></body></html>`,
      secret: pk,
      expect: [
        { pattern: "Stripe Publishable Key", check: "public", location: "html" },
        { pattern: "Algolia API Key", check: "medium", location: "html" },
      ],
    };
  }),
  probe("url-encoded-run-with-a-lone-percent-is-left-alone", (r) => ({
    // `%` followed by non-hex is a percent sign, and a run with fewer than
    // three escapes is not an encoded document; neither is decoded, so the
    // key written as `%73k_live_` is not assembled.
    html: inline(`var a="100%25 off%20now";var b="%73${["k_li", "ve_"].join("")}${runOf(r, ALNUM, 24)}";var c="50% %zz";`),
    expect: [],
    mustNotFire: ["Stripe Live Key"],
  })),
  probe("base64-binary-blob-is-skipped", (r) => ({
    html: inline(`window.__WASM__="${Buffer.from(Array.from({ length: 3000 }, () => Math.floor(r() * 256))).toString("base64")}";`),
    expect: [],
  })),
  probe("railway-token-is-a-plain-uuid", (r) => ({
    html: inline(`window.__ENV={"RAILWAY_TOKEN":"${[8, 4, 4, 4, 12].map((n) => runOf(r, HEX, n)).join("-")}"};`),
    expect: [],
    knownGap:
      "Railway API tokens are plain UUIDs; the `railway_[a-zA-Z0-9_-]{32,}` pattern matches a shape Railway does not issue",
  })),
  probe("generic-assignment-outranks-a-keyed-brand-pattern", (r) => ({
    // Not a gap, a documented ordering rule: the generic FAST assignments run
    // before the CONTEXT tier, so a value under `auth0ClientSecret` or
    // `twilioAuthToken` reports under the generic name, not the brand's.
    html: inline(
      `window.__CFG__={auth0ClientSecret:"${runOf(r, DIGIT, 1)}${runOf(r, ALNUM, 63)}",twilioAuthToken:"${runOf(r, DIGIT, 1)}${runOf(r, HEX, 31)}"};`,
    ),
    expect: [
      { pattern: "Generic Secret Assignment", check: "medium", location: "inline-script" },
      { pattern: "Generic Token Assignment", check: "medium", location: "inline-script" },
    ],
    mustNotFire: ["Auth0 Client Secret", "Twilio Auth Token"],
  })),
  probe("no-size-cap-on-external-script", (r) => ({
    html: `<!DOCTYPE html><html><head><title>x</title></head><body><script src="/big.js"></script></body></html>`,
    scripts: [
      {
        url: "https://app.acme.test/big.js",
        // 5 MB of filler, then the secret at the very end. Current behaviour:
        // scanned in full, found. There is no size cap.
        content: `${"var q0=function(a,b){return a+b};".repeat(160_000)}var t={${["gh", "p_"].join("")}:"${githubToken(r, ["gh", "p_"].join(""))}"};`,
      },
    ],
    expect: [{ pattern: "GitHub Personal Access Token", check: "high", location: "external-script" }],
    knownGap: "no size cap: a 5 MB external script is scanned in full (this pins the cost, not a wrong result)",
  })),
  probe("same-value-in-three-locations-reports-once", (r) => {
    const v = githubToken(r, ["gh", "p_"].join(""));
    return {
      html: `<!DOCTYPE html><html><head><title>x</title><meta name="gh-token" content="${v}"></head><body><script>window.__T__="${v}";</script><script src="/app.js"></script></body></html>`,
      scripts: [{ url: "https://app.acme.test/app.js", content: `var token="${v}";` }],
      secret: v,
      expect: [{ pattern: "GitHub Personal Access Token", check: "high", location: "external-script" }],
    };
  }),
];

export const CASES: Case[] = [...POSITIVES, ...NEGATIVES, ...REAL_WORLD, ...ROUND_3, ...DEDUP_CASES, ...PROBES];

export function caseById(id: string): Case {
  const found = CASES.find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

// Re-exported for the bench, which builds its filler with the same RNG.
export { mixedRun, runOf, seededRng };
