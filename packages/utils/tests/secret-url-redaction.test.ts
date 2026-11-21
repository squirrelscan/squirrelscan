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
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXZhbHVl";
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
  ])(
    "%s with a token-shaped value is redacted in an off-site URL too",
    (param, value) => {
      const url = `https://partner.example.org/p?${param}=${value}&page=2`;
      expect(redact(url)).toBe(
        `https://partner.example.org/p?${param}=REDACTED&page=2`
      );
    }
  );

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
    expect(redact(url)).toBe(
      `https://partner.example.org/p?${param}=REDACTED&page=2`
    );
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
          `https://example.com/p?${param}=${value}&page=2`
        );
      }
    }
    // The pre-existing content names are untouched.
    expect(redact("https://example.com/token?token=USDC")).toBe(
      "https://example.com/token?token=USDC"
    );
    // `__token__` does not reach plain `token`, `_token` or `token_`.
    for (const param of ["token", "_token", "token_"]) {
      expect(redact(`https://example.com/p?${param}=home`)).toBe(
        `https://example.com/p?${param}=home`
      );
    }
  });
});

// #3433: the path-token and name forms left after #3339, each with the secret
// it must catch and a page of the same shape it must keep (#2063).
const UUID_V = "3f2a9c1b-8e7d-4a5f-9e3d-3f2a9c1b8e7d";
const DJANGO_TOKEN = "c4r1ze-8f0e3b2a1c9d7e6f5a4b";
const ALLAUTH_KEY = "MQ:1tVxyz:K3fAbCdEfGhIjKlMnOpQrStUvWx";
const SHORT_TOKEN = "aB3dE5fG7hJ9kL1m";

