// The full case list: every generator in every context that accepts it, the
// hand-written negatives, and the known-defect probes. Each case says exactly
// what the rule must report for it (pattern, check, location) after its own
// dedup-by-value.

import { CONTEXT_PATTERNS, FAST_PATTERNS } from "../../../src/security/leaked-secrets";
import { CONTEXTS, type Location } from "./contexts";
import {
  GENERATORS,
  mixedRun,
  runOf,
  seededRng,
  supabaseJwt,
  tripsFalsePositiveFilter,
  type Generated,
  type Generator,
} from "./generators";
import { NEGATIVES } from "./negatives";

export type Check = "high" | "medium" | "public";

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
  if (ctx) return ctx.confidence;
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
  "Twitter Bearer Token": {
    expectPattern: null,
    gap: "Twitter bearer tokens open with 19 `A`s and the false-positive filter `/a{16,}/i` drops every one of them",
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
    if (g.pattern === "Twitter Bearer Token" || !tripsFalsePositiveFilter(value.text)) return value;
  }
}

// The Bearer pattern's own value class. A value carrying a character outside
// it (`.` in a JWT, `;` in an Azure string) is matched only up to that
// character, and that shorter match neither contains nor sits inside the
// value's own finding, so it is reported as a second, unrelated Bearer Token.
const BEARER_RE = /Bearer\s+[a-zA-Z0-9_+/-]{20,}={0,2}/;

function bearerDuplicate(text: string): boolean {
  const m = BEARER_RE.exec(`Bearer ${text}`);
  return m !== null && !m[0].includes(text) && !tripsFalsePositiveFilter(m[0]);
}

