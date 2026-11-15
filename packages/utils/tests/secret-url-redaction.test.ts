// #3347: the redactor's name lists, and a seeded fuzz over its contract: the
// rewrite is deterministic, idempotent and never longer; a planted secret does
// not survive where the redactor owns it; a URL with nothing to redact comes
// back as the same string; and an off-site URL reads the same with the report's
// site set as with none (the property the link keys join on, #3384).
import { describe, expect, test } from "bun:test";

import { redactSecretText } from "../src/secret-url-redaction";

const HEX = "3f2a9c1b8e7d6a5f4e3d";
const B64 = "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg";
const ALNUM = "lit3py55t21z5v55vlm25s55";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVl";
const SITE = new Set(["example.com", "shop.example.com"]);
const redact = (text: string) => redactSecretText(text, SITE);

// Names built from parts, as the other redaction fixtures do.
const name = (...parts: string[]) => parts.join("_");

describe("key and token names the lists missed (#3347)", () => {
  test.each([
    [name("access", "key"), HEX],
    [name("app", "key"), B64],
    [name("subscription", "key"), HEX],
    ["Ocp-Apim-Subscription-Key", HEX],
    ["csrfmiddlewaretoken", B64],
  ])("%s with a token-shaped value is redacted in an off-site URL too", (param, value) => {
    const url = `https://partner.example.org/p?${param}=${value}&page=2`;
    expect(redact(url)).toBe(`https://partner.example.org/p?${param}=REDACTED&page=2`);
  });

  // Names that only ever carry a secret: redacted whatever the value looks like.
  test.each([
    [name("secret", "key"), "k9s3cr3tvalue"],
    [name("private", "token"), "glpat-abc"],
    // Rails signed global ids are `base64--hex`, not one token-shaped run.
    ["sgid", `BAh7CEkiCGdpZAY6BkVUSSIfZ2lk--${HEX}${HEX}`],
    ["oobCode", "123456789012"],
    ["__token__", `exp=1700000000~acl=/*~hmac=${HEX}`],
  ])("%s is redacted whatever its value", (param, value) => {
    const url = `https://partner.example.org/p?${param}=${value}&page=2`;
    expect(redact(url)).toBe(`https://partner.example.org/p?${param}=REDACTED&page=2`);
  });

  test("names that can mean content keep a short, ordinary value", () => {
    for (const param of [
      name("access", "key"),
      name("app", "key"),
      name("subscription", "key"),
      "csrfmiddlewaretoken",
    ]) {
      for (const value of ["home", "premium-plan-annual-2026", "42"]) {
        expect(redact(`https://example.com/p?${param}=${value}&page=2`)).toBe(
          `https://example.com/p?${param}=${value}&page=2`,
        );
      }
    }
    // The pre-existing content names are untouched.
    expect(redact("https://example.com/token?token=USDC")).toBe(
      "https://example.com/token?token=USDC",
    );
    // `__token__` does not reach plain `token`, `_token` or `token_`.
    for (const param of ["token", "_token", "token_"]) {
      expect(redact(`https://example.com/p?${param}=home`)).toBe(
        `https://example.com/p?${param}=home`,
      );
    }
  });
});

// ── Fuzz ─────────────────────────────────────────────────────────────────────