describe("path-token forms left after #3339 (#3433)", () => {
  test.each([
    // Django's reset view: the token is two segments after the word.
    [`/reset/MQ/${DJANGO_TOKEN}/`, "/reset/MQ/REDACTED/"],
    [
      `/password/reset/confirm/Mg/${DJANGO_TOKEN}/`,
      "/password/reset/confirm/Mg/REDACTED/",
    ],
    // django-allauth's signed confirmation key, and its older hex key.
    [
      `/accounts/confirm-email/${ALLAUTH_KEY}/`,
      "/accounts/confirm-email/REDACTED/",
    ],
    [
      `/accounts/confirm-email/${HEX}${HEX}/`,
      "/accounts/confirm-email/REDACTED/",
    ],
    // Hash routes.
    [`/#/reset/${HEX}`, "/#/reset/REDACTED"],
    [`/app#!/reset/${B64}`, "/app#!/reset/REDACTED"],
    // Encoded `next`, once and twice, relative and absolute, and a nested hash route.
    [`/login?next=%2Freset%2F${HEX}`, "/login?next=%2Freset%2FREDACTED"],
    [
      `/login?next=%252Freset%252F${HEX}%253Fa%253D1`,
      "/login?next=%252Freset%252FREDACTED%253Fa%253D1",
    ],
    [
      `/login?next=https%3A%2F%2Fexample.com%2Fapp%23%2Freset%2F${HEX}`,
      "/login?next=https%3A%2F%2Fexample.com%2Fapp%23%2Freset%2FREDACTED",
    ],
    // Plural Rails resources.
    [`/account_activations/${HEX}/edit`, "/account_activations/REDACTED/edit"],
    [`/email_verifications/${HEX}`, "/email_verifications/REDACTED"],
    [`/invitations/${UUID_V}`, "/invitations/REDACTED"],
    [`/invites/${ALNUM}`, "/invites/REDACTED"],
    [`/confirmations/${HEX}`, "/confirmations/REDACTED"],
    // Split credential words, and a word between the word and its token.
    [`/sign-in/${HEX}`, "/sign-in/REDACTED"],
    [`/users/sign_in/${B64}`, "/users/sign_in/REDACTED"],
    [`/log-in/${HEX}`, "/log-in/REDACTED"],
    [`/invite/accept/${UUID_V}`, "/invite/accept/REDACTED"],
    [`/confirm/email/${HEX}`, "/confirm/email/REDACTED"],
    [`/verify/email/${HEX}`, "/verify/email/REDACTED"],
    [`/activate/account/${HEX}`, "/activate/account/REDACTED"],
    // A token before a markdown link's `)` or a file extension.
    [
      `[reset](https://example.com/reset/${HEX})`,
      "[reset](https://example.com/reset/REDACTED)",
    ],
    [`/reset/${HEX}.html`, "/reset/REDACTED.html"],
  ])("%s is redacted", (path, redacted) => {
    const url = path.startsWith("/") ? `https://example.com${path}` : path;
    const want = redacted.startsWith("/")
      ? `https://example.com${redacted}`
      : redacted;
    expect(redact(url)).toBe(want);
    // Idempotent.
    expect(redact(want)).toBe(want);
  });

  test.each([
    "/reset/MQ/set-password/",
    "/reset/done/",
    `/reset/MQ/${HEX}-notes/`,
    "/accounts/confirm-email/",
    "/accounts/confirm-email/sent/",
    "/#/reset/how-to-reset-your-router",
    `/#/products/${HEX}`,
    "/login?next=%2Freset%2Fhow-to-reset-your-router",
    `/login?next=%2Fproducts%2F${HEX}`,
    "/invitations/team-offsite-2026",
    "/confirmations/42",
    `/verifications/${UUID_V}`,
    `/sessions/${UUID_V}`,
    "/sign-in/help",
    `/blog/sign-in-with-apple/${HEX}`,
    "/invite/accept/terms",
    `/products/email/${HEX}`,
    `/account/email/${HEX}`,
    "/reset/how-to.html",
    "/reset/12345678901234567890.html",
    "[docs](https://example.com/reset/router-guide)",
  ])("%s is kept", (path) => {
    const url = `https://example.com${path}`;
    expect(redact(url)).toBe(url);
  });

  test("off-site hash routes and encoded paths are kept, as with no site", () => {
    const empty = new Set<string>();
    for (const url of [
      `https://partner.example.org/#/reset/${HEX}`,
      `https://partner.example.org/login?next=%2Freset%2F${HEX}`,
      `https://partner.example.org/go?next=https%3A%2F%2Fpartner.example.org%2Freset%2F${HEX}`,
    ]) {
      expect(redact(url)).toBe(url);
      expect(redactSecretText(url, empty)).toBe(url);
    }
    // Nested in the site's own URL, an off-site path is the site's to redact.
    expect(
      redact(
        `https://example.com/go?next=https%3A%2F%2Fpartner.example.org%2Freset%2F${HEX}`
      )
    ).toBe(
      "https://example.com/go?next=https%3A%2F%2Fpartner.example.org%2Freset%2FREDACTED"
    );
  });

  test("a segment of many `)` after a context word stays linear (CodeQL js/polynomial-redos)", () => {
    const parens = ")".repeat(50_000);
    const start = performance.now();
    expect(redact(`https://example.com/reset/${parens}x`)).toBe(
      `https://example.com/reset/${parens}x`
    );
    expect(redact(`https://example.com/reset/${HEX}${parens}`)).toBe(
      `https://example.com/reset/REDACTED${parens}`
    );
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  test("`&#38;` and `;` separate parameters in the site's own URLs", () => {
    expect(redact(`https://example.com/p?a=1&#38;token=${HEX}`)).toBe(
      "https://example.com/p?a=1&#38;token=REDACTED"
    );
    expect(redact(`https://example.com/p?a=1;sid=${ALNUM};b=2`)).toBe(
      "https://example.com/p?a=1;sid=REDACTED;b=2"
    );
    expect(redact("https://example.com/p?a=1&#38;token=USDC;sid=42")).toBe(
      "https://example.com/p?a=1&#38;token=USDC;sid=42"
    );
  });
});

describe("short values and name forms left after #3339 (#3433)", () => {
  test.each([
    [`${name("activate", "token")}=abc`, `${name("activate", "token")}=***`],
    [`${name("sso", "token")}=x9z`, `${name("sso", "token")}=***`],
    [`${name("otp", "code")}=123456`, `${name("otp", "code")}=******`],
    [
      `${name("verification", "code")}=AB12CD`,
      `${name("verification", "code")}=******`,
    ],
    [`${name("activation", "key")}=k3y`, `${name("activation", "key")}=***`],
    [`${name("reset", "key")}=${HEX}`, `${name("reset", "key")}=REDACTED`],
    [`${name("user", "sid")}=${HEX}`, `${name("user", "sid")}=REDACTED`],
    [`sid={${UUID_V}}`, "sid=REDACTED"],
    [`sid=%7B${UUID_V}%7D`, "sid=REDACTED"],
    [`${name("reset", "token")}[0]=abc`, `${name("reset", "token")}[0]=***`],
    [`${name("app", "key")}=base64:${B64}=`, `${name("app", "key")}=REDACTED`],
    [`token=${SHORT_TOKEN}`, "token=REDACTED"],
    [`auth=Q7wE2rT9yU4iO1pA`, "auth=REDACTED"],
  ])("%s is redacted", (param, redacted) => {
    expect(redact(`https://example.com/p?${param}&page=2`)).toBe(
      `https://example.com/p?${redacted}&page=2`
    );
  });

  test.each([
    "/auth/callback",
    "/auth/google/callback",
    "/api/auth/callback/github",
    "/oauth2callback",
    "/login/oauth2/code/google",
  ])("the OAuth code on %s is redacted whatever its shape", (path) => {
    expect(redact(`https://example.com${path}?code=4%2F0Ab&state=x`)).toBe(
      `https://example.com${path}?code=*******&state=x`
    );
    expect(redact(`https://example.com${path}?state=x&code=${HEX}`)).toBe(
      `https://example.com${path}?state=x&code=REDACTED`
    );
    // Nested in the site's `next`, encoded.
    expect(
      redact(
        `https://example.com/login?next=${encodeURIComponent(`${path}?code=${HEX}`)}`
      )
    ).toBe(
      `https://example.com/login?next=${encodeURIComponent(path)}%3Fcode%3DREDACTED`
    );
  });

  test.each([
    `/p?${name("promo", "code")}=SUMMER20`,
    `/p?${name("sort", "key")}=price`,
    "/p?code=SUMMER20",
    "/checkout?code=SUMMER20",
    "/blog/callback-hell?code=abc",
    "/callback?page=2",
    "/auth/callback?next=/blog?code=SUMMER20",
    `/p?${name("user", "sid")}=42`,
    `/p?session={${UUID_V}}`,
    "/p?items[0]=shoes",
    `/p?${name("app", "key")}=base64:home`,
    "/p?session=KeynoteDay1Track2",
    "/p?token=USDCethPool2026xyz",
    "/p?ref=ABCDEFGH12345678",
    // Lowercase and digits only, 16 to 19: the known limit (a slug's shape).
    "/p?sid=a1b2c3d4e5f6g7h8",
  ])("%s is kept", (path) => {
    const url = `https://example.com${path}`;
    expect(redact(url)).toBe(url);
  });

  test("an off-site callback keeps its code, as with no site (the link checker keys on it)", () => {
    const url = "https://partner.example.org/auth/callback?code=abc123";
    expect(redact(url)).toBe(url);
    expect(redactSecretText(url, new Set())).toBe(url);
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
const SEGMENTS = [
  "",
  "a",
  "blog",
  "2024",
  "how-to-fix-404-errors",
  "p",
  "shop",
  "docs",
  "v2",
  // (#3433) Context words beside pages: what follows them here is never a token.
  "sign-in",
  "invitations",
  "confirm-email",
  "accept",
  "email",
  "reset",
];
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
  // (#3433) Near misses of the forms that issue added.
  "promo_code=SUMMER20",
  "code=SUMMER20",
  "sort_key=price",
  "user_sid=42",
  "items[0]=shoes",
  "app_key=base64:home",
  "session=KeynoteDay1Track2",
  "token=USDCethPool2026xyz",
  // A conference session's GUID: a different value from the planted `sid` one.
  "session={0b7e4c2a-1d3f-4e5a-8b6c-7d8e9f0a1b2c}",
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
  ["app_key", `base64:${B64}=`],
  ["token", SHORT_TOKEN],
];
/** Per-visitor secrets: redacted in the site's own URLs only. */
const SESSION_SECRETS: Array<[string, string]> = [
  ["PHPSESSID", ALNUM],
  ["reset_token", HEX],
  ["jsessionid", HEX.toUpperCase()],
  ["sid", ALNUM],
  ["otp_code", "918273"],
  ["activation_key", "k3yQ"],
  ["sso_token", "x9zW"],
  ["user_sid", HEX],
  ["sid", `{${UUID_V}}`],
  ["reset_token[0]", "q7Zx9"],
];
/**
 * (#3433) Path tokens after a context, per-visitor like session values: the
 * path, and the secret in it. `#` starts a hash route (appended as a fragment).
 */
const PATH_SECRETS: Array<[string, string]> = [
  [`reset/MQ/${DJANGO_TOKEN}/`, DJANGO_TOKEN],
  [`accounts/confirm-email/${ALLAUTH_KEY}/`, ALLAUTH_KEY],
  [`account_activations/${HEX}/edit`, HEX],
  [`email_verifications/${B64}`, B64],
  [`invitations/${UUID_V}`, UUID_V],
  [`sign-in/${ALNUM}`, ALNUM],
  [`users/sign_in/${HEX}`, HEX],
  [`invite/accept/${UUID_V}`, UUID_V],
  [`verify/email/${HEX}`, HEX],
  [`activate/account/${B64}`, B64],
  [`reset/${HEX}.html`, HEX],
  [`#/reset/${HEX}`, HEX],
  [`#!/confirm/${B64}`, B64],
];
/** An OAuth callback path, whose `code` is per-visitor whatever its shape. */
const CALLBACK_PATHS = [
  "auth/callback",
  "auth/google/callback",
  "api/auth/callback/github",
];

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

interface Sample {
  url: string;
  secrets: string[];
  kind: "credential" | "session" | "path" | "none";
  /** The planted URL is the site's own, or travels in a site URL's query. */
  siteOwned: boolean;
  /** An absolute URL on another host, not nested in the site's. */
  offSite: boolean;
}

/** One random absolute URL, with `kind` secrets planted in its query (or none). */
function sample(rand: () => number): Sample {
  const offSite = rand() < 0.5;
  const host = pick(rand, offSite ? HOSTS.off : HOSTS.site);
  let path = Array.from({ length: Math.floor(rand() * 3) }, () =>
    pick(rand, SEGMENTS)
  )
    .filter(Boolean)
    .join("/");
  const params: string[] = [];
  for (let i = Math.floor(rand() * 3); i > 0; i--)
    params.push(pick(rand, BENIGN));
  const secrets: string[] = [];
  const planted = rand();
  let kind: Sample["kind"] = "none";
  if (planted < 0.45) {
    const [n, v] = pick(rand, CREDENTIAL_SECRETS);
    params.splice(Math.floor(rand() * (params.length + 1)), 0, `${n}=${v}`);
    secrets.push(v);
    kind = "credential";
  } else if (planted < 0.62) {
    const [n, v] = pick(rand, SESSION_SECRETS);
    params.splice(Math.floor(rand() * (params.length + 1)), 0, `${n}=${v}`);
    secrets.push(v);
    kind = "session";
  } else if (planted < 0.67) {
    // An OAuth code, short or long, on a callback path.
    path = pick(rand, CALLBACK_PATHS);
    const v = pick(rand, ["4/0AbCd", "918273", HEX]);
    params.splice(Math.floor(rand() * (params.length + 1)), 0, `code=${v}`);
    secrets.push(v);
    kind = "session";
  }
  let fragment = "";
  if (planted >= 0.67 && planted < 0.8) {
    const [p, v] = pick(rand, PATH_SECRETS);
    if (p.startsWith("#")) fragment = p;
    else path = path === "" ? p : `${path}/${p}`;
    secrets.push(v);
    kind = "path";
  }
  let url = `https://${host}/${path}${params.length > 0 ? `?${params.join("&")}` : ""}${fragment}`;
  // Sometimes the whole URL travels inside another one's query, encoded once.
  const nested = rand() < 0.2;
  if (nested) {
    const outer = pick(rand, HOSTS.site);
    url = `https://${outer}/go?next=${encodeURIComponent(url)}`;
  }
  return {
    url,
    secrets,
    kind,
    siteOwned: !offSite || nested,
    offSite: offSite && !nested,
  };
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
      if (s.kind === "credential" || (s.kind !== "none" && s.siteOwned)) {
        for (const secret of s.secrets)
          expect(once, where).not.toContain(secret);
      }
      // An off-site URL reads the same with the report's hosts as with none, and
      // keeps its per-visitor parameters (the link checker keys on them, #3339).
      if (s.offSite) expect(redactSecretText(s.url, empty), where).toBe(once);
      if (s.offSite && (s.kind === "session" || s.kind === "path"))
        expect(once, where).toBe(s.url);
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
    // (#3433)
    "%2Freset%2F",
    "%23%2F",
    "#/reset/",
    "#!/",
    "callback",
    "code=",
    "sign-in",
    "{",
    "}",
    "[0]",
    ")",
    ".html",
    "&#38;",
    "base64:",
    DJANGO_TOKEN,
    ALLAUTH_KEY,
  ];

  test.each([3, 99, 4096])(
    "seed %i: never throws, idempotent, never longer",
    (seed) => {
      const rand = prng(seed);
      for (let i = 0; i < 400; i++) {
        const text = Array.from({ length: 1 + Math.floor(rand() * 40) }, () =>
          pick(rand, ATOMS)
        ).join("");
        const once = redact(text);
        expect(
          redact(once),
          `seed ${seed} #${i}: ${JSON.stringify(text)}`
        ).toBe(once);
        expect(once.length, `seed ${seed} #${i}`).toBeLessThanOrEqual(
          text.length
        );
      }
    }
  );

  test("a long run of one atom stays linear", () => {
    for (const atom of [
      "?a=",
      "%25",
      "[]",
      "@",
      "eyJ.",
      "/reset/",
      "&token=",
      // (#3433)
      "%2Freset%2F",
      "%23%2F",
      "%2523%252F",
      "%23%21%2F",
      "#/reset/",
      "/auth/callback?code=",
      "&code=",
      "[0]",
      "/MQ/",
    ]) {
      const text = `https://example.com/p${atom.repeat(40_000)}`;
      const start = performance.now();
      redact(text);
      expect(performance.now() - start, atom).toBeLessThan(5_000);
    }
  });
});