const POSITIVES: Case[] = GENERATORS.flatMap((g) =>
  CONTEXTS.filter((c) => c.accepts.includes(g.tier) && !g.notIn?.includes(c.id)).map((c): Case => {
    const id = `${slug(g.pattern)}@${c.id}`;
    const value = draw(g, id);
    const keyName = keyNameFor(g);
    const embedded = c.embedTiered(value, keyName, g.tier);

    const gap = PATTERN_GAPS[g.pattern];
    const claimed = g.tier === "keyed" && c.claims ? c.claims : g.pattern;
    const pattern = gap ? gap.expectPattern : claimed;
    const expect: Expectation[] = pattern ? [{ pattern, check: checkFor(pattern), location: c.location }] : [];
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
const ALNUM = LOWER + LOWER.toUpperCase() + DIGIT;
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
    // PayPal runs before Azure and its class covers lowercase+digits, so a
    // 60+ run of those after `az` inside the AccountKey is claimed first and
    // the whole connection string is then an "overlap" of it.
    expect: [{ pattern: "PayPal Client ID", check: "public", location: "inline-script" }],
    mustNotFire: ["Azure Storage Key"],
    knownGap:
      "PayPal `[Aa][Zz]…{60,}` runs before Azure Storage Key and claims a substring of the AccountKey, so a high finding is downgraded to a public info one",
  })),
  probe("cohere-window-claims-together-key", (r) => ({
    html: inline(
      `window.__AI__={provider:"cohere",fallback:"together",togetherKey:"${runOf(r, DIGIT, 1)}${runOf(r, HEX, 63)}"};`,
    ),
    // CONTEXT_PATTERNS run in order and Cohere's `[a-zA-Z0-9]{40}` is first:
    // with both brand words in the window it takes the first 40 hex chars and
    // Together's 64-char match is then suppressed as an overlap.
    expect: [{ pattern: "Cohere API Key", check: "medium", location: "inline-script" }],
    mustNotFire: ["Together AI Key"],
    knownGap:
      "with two brand keywords in one window the first CONTEXT pattern (Cohere, 40 alnum) claims a prefix of a longer Together key",
  })),
  probe("keyed-value-dropped-as-camelcase", (r) => ({
    html: inline(`window.__CFG__={cohereKey:"ab${runOf(r, "CDEFGHJKLMNPQRSTUVWXYZ", 1)}${runOf(r, ALNUM, 37)}"};`),
    expect: [],
    knownGap:
      "a keyed value opening lowercase-then-uppercase (`abK…`, ~30% of random alnum keys) is dropped by looksLikeCodeIdentifier's camelCase test",
  })),
  probe("keyed-value-dropped-as-snake-case", (r) => ({
    html: inline(`window.__CFG__={cloudflareToken:"${runOf(r, DIGIT, 1)}${runOf(r, LOWER + DIGIT, 20)}_${runOf(r, LOWER + DIGIT, 18)}"};`),
    expect: [],
    knownGap:
      "Cloudflare/Auth0/Contentful tokens with an `_` and a lowercase letter are dropped as snake_case identifiers; real Cloudflare tokens carry `_` and `-`",
  })),
  probe("keyed-value-dropped-by-verb-prefix", (r) => ({
    html: inline(`window.__CFG__={mistralKey:"on${runOf(r, DIGIT, 30)}"};`),
    expect: [],
    knownGap:
      "a keyed value starting with `on`/`is`/`get`/… is dropped by looksLikeCodeIdentifier's verb-prefix test regardless of what follows",
  })),
  probe("digitalocean-spaces-eats-new-relic", (r) => ({
    html: inline(`window.__NR__={licenseKey:"${runOf(r, "ABCEFGHJKLMNPQRSTUVWXYZ0123456789", 20)}DO${runOf(r, "ABCEFGHJKLMNPQRSTUVWXYZ0123456789", 18)}${["NR", "AL"].join("")}"};`),
    // DigitalOcean Spaces `DO[A-Z0-9]{20,}` runs before New Relic and claims
    // the tail; New Relic's full match then overlaps and is dropped.
    expect: [{ pattern: "DigitalOcean Spaces Key", check: "medium", location: "inline-script" }],
    mustNotFire: ["New Relic License Key"],
    knownGap:
      "DigitalOcean Spaces `DO[A-Z0-9]{20,}` runs before New Relic and claims the tail of any NRAL key containing `DO`, downgrading high to medium",
  })),
  probe("fp-filter-is-a-substring-test", (r) => ({
    // A GitHub token whose random body happens to contain `xxx`. The filter
    // list is applied as substring tests over the whole value, so this real
    // shaped high-confidence token is dropped outright.
    html: inline(`window.__T__={${["gh", "p_"].join("")}:"${["gh", "p_"].join("")}${runOf(r, ALNUM, 14)}Xxx${runOf(r, ALNUM, 19)}"};`),
    expect: [],
    knownGap:
      "FALSE_POSITIVE_PATTERNS are unanchored substring tests (`xxx`, `fake`, `sample`, `dummy`, `a{16}`…): a random key containing one anywhere is dropped, prefix and all",
  })),
  probe("supabase-service-role-jwt-is-called-public", (r) => ({
    html: inline(`const supabase=createClient("https://${runOf(r, LOWER, 20)}.supabase.co",${JSON.stringify(supabaseJwt(r, "service_role"))});`),
    // The anon and service-role keys are both HS256 JWTs from the same
    // issuer; only the `role` claim differs, and the pattern never reads it.
    expect: [{ pattern: "Supabase Anon Key", check: "public", location: "inline-script" }],
    knownGap:
      "a Supabase service_role JWT (full database access) is reported as the public-by-design anon key; the `role` claim is never decoded",
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
        content: `${"var q0=function(a,b){return a+b};".repeat(160_000)}var t={${["gh", "p_"].join("")}:"${["gh", "p_"].join("")}${runOf(r, ALNUM, 36)}"};`,
      },
    ],
    expect: [{ pattern: "GitHub Personal Access Token", check: "high", location: "external-script" }],
    knownGap: "no size cap: a 5 MB external script is scanned in full (this pins the cost, not a wrong result)",
  })),
  probe("same-value-in-three-locations-reports-once", (r) => {
    const v = ["gh", "p_"].join("") + runOf(r, ALNUM, 36);
    return {
      html: `<!DOCTYPE html><html><head><title>x</title><meta name="gh-token" content="${v}"></head><body><script>window.__T__="${v}";</script><script src="/app.js"></script></body></html>`,
      scripts: [{ url: "https://app.acme.test/app.js", content: `var token="${v}";` }],
      secret: v,
      expect: [{ pattern: "GitHub Personal Access Token", check: "high", location: "external-script" }],
    };
  }),
];

export const CASES: Case[] = [...POSITIVES, ...NEGATIVES, ...PROBES];

export function caseById(id: string): Case {
  const found = CASES.find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

// Re-exported for the bench, which builds its filler with the same RNG.
export { mixedRun, runOf, seededRng };