/** A small seeded LCG, so a failure names its seed and replays (the high bits are the random ones). */
function prng(seed: number): () => number {
  let state = seed % 4294967296;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const HOSTS = {
  site: ["example.com", "shop.example.com", "www.example.com"],
  off: ["partner.example.org", "cdn.other.net", "docs.third.io"],
};
const SEGMENTS = ["", "a", "blog", "2024", "how-to-fix-404-errors", "p", "shop", "docs", "v2"];
const BENIGN: string[] = [
  "page=2",
  "q=running+shoes",
  "id=42",
  "sort=asc",
  "lang=en",
  "utm_source=newsletter",
  "token=USDC",
  "auth=tolkien",
  "sid=42",
  "session=2026",
  "tab=reviews",
  "ref=home",
  // Near misses of the names above: ordinary values under them are content.
  "access_key=home",
  "subscription_key=basic",
  "app_key=premium-plan",
];
/** Secrets a credential name carries: redacted in every URL. */
const CREDENTIAL_SECRETS: Array<[string, string]> = [
  ["access_token", B64],
  ["api_key", ALNUM],
  ["token", HEX],
  ["X-Amz-Signature", HEX + HEX],
  ["password", "hunter2horse"],
  ["jwt", JWT],
  ["secret_key", "k9s3cr3tvalue"],
  ["sgid", B64],
  ["access_key", HEX],
  ["app_key", B64],
  ["private_token", "glpat-abc"],
  ["oobCode", "123456789012"],
  ["__token__", `exp=1700000000~hmac=${HEX}`],
];
/** Per-visitor secrets: redacted in the site's own URLs only. */
const SESSION_SECRETS: Array<[string, string]> = [
  ["PHPSESSID", ALNUM],
  ["reset_token", HEX],
  ["jsessionid", HEX.toUpperCase()],
  ["sid", ALNUM],
];

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

interface Sample {
  url: string;
  secrets: string[];
  kind: "credential" | "session" | "none";
  /** The planted URL is the site's own, or travels in a site URL's query. */
  siteOwned: boolean;
  /** An absolute URL on another host, not nested in the site's. */
  offSite: boolean;
}

/** One random absolute URL, with `kind` secrets planted in its query (or none). */
function sample(rand: () => number): Sample {
  const offSite = rand() < 0.5;
  const host = pick(rand, offSite ? HOSTS.off : HOSTS.site);
  const path = Array.from({ length: Math.floor(rand() * 3) }, () => pick(rand, SEGMENTS))
    .filter(Boolean)
    .join("/");
  const params: string[] = [];
  for (let i = Math.floor(rand() * 3); i > 0; i--) params.push(pick(rand, BENIGN));
  const secrets: string[] = [];
  const planted = rand();
  let kind: Sample["kind"] = "none";
  if (planted < 0.45) {
    const [n, v] = pick(rand, CREDENTIAL_SECRETS);
    params.splice(Math.floor(rand() * (params.length + 1)), 0, `${n}=${v}`);
    secrets.push(v);
    kind = "credential";
  } else if (planted < 0.7) {
    const [n, v] = pick(rand, SESSION_SECRETS);
    params.splice(Math.floor(rand() * (params.length + 1)), 0, `${n}=${v}`);
    secrets.push(v);
    kind = "session";
  }
  let url = `https://${host}/${path}${params.length > 0 ? `?${params.join("&")}` : ""}`;
  // Sometimes the whole URL travels inside another one's query, encoded once.
  const nested = rand() < 0.2;
  if (nested) {
    const outer = pick(rand, HOSTS.site);
    url = `https://${outer}/go?next=${encodeURIComponent(url)}`;
  }
  return { url, secrets, kind, siteOwned: !offSite || nested, offSite: offSite && !nested };
}

const SEEDS = [1, 7, 42, 2026, 31337];
const PER_SEED = 600;

describe("redaction contract, seeded fuzz (#3347)", () => {
  test.each(SEEDS)("seed %i", (seed) => {
    const rand = prng(seed);
    // An EMPTY set: no host is the site's own (`null` would make every URL its own).
    const empty = new Set<string>();
    for (let i = 0; i < PER_SEED; i++) {
      const s = sample(rand);
      const where = `seed ${seed} #${i}: ${s.url}`;
      const once = redact(s.url);
      // Deterministic, idempotent, never longer.
      expect(redact(s.url), where).toBe(once);
      expect(redact(once), where).toBe(once);
      expect(once.length, where).toBeLessThanOrEqual(s.url.length);
      // A URL with nothing to redact is the same string.
      if (s.kind === "none") expect(once, where).toBe(s.url);
      // Credentials go everywhere; per-visitor values where the site owns them.
      if (s.kind === "credential" || (s.kind === "session" && s.siteOwned)) {
        for (const secret of s.secrets) expect(once, where).not.toContain(secret);
      }
      // An off-site URL reads the same with the report's hosts as with none, and
      // keeps its per-visitor parameters (the link checker keys on them, #3339).
      if (s.offSite) expect(redactSecretText(s.url, empty), where).toBe(once);
      if (s.offSite && s.kind === "session") expect(once, where).toBe(s.url);
    }
  });
});

describe("redaction on hostile text, seeded (#3347)", () => {
  const ATOMS = [
    "https://",
    "http://",
    "//",
    "user:pw@",
    "@",
    "example.com",
    "partner.example.org",
    "/",
    "?",
    "&",
    "&amp;",
    "#",
    ";",
    "=",
    "%",
    "%25",
    "%3F",
    "%26",
    "%3D",
    "%2F",
    "token",
    "access_token",
    "sid",
    "reset",
    "eyJ",
    ".",
    "-",
    "_",
    "[]",
    "(S(",
    "))",
    HEX,
    B64,
    JWT,
    "é",
    "\\",
    "'",
    '"',
    " ",
    "\n",
  ];

  test.each([3, 99, 4096])("seed %i: never throws, idempotent, never longer", (seed) => {
    const rand = prng(seed);
    for (let i = 0; i < 400; i++) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 40) }, () =>
        pick(rand, ATOMS),
      ).join("");
      const once = redact(text);
      expect(redact(once), `seed ${seed} #${i}: ${JSON.stringify(text)}`).toBe(once);
      expect(once.length, `seed ${seed} #${i}`).toBeLessThanOrEqual(text.length);
    }
  });

  test("a long run of one atom stays linear", () => {
    for (const atom of ["?a=", "%25", "[]", "@", "eyJ.", "/reset/", "&token="]) {
      const text = `https://example.com/p${atom.repeat(40_000)}`;
      const start = performance.now();
      redact(text);
      expect(performance.now() - start, atom).toBeLessThan(5_000);
    }
  });
});
