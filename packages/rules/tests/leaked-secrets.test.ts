// security/leaked-secrets — a bare hex run is a SHA-256 digest far more often
// than it is a credential.
//
// The context-pattern tier ("Together AI Key" = /[a-f0-9]{64}/ near the word
// "together", "Datadog API Key" = /[a-f0-9]{32}/ near "datadog", …) matches on
// shape alone. That shape is also a release checksum, an SRI hash, a git object
// id and an ETag, and the brand keyword that is supposed to make the pattern
// specific shows up in ordinary prose ("we ship the crawler and the renderer
// together"). Auditing squirrelscan.com's own release pages produced 19
// findings, every one of them a published download checksum.
//
// So these fixtures defend the silence: a bare-shape match reports only under a
// key that says the value is a credential, and never under sha256 / integrity /
// checksum / commit. The prefixed patterns (sk-, ghp_, AKIA, pk_live_…) carry
// their own marker and are untouched — the last block pins that.

import { parsePage } from "@squirrelscan/parser";
import {
  SECRET_CONTEXT_WINDOW_SIZE,
  SECRET_KEY_LOOKBEHIND_SIZE,
} from "@squirrelscan/utils/constants";
import { describe, expect, test } from "bun:test";

import type { LeakedSecret } from "../src/security/leaked-secrets";
import type { RuleContext } from "../src/types";

import {
  CONTEXT_KEYWORD_GAP,
  classifyKeyContext,
  createSeenValues,
  leakedSecretsRule,
  lookBehind,
  PUBLIC_URL_IDENTIFIERS,
  readKeyLookBack,
  scanContent,
} from "../src/security/leaked-secrets";
import { githubChecksum } from "../src/security/secrets/confidence";

// A GitHub token body (30 characters); the checksum it needs (#361) is
// appended at runtime, so no line here is a whole token.
const GH_BODY = "016b3f2c9d4e7a815c0b2d6f39ea47"; // pragma: allowlist secret
// A PEM header counts only with key material after it (#1227): one 68-character body line.
const PEM_RSA = [
  "-----BEGIN RSA PRIVATE KEY-----", // pragma: allowlist secret
  "MIIEowIBAAKCAQEA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A", // pragma: allowlist secret
  "-----END RSA PRIVATE KEY-----",
].join("\n");

// A real SHA-256 of a release artifact: 64 hex characters, which is also the
// exact shape of a Together AI key.
const DIGEST =
  "01e4fbb0227e0f575e245eb0d8a4fc9b1d3a7e6c2f80b41d95ea7cd3f0b62a18"; // pragma: allowlist secret
const DIGEST_2 =
  "7b2c40e91af38d605c7e1b94a2f6d083e5c19b7a4d0f38e6215ca9b70d4f8e32"; // pragma: allowlist secret
// A second 64-hex value, this one actually assigned to an api_key.
const TOGETHER_KEY =
  "9f3c1d7ba24e08f65c1b93d0e47af215c806b3e9d24f71a5c0938e6b1df42a70"; // pragma: allowlist secret
const COMMIT = "3f9a1c5d7e2b48061a9c3d5f7e8b2a4c6d0e1f93"; // pragma: allowlist secret

// #150 fixtures. Real standard base64 — 47 bytes each, so 64 characters and
// one `=` of padding, and both carry a `+` and a `/` inside their first 20
// characters, which is where the base64url class used to give up.
const B64_TOKEN =
  "2MBqfKhL/eXCwg0Zt+RZ2klzNCF0inWnUM3Jb0UiyC1WDP53Cxm5f6UUyrjnQH8="; // pragma: allowlist secret
const B64_TOKEN_2 =
  "yS9+/xwatK/BZkejOF5vKuKCuzfMdMV55oZv26BLG8DoO6+VamfQB1mP0TbXYOc="; // pragma: allowlist secret
// A real sha384 SRI hash is standard base64 too, `+` and `/` and all.
const SRI_B64 =
  "oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"; // pragma: allowlist secret
const OAUTH_TOKEN = "Zk8pR3vN6mQ1tX4wL7cH2sB5dF9gJ0aY"; // pragma: allowlist secret

function html(body: string): string {
  return `<!DOCTYPE html><html><head><title>Releases</title></head><body>${body}</body></html>`;
}

function ctx(
  pageHtml: string,
  url = "https://squirrelscan.com/releases"
): RuleContext {
  return {
    site: {
      baseUrl: "https://squirrelscan.com",
      pages: [{ url, statusCode: 200, parsed: parsePage(pageHtml, url) }],
      robotsTxt: null,
      sitemaps: null,
    },
    options: {},
  } as unknown as RuleContext;
}

function findings(
  checks: Awaited<ReturnType<typeof leakedSecretsRule.run>>["checks"]
) {
  return checks
    .filter(
      (c) =>
        c.name === "leaked-secrets-critical" ||
        c.name === "leaked-secrets-high" ||
        c.name === "leaked-secrets-medium"
    )
    .flatMap((c) => c.items ?? []);
}

// The shape squirrelscan.com/releases embeds in its SSR payload, verbatim: an
// asset list where every entry carries the artifact's published checksum. The
// release notes mention shipping things "together", which is all the Together AI
// pattern ever needed to fire.
const RELEASE_PAYLOAD = `<script>window.__RELEASES__={"version":"0.0.86","notes":"The crawler and the renderer now ship together.","assets":[{filename:"squirrel-0.0.86-darwin-x64",sha256:"${DIGEST}"},{filename:"squirrel-0.0.86-linux-x64",sha256:"${DIGEST_2}"}]}</script>`;

const CHECKSUM_TABLE = `
  <h2>Checksums</h2>
  <table>
    <tr><td>squirrel-0.0.86-darwin-x64</td><td><code>${DIGEST}</code></td></tr>
    <tr><td>squirrel-0.0.86-linux-x64</td><td><code>${DIGEST_2}</code></td></tr>
  </table>
  <pre><code>sha256: ${DIGEST}</code></pre>
`;

const SRI_TAG = `<script src="https://cdn.example.net/lib.js" integrity="sha256-${DIGEST}" crossorigin="anonymous"></script>`;

const COMMIT_ID = `<p>Built from commit <code data-commit="${COMMIT}">${COMMIT}</code> on Cloudflare.</p>`;

describe("security/leaked-secrets: hex digests are not secrets", () => {
  test("a release page of checksums, an SRI hash and a commit id reports nothing", async () => {
    const page = html(
      `${RELEASE_PAYLOAD}${CHECKSUM_TABLE}${SRI_TAG}${COMMIT_ID}`
    );
    const { checks } = await leakedSecretsRule.run(ctx(page));

    expect(findings(checks)).toEqual([]);
    expect(checks.find((c) => c.name === "leaked-secrets")?.status).toBe(
      "pass"
    );
  });

  test("the same page plus a real Together key reports exactly one finding", async () => {
    const leak = `<script>const api_key = "${TOGETHER_KEY}";</script>`; // pragma: allowlist secret
    const page = html(
      `${RELEASE_PAYLOAD}${CHECKSUM_TABLE}${SRI_TAG}${COMMIT_ID}${leak}`
    );
    const { checks } = await leakedSecretsRule.run(ctx(page));

    const items = findings(checks);
    expect(items).toHaveLength(1);
    // Reported values are masked, so match on the tail the mask keeps: the
    // finding is the api_key assignment, not one of the four digests.
    expect(items[0]?.id).toContain("API Key");
    expect(items[0]?.id).toContain(TOGETHER_KEY.slice(-3));
    for (const digest of [DIGEST, DIGEST_2, COMMIT]) {
      expect(items[0]?.id).not.toContain(digest.slice(-4));
    }
  });

  test("the exact squirrelscan.com/releases asset shape reports nothing", () => {
    expect(scanContent(RELEASE_PAYLOAD, "inline-script")).toEqual([]);
  });

  test("digest keys suppress a 64-hex value even with the brand keyword nearby", () => {
    for (const key of [
      "sha256",
      "SHA256",
      "sha384",
      "sha512",
      "hash",
      "digest",
      "checksum",
      "etag",
      "commit",
      "integrity",
    ]) {
      const content = `{together:true,${key}:"${DIGEST}"}`;
      expect(scanContent(content, "inline-script")).toEqual([]);
    }
  });

  test("a bare hex run with no key in front of it reports nothing", () => {
    // Prose + a checksum in a table cell: no assignment, no key, no finding.
    const content = `<p>Everything together.</p><td>${DIGEST}</td>`;
    expect(scanContent(content, "html")).toEqual([]);
  });

  test("an SRI integrity attribute reports nothing", () => {
    const content = `<p>bundled together</p>${SRI_TAG}`;
    expect(scanContent(content, "html")).toEqual([]);
  });

  test("a cache key built by hashing its inputs reports nothing", () => {
    for (const key of [
      "cacheKey",
      "cache_key",
      "cachekey",
      "cache",
      "eTag",
      "eTagKey",
    ]) {
      const content = `{together:true,${key}:"${DIGEST}"}`;
      expect(scanContent(content, "inline-script")).toEqual([]);
    }
  });

  test("a naming attribute after the value still suppresses a digest", () => {
    const content = `<p>together</p><meta content="${DIGEST}" name="release-sha256">`;
    expect(scanContent(content, "html")).toEqual([]);
  });

  test("a pretty-printed manifest keeps its digest a digest across the whitespace", () => {
    // #177: the key and the value are one assignment however far apart an
    // aligned manifest writes them. The look-back used to spend its budget on
    // the spaces and lose `sha256` entirely, reporting the checksum as a key.
    for (const gap of [
      1,
      SECRET_KEY_LOOKBEHIND_SIZE,
      SECRET_KEY_LOOKBEHIND_SIZE * 4,
    ]) {
      const content = `{"vendor":"together","sha256"${" ".repeat(gap)}:"${DIGEST}"}`;
      expect(scanContent(content, "inline-script")).toEqual([]);
    }
    // Under a credential key within the keyword gap it still reports. The
    // bounded look-behind (#357) counts raw characters from the brand word,
    // whitespace included, so the gap here is what a formatter leaves.
    const leak = `{"vendor":"together","token"${" ".repeat(20)}:"${TOGETHER_KEY}"}`;
    expect(scanContent(leak, "inline-script").map((f) => f.type)).toEqual([
      "Together AI Key",
    ]);

    // The invariant under all of it: the distance between a key and its value
    // is not evidence. A key that names something which is not a credential
    // reads the same at 20 spaces as it does at none — before this, the same
    // page said "checksum" up close and "unnamed assignment" further away.
    // (Past the keyword gap the silence is the gap's, not the key's, which
    // is why the widest gap here stays inside it; the look-back itself is
    // exercised at 200 spaces by the classifyKeyContext tests below.)
    for (const key of ["filename", "description", "sha256"]) {
      for (const gap of [0, 1, 20]) {
        const content = `{"vendor":"together","${key}"${" ".repeat(gap)}:"${DIGEST}"}`;
        expect(scanContent(content, "inline-script")).toEqual([]);
      }
    }
  });

  test("a short key that names something is not a minified member access", () => {
    // A cache-busting query param and a JSON id are short but they do name
    // their value, and it is not a credential.
    // The brand word sits in front of each value, inside the keyword gap,
    // so the silence is the key's and not the gap's.
    const cases = [
      `<p>together</p><a href="/bundle.js?v=${DIGEST}">built</a>`,
      `<script>x={vendor:"together","id":"${DIGEST}"}</script>`,
      `<script>x={vendor:"together",id:"${DIGEST}"}</script>`,
      `<script>x={vendor:"together",a:"${DIGEST}"}</script>`,
    ];
    for (const content of cases) {
      expect(scanContent(content, "html")).toEqual([]);
    }
    // The same page with a key that does name a credential reports.
    expect(
      scanContent(
        `<script>x={vendor:"together",token:"${TOGETHER_KEY}"}</script>`,
        "html"
      ).map((f) => f.value) // pragma: allowlist secret
    ).toEqual([TOGETHER_KEY]);
  });
});

describe("security/leaked-secrets: real credentials still report", () => {
  test("a Together key under a credential key is still reported as one", () => {
    // One finding each, and the value is always the key itself. The quoted JSON
    // form is claimed by the generic FAST tier now that it accepts a closing
    // quote (#150), so it reports under the broader name and carries the key
    // inside its match rather than as the whole match.
    const cases: Array<[string, string]> = [
      [`const togetherKey = "${TOGETHER_KEY}"`, "Together AI Key"], // pragma: allowlist secret
      [`{"together_secret":"${TOGETHER_KEY}"}`, "Generic Secret Assignment"], // pragma: allowlist secret
      [`window.TOGETHER_TOKEN = "${TOGETHER_KEY}"`, "Together AI Key"], // pragma: allowlist secret
    ];
    for (const [assignment, type] of cases) {
      const found = scanContent(assignment, "inline-script");
      expect(found.map((f) => f.type)).toEqual([type]);
      expect(found[0]?.value).toContain(TOGETHER_KEY);
    }
  });

  test("an Authorization: Bearer header is still reported", () => {
    const content = `together\nAuthorization: Bearer ${TOGETHER_KEY}`; // pragma: allowlist secret
    const found = scanContent(content, "html");
    expect(found.map((f) => f.type)).toContain("Bearer Token");
  });

  test("prefixed keys are untouched by the key-context gate", () => {
    // Each fixture joins its prefix at runtime: a whole token shape written as
    // one literal trips GitHub push protection, which rejects the push before
    // CI ever runs. The scanner sees the same string either way.
    const PREFIX = {
      github: "ghp_",
      stripe: "sk_live_",
      aws: "AKIA",
      slack: "xoxb-",
    };
    const fixtures: Array<[string, string]> = [
      [
        "GitHub Personal Access Token",
        `${PREFIX.github}${GH_BODY}${githubChecksum(GH_BODY)}`,
      ], // pragma: allowlist secret
      ["Stripe Live Key", `${PREFIX.stripe}51HxQ2mKz9pLvA3nR7dTfJw8Y`], // pragma: allowlist secret
      ["AWS Access Key ID", `${PREFIX.aws}2XJQ7LP4RNVD3KEB`], // pragma: allowlist secret
      [
        "Slack Token",
        `${PREFIX.slack}2094857361-3948572610-Kj8dPqR2mTvX5nB7wLcH1sZa`,
      ], // pragma: allowlist secret
      ["Private Key (RSA)", PEM_RSA], // pragma: allowlist secret
    ];

    for (const [type, value] of fixtures) {
      const found = scanContent(
        `<script>const v = "${value}";</script>`,
        "html"
      );
      expect(found.map((f) => f.type)).toContain(type);
    }
  });

  test("a key written as a bracket access is still read", () => {
    for (const assignment of [
      `cfg["apiKey"] = "${TOGETHER_KEY}"; // together`, // pragma: allowlist secret
      `cfg['x-api-key'] = "${TOGETHER_KEY}"; // together`, // pragma: allowlist secret
      `cfg["together"] = "${TOGETHER_KEY}"`, // pragma: allowlist secret
    ]) {
      const found = scanContent(assignment, "inline-script");
      // The generic FAST tier claims the `cfg["apiKey"] = ` form now that it
      // reads across `"]` (#150), so the key rides inside the reported value
      // rather than being the whole of it.
      expect(found.some((f) => f.value.includes(TOGETHER_KEY))).toBe(true);
    }
  });

  test("a minified member assignment is not a credential context (#357)", () => {
    // `t.a = "…"` used to report as "assigned". On 776 real sites that was the
    // Cloudflare challenge bootstrap and the Shopify pixel loader assigning
    // nonces to one-letter members within reach of a brand word, and not one
    // leak. A bare shape needs a key that names it.
    const content = `/* together.ai client */var t={};t.a="${TOGETHER_KEY}";`; // pragma: allowlist secret
    expect(scanContent(content, "inline-script")).toEqual([]);
    // The same value under a named key still reports.
    const named = `/* together.ai client */var t={};t.token="${TOGETHER_KEY}";`; // pragma: allowlist secret
    expect(scanContent(named, "inline-script").map((f) => f.value)).toEqual([
      TOGETHER_KEY,
    ]);
  });

  test("a naming attribute of the same tag is read in either order (#357)", () => {
    // The 40-character keyword gap is about prose distance. Inside one tag
    // the whole tag is the look-behind: `<meta content="…" name="…">` is the
    // attribute order a lot of generated HTML writes, and it names its value
    // exactly as the other order does.
    // Algolia's shape is 32 hex, and values are word-bounded now, so a
    // 64-hex value is not an Algolia key: this uses one of Algolia's length.
    const ALGOLIA_KEY = TOGETHER_KEY.slice(0, 32);
    const before = `<meta name="algolia-api-key" content="${ALGOLIA_KEY}">`; // pragma: allowlist secret
    expect(scanContent(before, "html").map((f) => f.value)).toEqual([
      ALGOLIA_KEY,
    ]);
    const after = `<meta content="${ALGOLIA_KEY}" name="algolia-api-key">`; // pragma: allowlist secret
    expect(scanContent(after, "html").map((f) => f.value)).toEqual([
      ALGOLIA_KEY,
    ]);
    // With other attributes between them, past the gap, still one tag.
    const spread = `<meta content="${ALGOLIA_KEY}" lang="en" dir="ltr" data-testid="release-row" property="og:x" name="algolia-api-key">`; // pragma: allowlist secret
    expect(scanContent(spread, "html").map((f) => f.value)).toEqual([
      ALGOLIA_KEY,
    ]);
    // The exception is the TAG's: the same keyword in the next tag, or in
    // text after the value, does not reach back.
    expect(
      scanContent(
        `<meta content="${ALGOLIA_KEY}"><meta name="algolia-api-key">`,
        "html"
      )
    ).toEqual([]);
    expect(
      scanContent(`<meta content="${ALGOLIA_KEY}"> algolia`, "html")
    ).toEqual([]);
    // And a digest-naming attribute still suppresses in either order.
    expect(
      scanContent(
        `<meta content="${DIGEST}" name="release-sha256"> together`,
        "html"
      )
    ).toEqual([]);
    expect(
      scanContent(
        `<meta name="together" content="${DIGEST}" data-sha256="x">`,
        "html"
      )
    ).toEqual([]);
  });

  test("the brand word names the value from up to the keyword gap before it, never after (#357)", () => {
    // No FAST pattern matches `credential=`, so the context tier is on its own.
    const assignment = `credential="${TOGETHER_KEY}"`; // pragma: allowlist secret
    // Filler, a statement break, then the assignment: the key must not be
    // glued to the filler or it stops being the word "credential".
    // From the end of the brand word to the first character of the value:
    // ` */` (3), the filler, `;` (1) and `credential="` (12).
    const at = (gap: number) =>
      `/* together */${"x".repeat(gap - 3 - 1 - 'credential="'.length)};${assignment}`;
    // 30 characters before the value: fires.
    expect(scanContent(at(30), "inline-script").map((f) => f.value)).toEqual([
      TOGETHER_KEY,
    ]);
    // Exactly the gap: fires. One past it: the word is elsewhere on the page.
    expect(
      scanContent(at(CONTEXT_KEYWORD_GAP), "inline-script").map((f) => f.value)
    ).toEqual([TOGETHER_KEY]);
    expect(scanContent(at(CONTEXT_KEYWORD_GAP + 1), "inline-script")).toEqual(
      []
    );
    expect(scanContent(at(60), "inline-script")).toEqual([]);
    // After the value, at any distance: never.
    expect(
      scanContent(`${assignment}; // together.ai`, "inline-script")
    ).toEqual([]);
    expect(
      scanContent(
        `${assignment};${"x".repeat(SECRET_CONTEXT_WINDOW_SIZE)}together`,
        "inline-script"
      )
    ).toEqual([]);
  });

  test("a long key beginning past the look-back budget still reports", () => {
    // End to end version of the look-back test: silent from N+1 before the fix.
    // The brand word sits at the END of the key so it is within the keyword
    // gap of the value; the key's start is what lies past the budget.
    const N = SECRET_KEY_LOOKBEHIND_SIZE;
    for (const distance of [N, N + 1, N + 2]) {
      const key = `${"z".repeat(distance - "togetherKey".length)}togetherKey`;
      const content = `;${key}="${TOGETHER_KEY}"`; // pragma: allowlist secret
      expect(
        scanContent(content, "inline-script").map((f) => f.value)
      ).toContain(TOGETHER_KEY);
    }
  });

  test("a bare-shape value is word-bounded: a run inside a longer run is not a value (#357)", () => {
    // Together's 64-hex shape is also the first 64 characters of a longer hex
    // run, and Twilio's 32-hex shape is the first half of a Together key. With
    // the value word-bounded, neither slice is a finding — only the whole run
    // under its own key is.
    const longer = `${TOGETHER_KEY}${"a1b2c3d4".repeat(2)}`;
    expect(scanContent(`togetherKey:"${longer}"`, "inline-script")).toEqual([]);
    expect(
      scanContent(`twilioAuth:"${TOGETHER_KEY}"`, "inline-script")
    ).toEqual([]);
    expect(
      scanContent(`togetherKey:"${TOGETHER_KEY}"`, "inline-script").map(
        (f) => f.value
      )
    ).toEqual([TOGETHER_KEY]);
  });

  test("a key too long for the look-back cannot invent a digest word", () => {
    // The walk runs out of room part-way through this key, and the fragment it
    // is left holding says `sha256` — a word the whole key never had. Reading
    // the fragment as a key suppresses a real credential, so a cut read is not
    // read at all: #175's direction, applied to the look-back itself.
    // Each separator puts the cut at a different offset inside the key, and a
    // `-`, a `.` or a digit is one the key patterns cannot start a match on.
    // The brand word ends the key so it sits within the keyword gap; it is
    // one word among many there, which names nothing on its own (#357).
    for (const separator of ["_", "-", ".", "7"]) {
      const key = `api_key_${"q".repeat(100)}${separator}${"z".repeat(84)}_xsha256_together`;
      const content = `"${key}"${" ".repeat(20)}:"${TOGETHER_KEY}";`; // pragma: allowlist secret
      expect(scanContent(content, "inline-script").map((f) => f.value)).toEqual(
        [TOGETHER_KEY]
      );
    }

    // A digest key the walk does reach the start of still suppresses, so the
    // guard buys the silence back only where the evidence was never read.
    const short = `"cache_${"z".repeat(20)}_sha256_together"${" ".repeat(20)}:"${DIGEST}";`;
    expect(scanContent(short, "inline-script")).toEqual([]);
  });

  test("public-by-design client keys stay informational, not leaks", async () => {
    const page = html(
      `<script>const cfg={apiKey:"AIzaSyD3mQ8xR2vT7pLnK4hW9cB1sE6yU0zJfXa"};</script>` // pragma: allowlist secret
    );
    const { checks } = await leakedSecretsRule.run(ctx(page));

    expect(findings(checks)).toEqual([]);
    expect(checks.find((c) => c.name === "leaked-secrets-public")?.status).toBe(
      "info"
    );
  });
});

// #1864 put a prefilter in front of the pattern loop: one pass over the content
// builds a 4-gram index, and a pattern whose mandatory literals the index does
// not contain is skipped instead of run. Every fixture above is a few hundred
// characters, which is BELOW the size at which the index is built at all, so
// none of them exercise it — the whole suite would stay green with the filter
// deleting findings on every real page.
//
// These pin the only property the filter has to have: padding a fixture out to
// the size of a real bundle must not lose anything it found unpadded. The pad
// is deliberately larger than 32 KB, the point at which the index reaches its
// widest table and the one arrangement its own unit tests did not reach.
describe("security/leaked-secrets: the content prefilter never loses a finding", () => {
  // Minified-looking JavaScript, so the gram index is populated the way a real
  // bundle populates it. Nothing here is a credential shape.
  const PAD = "function q0(a,b){return a+b*2}var z9=[1,2,3].map(q0);".repeat(
    1400
  );

  const PREFIX = {
    github: "ghp_",
    stripe: "sk_live_",
    aws: "AKIA",
    slack: "xoxb-",
  };

  // The quote is varied because the character IMMEDIATELY BEFORE a pattern's
  // literal is what the index's window hash must not depend on, and `"` (34)
  // and `'` (39) differ in the bit that a mis-masked hash leaks. One quote alone
  // makes this suite blind to that whole class of bug.
  const fixturesQuotedWith = (q: string): string[] => [
    `const togetherKey = ${q}${TOGETHER_KEY}${q}`, // pragma: allowlist secret
    `{${q}together_secret${q}:${q}${TOGETHER_KEY}${q}}`, // pragma: allowlist secret
    `together\nAuthorization: Bearer ${TOGETHER_KEY}`, // pragma: allowlist secret
    `const v = ${q}${PREFIX.github}${GH_BODY}${githubChecksum(GH_BODY)}${q};`, // pragma: allowlist secret
    `const v = ${q}${PREFIX.stripe}51HxQ2mKz9pLvA3nR7dTfJw8Y${q};`, // pragma: allowlist secret
    `const v = ${q}${PREFIX.aws}2XJQ7LP4RNVD3KEB${q};`, // pragma: allowlist secret
    `const v = ${q}${PREFIX.slack}2094857361-3948572610-Kj8dPqR2mTvX5nB7wLcH1sZa${q};`, // pragma: allowlist secret
    `const v = ${q}${PEM_RSA}${q};`, // pragma: allowlist secret
    `/* together.ai client */var t={};t.token=${q}${TOGETHER_KEY}${q};`, // pragma: allowlist secret
    `cfg[${q}apiKey${q}] = ${q}${TOGETHER_KEY}${q}; // together`, // pragma: allowlist secret
  ];
  const fixtures = ['"', "'"].flatMap(fixturesQuotedWith);

  // WHOLE findings, not just their values: a prefilter that skipped the pattern
  // which classifies a value would let a broader pattern claim it instead, and
  // the type, confidence, publicByDesign flag and location would all change
  // while the value stayed the same.
  test("every finding made unpadded is still made, unchanged, inside 70 KB of bundle", () => {
    const lost: string[] = [];
    const paddedPrefix = `${PAD}\n;\n`;
    const withoutOffset = ({
      offset: _offset,
      context: _context,
      ...finding
    }: LeakedSecret) => finding;
    for (const fixture of fixtures) {
      const bare = scanContent(fixture, "inline-script");
      expect(bare.length).toBeGreaterThan(0); // a vacuous fixture proves nothing
      const padded = scanContent(
        `${paddedPrefix}${fixture}\n;\n${PAD}`,
        "inline-script"
      );
      for (const finding of bare) {
        const same = padded.find(
          (candidate) =>
            JSON.stringify(withoutOffset(candidate)) ===
            JSON.stringify(withoutOffset(finding))
        );
        if (same) {
          expect(same.offset).toBe(finding.offset + paddedPrefix.length);
        } else {
          const near = padded.find((candidate) =>
            candidate.value.includes(finding.value)
          );
          lost.push(
            `${fixture.slice(0, 40)} → ${JSON.stringify(finding)} became ${JSON.stringify(near)}`
          );
        }
      }
    }
    expect(lost).toEqual([]);
  });

  test("the pad on its own is not a credential", () => {
    expect(scanContent(PAD, "inline-script")).toEqual([]);
  });

  // The context tier looks its keyword up in `content.toLowerCase()`, while the
  // index folds ASCII case and leaves everything else alone. Two characters in
  // Unicode lowercase INTO ASCII: U+212A KELVIN SIGN → "k" and U+0130 → "i" plus
  // a combining dot. On a page carrying one, a keyword can be in the lowercased
  // copy and absent from the index, and filtering on the index alone drops the
  // finding.
  test("a keyword that only exists after lowercasing is not filtered away", () => {
    const KELVIN = String.fromCharCode(0x212a);
    const UUID = "550e8400-e29b-41d4-a716-446655440000"; // pragma: allowlist secret
    const pad = "var q=1;".repeat(60);
    const ascii = `${pad}\npostmark_server_token = "${UUID}";\n${pad}`; // pragma: allowlist secret
    // `postmar` + KELVIN lowercases to exactly `postmark`.
    const folded = `${pad}\npostmar${KELVIN}_server_token = "${UUID}";\n${pad}`; // pragma: allowlist secret

    expect(folded.toLowerCase().includes("postmark")).toBe(true);
    expect(folded.includes("postmark")).toBe(false);

    const expected = scanContent(ascii, "inline-script").map((f) => f.value);
    expect(expected).toContain(UUID);
    expect(scanContent(folded, "inline-script").map((f) => f.value)).toEqual(
      expected
    );
  });
});

describe("classifyKeyContext", () => {
  test("names the key in front of a value", () => {
    expect(classifyKeyContext(`{filename:"x",sha256:"`, "together")).toBe(
      "digest"
    );
    expect(classifyKeyContext(`<code>sha256: `, "together")).toBe("digest");
    expect(classifyKeyContext(`integrity="sha384-`, "together")).toBe("digest");
    expect(classifyKeyContext(`"x-api-key": "`, "together")).toBe("credential");
    expect(classifyKeyContext(`api_key = "`, "together")).toBe("credential");
    expect(classifyKeyContext(`Authorization: Bearer `, "together")).toBe(
      "credential"
    );
    expect(classifyKeyContext(`together: "`, "together")).toBe("credential");
    expect(classifyKeyContext(`<td>`, "together")).toBe("none");
    expect(classifyKeyContext(`monkey: "`, "together")).toBe("none");
  });

  test("a digest key wins over a credential word in the same key", () => {
    expect(classifyKeyContext(`sha256Key: "`, "together")).toBe("digest");
  });

  test("parses a bracket access as the preceding key", () => {
    expect(classifyKeyContext(`cfg["apiKey"] = "`, "together")).toBe(
      "credential"
    );
    expect(classifyKeyContext(`cfg['x-api-key'] = "`, "together")).toBe(
      "credential"
    );
    expect(classifyKeyContext(`cfg["together"] = "`, "together")).toBe(
      "credential"
    );
    expect(classifyKeyContext(`cfg["sha256"] = "`, "together")).toBe("digest");
    expect(classifyKeyContext(`cfg["filename"] = "`, "together")).toBe("none");
  });

  test("an unquoted bracket names nothing", () => {
    // `labels[secret]` is a lookup keyed by a variable that happens to be
    // called secret. Only a quoted key inside the brackets names the value.
    expect(classifyKeyContext(`labels[secret] || "`, "together")).toBe("none");
    // A `:` or `=` still lands in the plain assignment fallback, which reports
    // on purpose — an unreadable key is how minified bundles look. Only the
    // fallback operators, where the left side is an expression, mean "none".
    expect(classifyKeyContext(`labels[apiKey]: "`, "together")).toBe(
      "assigned"
    );
    expect(classifyKeyContext(`cfg["apiKey"] || "`, "together")).toBe(
      "credential"
    );
    expect(
      classifyKeyContext(`process.env["SECRET_KEY"] || "`, "together")
    ).toBe("credential");
  });

  test("a minifier's member access names nothing, and nothing is not a credential (#357)", () => {
    expect(classifyKeyContext(`t.a = "`, "together")).toBe("none");
    expect(classifyKeyContext(`e.x2="`, "together")).toBe("none");
    expect(classifyKeyContext(`n["a"]="`, "together")).toBe("none");
    // A key long enough to mean something still has to say "credential".
    expect(classifyKeyContext(`filename: "`, "together")).toBe("none");
    expect(classifyKeyContext(`description = "`, "together")).toBe("none");
  });

  test("a short key that is not a member access still names its value", () => {
    // Short is not the same as meaningless: these all name something, and what
    // they name is not a credential.
    expect(classifyKeyContext(`?v=`, "together")).toBe("none");
    expect(classifyKeyContext(`&v="`, "together")).toBe("none");
    expect(classifyKeyContext(`{"id":"`, "together")).toBe("none");
    expect(classifyKeyContext(`id: "`, "together")).toBe("none");
    expect(classifyKeyContext(`n={a:"`, "together")).toBe("none");
  });

  test("a long key is read whole, never cut in half by the look-back", () => {
    // The credential word sits at the FRONT of the key, so a slice landing one
    // character inside it decapitates `keyZzz…` into `eyZzz…` and the key stops
    // meaning anything. Distances N, N+1 and N+2 all have to survive that.
    const N = SECRET_KEY_LOOKBEHIND_SIZE;
    for (const distance of [N, N + 1, N + 2]) {
      const key = `key${"Z".padEnd(distance - 2 - "key".length, "z")}`;
      const text = `;${key}="`;
      expect(
        classifyKeyContext(lookBehind(text, text.length), "together")
      ).toBe("credential");
    }
  });

  test("cache keys are digests; bare api is not a credential, bare key still is", () => {
    expect(classifyKeyContext(`cacheKey: "`, "together")).toBe("digest");
    expect(classifyKeyContext(`cache_key: "`, "together")).toBe("digest");
    expect(classifyKeyContext(`cachekey: "`, "together")).toBe("digest");
    expect(classifyKeyContext(`cache: "`, "together")).toBe("digest");
    expect(classifyKeyContext(`api: "`, "together")).toBe("none");
    // Deliberate: `key:"…"` is a weak signal but these are medium-confidence
    // findings, and dropping it costs real detections.
    expect(classifyKeyContext(`key: "`, "together")).toBe("credential");
    expect(classifyKeyContext(`api_key: "`, "together")).toBe("credential");
  });

  test("etag is recognised in lower-camel form", () => {
    expect(classifyKeyContext(`eTag: "`, "together")).toBe("digest");
    expect(classifyKeyContext(`eTagKey: "`, "together")).toBe("digest");
  });

  test("whitespace between the key and its value does not spend the budget", () => {
    // #177: a formatter, an aligned manifest or a minified line break can put
    // any amount of space between `"sha256"` and its value. Charging the budget
    // for it pushed the key out of the window, the look-back read back a bare
    // `:`, and an unnamed assignment reports — the digest became a leak.
    const classify = (text: string) =>
      classifyKeyContext(lookBehind(text, text.length), "together");

    for (const gap of [
      1,
      SECRET_KEY_LOOKBEHIND_SIZE,
      SECRET_KEY_LOOKBEHIND_SIZE * 4,
    ]) {
      const space = " ".repeat(gap);
      expect(classify(`{"sha256"${space}:"`)).toBe("digest");
      // The same shape under a credential key still reads as one, so the
      // silence is bought by reading the key rather than by giving up on it.
      expect(classify(`{"api_key"${space}:"`)).toBe("credential");
    }
    // Newlines and indentation are the same separator, however they are spelt.
    expect(classify(`{\n  "checksum"\n${" ".repeat(80)}:\n    "`)).toBe(
      "digest"
    );
    // A non-breaking space is whitespace to the `\s*` in the key patterns, so
    // the walk has to agree with them about it.
    expect(classify(`{"sha256"${"\u00a0".repeat(100)}:"`)).toBe("digest");
    // Free is not unbounded: past the scan limit the key is out of reach and
    // the look-back is a cut read again, which reports rather than suppresses.
    expect(
      classify(`{"sha256"${" ".repeat(SECRET_CONTEXT_WINDOW_SIZE * 4)}:"`)
    ).toBe("assigned");
  });

  test("a look-back that opens on a fragment reports the cut", () => {
    // The window's left edge can land mid-key, and the fragment left over can
    // read as a whole key: `sha256"   :"` is what `"api_key_xsha256"` looks
    // like once cut. `cut` is how classifyKeyContext knows not to trust it.
    const readBack = (text: string) => readKeyLookBack(text, text.length);

    const fragment = readBack(`sha256"${" ".repeat(200)}:"`);
    expect(fragment.cut).toBe(true);
    expect(
      classifyKeyContext(fragment.before, "together", undefined, true)
    ).toBe("assigned");
    // Read as if it were whole, the same text says "digest" — which is exactly
    // the suppression the flag exists to withhold.
    expect(classifyKeyContext(fragment.before, "together")).toBe("digest");

    // A key with its left edge in view is not a fragment.
    const whole = readBack(`{"sha256"${" ".repeat(200)}:"`);
    expect(whole.cut).toBe(false);
    expect(
      classifyKeyContext(whole.before, "together", undefined, whole.cut)
    ).toBe("digest");

    // Cutting must not cost the assignment itself: a minified member access at
    // the edge still means the value was assigned, and assigned values report.
    const minified = readBack(`t.a||"`);
    expect(minified.cut).toBe(true);
    expect(
      classifyKeyContext(minified.before, "together", undefined, true)
    ).toBe("assigned");
  });

  test("a cut is where the key stops being readable, not where it starts", () => {
    const cut = (text: string) =>
      classifyKeyContext(text, "together", undefined, true);

    // The key patterns cannot open on a digit, a `-` or a `.`, so the match can
    // start one character into the fragment and still be built out of it.
    expect(cut(`9sha256":"`)).toBe("assigned");
    expect(cut(`xsha256":"`)).toBe("assigned");
    expect(cut(`sha256":"`)).toBe("assigned");
    // A separator inside the fragment is a left edge the walk did see, so the
    // word after it is a word the key really has, whatever preceded the cut.
    expect(cut(`x.sha256":"`)).toBe("digest");
    expect(cut(`x-sha256":"`)).toBe("digest");
    expect(cut(`.sha256":"`)).toBe("digest");
    // Reading whole words off a cut key still leaves the key itself truncated,
    // and "this key says nothing" is not a verdict a truncated key can carry.
    expect(cut(`-zzzz_xsha256":"`)).toBe("assigned");
    expect(cut(`zzzz.filename":"`)).toBe("assigned");
    // Trusted, the same two texts are exactly the suppressions being withheld.
    expect(classifyKeyContext(`sha256":"`, "together")).toBe("digest");
    expect(classifyKeyContext(`zzzz.filename":"`, "together")).toBe("none");
  });

  test("reads the naming attribute of the same tag in either order", () => {
    const tag = (attrs: string) => `<meta ${attrs}>`;
    expect(
      classifyKeyContext(
        `<meta name="algolia-api-key" content="`,
        "algolia",
        tag(`name="algolia-api-key" content="x"`)
      )
    ).toBe("credential");
    // content first, name second — the old look-back could never see this.
    expect(
      classifyKeyContext(
        `<meta content="`,
        "algolia",
        tag(`content="x" name="algolia-api-key"`)
      )
    ).toBe("credential");
    expect(
      classifyKeyContext(
        `<meta content="`,
        "together",
        tag(`content="x" name="release-sha256"`)
      )
    ).toBe("digest");
    // Intervening attributes past the 64-char look-back no longer break it.
    expect(
      classifyKeyContext(
        `" data-testid="release-row" content="`,
        "algolia",
        tag(
          `name="algolia-api-key" lang="en" dir="ltr" data-testid="release-row" content="x"`
        )
      )
    ).toBe("credential");
  });

  test("reads the key across an env-var fallback", () => {
    expect(classifyKeyContext(`process.env.SECRET_KEY || "`, "together")).toBe(
      "credential"
    );
    expect(classifyKeyContext(`process.env.TOKEN ?? "`, "together")).toBe(
      "credential"
    );
    expect(classifyKeyContext(`togetherKey||"`, "together")).toBe("credential");
    // The fallback does not launder a digest key into a credential.
    expect(classifyKeyContext(`cacheKey || "`, "together")).toBe("digest");
    expect(classifyKeyContext(`sha256 ?? "`, "together")).toBe("digest");
    expect(classifyKeyContext(`commitHash || "`, "together")).toBe("digest");
    // Nor a key that means nothing into one that does.
    expect(classifyKeyContext(`filename || "`, "together")).toBe("none");
    expect(classifyKeyContext(`t.a || "`, "together")).toBe("none");
  });
});

// #150: three shapes that carry a real credential and used to report nothing.
// Each block pairs the shape with the false positive it sits next to, because
// widening a pattern is only correct if the silence it was protecting survives.
describe("security/leaked-secrets: #150 missed shapes", () => {
  test("a quoted JSON key is reported", () => {
    for (const key of ["apiKey", "api_key", "x-api-key", "APIKEY"]) {
      const found = scanContent(`{"${key}":"${COMMIT}"}`, "html"); // pragma: allowlist secret
      expect(found.map((f) => f.type)).toEqual(["Generic API Key Assignment"]);
      expect(found[0]?.value).toContain(COMMIT);
    }
  });

  test("a quoted JSON key inside a script[type=application/json] block is reported", async () => {
    const page = html(
      `<script type="application/json">{"x-api-key":"${COMMIT}"}</script>` // pragma: allowlist secret
    );
    const items = findings((await leakedSecretsRule.run(ctx(page))).checks);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toContain("Generic API Key Assignment");
  });

  test("the same 40 hex characters stay silent under a git-object key", () => {
    // Nothing in the value tells a git object id apart from an API key — only
    // the key in front of it does. The FAST tier carries its credential
    // keyword in the pattern, so `commit` can never reach it, and the
    // bare-shape CONTEXT tier needs a brand keyword a release page has no
    // reason to carry.
    for (const key of [
      "commit",
      "gitCommit",
      "sha",
      "revision",
      "etag",
      "cacheKey",
    ]) {
      expect(scanContent(`{"${key}":"${COMMIT}"}`, "html")).toEqual([]);
    }
  });

  test("a key that only ends in a credential word is not one", () => {
    // The key has to END where the separator begins, which is what stops the
    // widened patterns from claiming a digest whose name happens to start with
    // a credential word.
    for (const key of [
      "secret_hash",
      "secretHash",
      "apiKeyHash",
      "api_key_digest",
      "passwordDigest",
      "access_token_sha256",
    ]) {
      expect(scanContent(`{"${key}":"${COMMIT}"}`, "html")).toEqual([]);
      expect(
        scanContent(`x = ${key} || "${COMMIT}";`, "inline-script")
      ).toEqual([]);
    }
  });

  test("a compound key whose left half says digest is not a credential", () => {
    // These start the match part-way through the key — `cache-api-key` begins
    // an `api-key` match at character 6 — and the FAST tier has no
    // classifyKeyContext behind it, so the pattern reads its own left edge.
    // `_` and camelCase join a name wherever they appear; `-` needs syntax to
    // say so, which is the next test.
    for (const key of [
      "cache_api_key",
      "cacheApiKey",
      "checksumSecret",
      "sha256_secret",
    ]) {
      expect(scanContent(`{"${key}":"${COMMIT}"}`, "html")).toEqual([]);
      expect(scanContent(`{${key}:"${COMMIT}"}`, "html")).toEqual([]);
      expect(
        scanContent(`x = ${key} || "${COMMIT}";`, "inline-script")
      ).toEqual([]);
    }
    // The word to the left has to actually say digest: `x-api-key` and
    // `stripe_secret` are the same shape and both still report.
    for (const key of [
      "x-api-key",
      "myApiKey",
      "stripe_secret",
      "next_auth_token",
    ]) {
      expect(scanContent(`{"${key}":"${COMMIT}"}`, "html")).not.toEqual([]); // pragma: allowlist secret
    }
  });

  test("a hyphen joins a key only where the syntax says it does", () => {
    const hyphenated = [
      "cache-api-key",
      "checksum-secret",
      "integrity-auth-token",
      "etag-api-key",
    ];
    for (const key of hyphenated) {
      // Quoted: a JSON or YAML key, one name, a digest.
      expect(scanContent(`{"${key}":"${COMMIT}"}`, "html")).toEqual([]);
      expect(scanContent(`{'${key}':"${COMMIT}"}`, "html")).toEqual([]);
      // An HTML attribute name: also one name.
      expect(scanContent(`<img alt="" ${key}="${COMMIT}">`, "html")).toEqual(
        []
      );
      expect(
        scanContent(`<img alt="" data-${key}="${COMMIT}">`, "html")
      ).toEqual([]);
      // Bare, in identifier position, `-` is the subtraction operator. Reading
      // it as one key is what let a minified expression swallow a credential.
      expect(
        scanContent(`const x=${key}||"${COMMIT}"`, "inline-script")
      ).not.toEqual([]); // pragma: allowlist secret
      expect(
        scanContent(`x = ${key} || "${COMMIT}";`, "inline-script")
      ).not.toEqual([]); // pragma: allowlist secret
    }
    // The shape the fix exists for: a real credential behind a minified
    // subtraction. `cache-apiKey` is `cache` minus `apiKey`, not a cache key.
    expect(
      scanContent(`const x=cache-apiKey||"${TOGETHER_KEY}"`, "inline-script") // pragma: allowlist secret
        .some((f) => f.value.includes(TOGETHER_KEY))
    ).toBe(true);
  });

  test("an unquoted computed lookup is not a credential name", () => {
    // `translations[apiKey]` names a translation, not a key. The `]` only
    // counts when it closes a QUOTED key.
    for (const expr of [
      `translations[apiKey] ||= "This is a harmless display label"`,
      `labels[secret] || "Password must have eight characters"`,
      `messages[apiKey] || "${COMMIT}"`,
      `t[access_token] ||= "${COMMIT}"`,
      // The context tier reads the same bracket, so it needs the same rule.
      `labels[secret] || "${DIGEST}"; // together.ai`,
      `strings[apiKey] || "${DIGEST}"; // together.ai`,
    ]) {
      expect(scanContent(expr, "inline-script")).toEqual([]);
    }
    // The quoted bracket form is still read.
    for (const expr of [
      `cfg["apiKey"] || "${COMMIT}"`, // pragma: allowlist secret
      `cfg['x-api-key'] = "${COMMIT}"`, // pragma: allowlist secret
      `const k = process.env["SECRET_KEY"] || "${TOGETHER_KEY}";`, // pragma: allowlist secret
    ]) {
      expect(scanContent(expr, "inline-script")).not.toEqual([]);
    }
  });

  test("a digest word in a member path is not part of the key", () => {
    // `cache.apiKey` is the apiKey OF a cache, not a key called
    // `cache.apiKey` — the walk stops at the dot.
    for (const path of [
      "cache.apiKey",
      "config.cache.apiKey",
      "sha256.apiKey",
    ]) {
      expect(
        scanContent(`${path} = "${COMMIT}";`, "inline-script")
      ).not.toEqual([]); // pragma: allowlist secret
    }
  });

  test("a key too long to read whole does not suppress", () => {
    // Spending the whole look-back budget means the prefix was cut, not read.
    const budget = SECRET_KEY_LOOKBEHIND_SIZE * 2;

    // A cut can lose a digest word off the front…
    const lost = `cache-${"y".repeat(budget)}-api-key`;
    expect(scanContent(`{"${lost}":"${COMMIT}"}`, "html")).not.toEqual([]); // pragma: allowlist secret

    // …and it can invent one out of the middle. `cache-` here is the tail of
    // `xcache-`, not a word, and the cut lands on exactly its first character.
    // Without the guard the key reads as a digest and the credential goes
    // silent — the one direction that must never happen by accident.
    const invented = `xcache-${"y".repeat(budget - 7)}-api-key`;
    expect(invented.indexOf("api-key")).toBe(budget + 1);
    expect(scanContent(`{"${invented}":"${COMMIT}"}`, "html")).not.toEqual([]); // pragma: allowlist secret

    // The guard is about the budget, not about giving up: a digest word the
    // walk reaches within it still suppresses.
    const read = `cache-${"y".repeat(100)}-api-key`;
    expect(read.indexOf("api-key")).toBeLessThan(budget);
    expect(scanContent(`{"${read}":"${COMMIT}"}`, "html")).toEqual([]);
  });

  test("a fallback with no key in front of it is not an assignment", () => {
    // `||` only makes a value position when something nameable precedes it.
    // A call expression names nothing, and a checksum falling back to a
    // literal is exactly the shape that would be misread.
    for (const expr of ["getChecksum()", "hashes.get(name)", "digestOf(x)"]) {
      const content = `/* together.ai */ const v = ${expr} || "${DIGEST}";`;
      expect(scanContent(content, "inline-script")).toEqual([]);
    }
    // A name in front of the fallback still reports; a minified member is not
    // a name (#357).
    expect(
      scanContent(
        `/* together.ai */ const v = cfg.token || "${TOGETHER_KEY}";`,
        "inline-script"
      ).map((f) => f.value) // pragma: allowlist secret
    ).toEqual([TOGETHER_KEY]);
    expect(
      scanContent(`/* together.ai */ t.a||"${TOGETHER_KEY}";`, "inline-script")
    ).toEqual([]); // pragma: allowlist secret
  });

  test("a hardcoded fallback behind an env var is reported", () => {
    const cases = [
      `const k = process.env.SECRET_KEY || "${TOGETHER_KEY}";`, // pragma: allowlist secret
      `const k = process.env.SECRET_KEY ?? "${TOGETHER_KEY}";`, // pragma: allowlist secret
      `const k = process.env.API_KEY || "${TOGETHER_KEY}";`, // pragma: allowlist secret
      `const k = process.env.AUTH_TOKEN || "${TOGETHER_KEY}";`, // pragma: allowlist secret
      `const k = process.env.PASSWORD||"${TOGETHER_KEY}";`, // pragma: allowlist secret
      `process.env.SECRET_KEY ||= "${TOGETHER_KEY}";`, // pragma: allowlist secret
      `process.env.SECRET_KEY ??= "${TOGETHER_KEY}";`, // pragma: allowlist secret
      `const k = process.env["SECRET_KEY"] || "${TOGETHER_KEY}";`, // pragma: allowlist secret
      `const k = process.env['API_KEY'] ?? "${TOGETHER_KEY}";`, // pragma: allowlist secret
    ];
    for (const content of cases) {
      const found = scanContent(content, "inline-script");
      expect(found).toHaveLength(1);
      expect(found[0]?.value).toContain(TOGETHER_KEY);
    }
  });

  test("a fallback reaches the context tier too, without laundering a digest", () => {
    // No FAST pattern matches `togetherKey`, so this only reports if
    // isInValuePosition and classifyKeyContext both read across the `||`.
    for (const content of [
      `const v = togetherKey || "${TOGETHER_KEY}";`, // pragma: allowlist secret
      `/* together.ai */ const v = credential ?? "${TOGETHER_KEY}";`, // pragma: allowlist secret
    ]) {
      expect(scanContent(content, "inline-script").map((f) => f.value)).toEqual(
        [TOGETHER_KEY]
      );
    }
    // Same shape, digest key: the published checksum stays silent.
    for (const key of [
      "cacheKey",
      "sha256",
      "etag",
      "commitHash",
      "integrityHash",
    ]) {
      const content = `/* together.ai */ const v = ${key} || "${DIGEST}";`;
      expect(scanContent(content, "inline-script")).toEqual([]);
    }
  });

  test("a standard-base64 Bearer token is reported with its padding intact", () => {
    // The fixture is genuine base64: it survives a decode/encode round trip, so
    // this pins support for the real encoding, not just for the characters.
    expect(Buffer.from(B64_TOKEN, "base64").toString("base64")).toBe(B64_TOKEN);

    const found = scanContent(`authorization: "Bearer ${B64_TOKEN}"`, "html"); // pragma: allowlist secret
    expect(found.map((f) => f.type)).toEqual(["Bearer Token"]);
    expect(found[0]?.value).toBe(`Bearer ${B64_TOKEN}`);
  });

  test("padding alone is not a Bearer token", () => {
    // `=` is trailing and capped at two, so a run of padding characters cannot
    // reach the length threshold on its own.
    expect(scanContent(`Bearer ${"=".repeat(40)}`, "html")).toEqual([]);
    expect(scanContent(`Bearer ${"=".repeat(19)}abc`, "html")).toEqual([]);
    // …and a token never carries more than two.
    const found = scanContent(`Bearer ${B64_TOKEN}====`, "html"); // pragma: allowlist secret
    expect(found[0]?.value).toBe(`Bearer ${B64_TOKEN}=`);
  });

  test("a base64url Bearer token still matches after the class widened", () => {
    // `-` sits last in `[a-zA-Z0-9_+/=-]` so it stays a literal, not a range.
    const urlSafe = "ab-cd_efGH12-34_jkLMnopQRstuvWXyz0123456789ABCDefgh"; // pragma: allowlist secret
    const found = scanContent(`authorization: "Bearer ${urlSafe}"`, "html"); // pragma: allowlist secret
    expect(found.map((f) => f.value)).toEqual([`Bearer ${urlSafe}`]);
  });

  test("npm lockfile integrity entries report nothing", () => {
    // The highest-volume standard-base64 blob on the real web, `+` `/` `=` and
    // all. It has to survive the widened Bearer class untouched.
    const entry = (i: number) =>
      `"node_modules/pkg-${i}": { "version": "1.2.${i}", "integrity": "sha512-${SRI_B64}${i}Xy+9/Qz==" }`;
    const lock = `{ "packages": { ${[0, 1, 2, 3, 4].map(entry).join(", ")} } }`;
    expect(scanContent(lock, "html")).toEqual([]);
  });

  test("an SRI hash in standard base64 is not a Bearer token", () => {
    const tag = `<script src="https://cdn.example.net/lib.js" integrity="sha384-${SRI_B64}" crossorigin="anonymous"></script>`;
    expect(scanContent(tag, "html")).toEqual([]);
    // Still silent with the word Bearer on the same page: the class stops at
    // the space, so `Bearer token.` never reaches the length threshold.
    expect(scanContent(`<p>Send a Bearer token.</p>${tag}`, "html")).toEqual(
      []
    );
  });

  test("a base64 image data URI reports nothing", async () => {
    const page = html(
      `<img alt="logo" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==">`
    );
    expect(findings((await leakedSecretsRule.run(ctx(page))).checks)).toEqual(
      []
    );
  });

  test("two secrets on one line are both reported", () => {
    // A widened pattern that ran to end of line would swallow the second one.
    const line = `{"apiKey":"${COMMIT}","access_token":"${OAUTH_TOKEN}"}`; // pragma: allowlist secret
    const found = scanContent(line, "html");
    expect(found.map((f) => f.type)).toEqual([
      "Generic API Key Assignment",
      "Generic Token Assignment",
    ]);
    expect(found[0]?.value).toContain(COMMIT);
    expect(found[1]?.value).toContain(OAUTH_TOKEN);

    const headers = `{"authorization":"Bearer ${B64_TOKEN}","x-proxy":"Bearer ${B64_TOKEN_2}"}`; // pragma: allowlist secret
    expect(scanContent(headers, "html").map((f) => f.value)).toEqual([
      `Bearer ${B64_TOKEN}`,
      `Bearer ${B64_TOKEN_2}`,
    ]);
  });

  test("a long minified line stays linear", () => {
    // These patterns run over whole crawled bundles. Every one of them is a
    // literal keyword plus one greedy character class, so the work is linear —
    // this pins that it stays that way after the widening.
    const chunk = `var a${"b".repeat(40)}=function(t){return t.apiKey||t.secret||"Bearer "+t.token};`;
    for (const line of [
      chunk.repeat(4000),
      // A credential word followed by a long whitespace run and no separator.
      // Two adjacent unbounded `\s*` quantifiers here would partition the run
      // every possible way before giving up: 12s at 64 KB, and `\s` matches
      // newlines, so pretty-printed HTML gets there on its own.
      `apiKey${" ".repeat(200_000)}x`,
      `{"apiKey"${"\n".repeat(200_000)}:"x"}`,
      // Unterminated quoted values: the generic secret pattern's `[^'"]{8,}`
      // has to give up on each of these without exploring the whole tail.
      `x={${`secret:"${"y".repeat(200)},`.repeat(2000)}}`,
      `Bearer ${"A+b/c=".repeat(20000)}`,
    ]) {
      const start = performance.now();
      scanContent(line, "external-script");
      expect(performance.now() - start).toBeLessThan(5000);
    }
  });
});

// #176: overlap suppression was O(findings^2) — every candidate compared
// against every value already kept. An 880 KB page producing 16k findings spent
// 2.1s of a 2.2s scan inside that one loop. The window index replaced the loop,
// and the only thing that matters about it is that it answers identically.
describe("security/leaked-secrets: overlap suppression", () => {
  // The predicate the index replaced, verbatim. Every assertion below is the
  // index against this, because "faster" is only worth having if it agrees.
  const pairwise = (kept: string[], value: string) =>
    kept.some((seen) => value.includes(seen) || seen.includes(value));

  const rng = (seed: number) => () =>
    ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) + 1) >>> 0) /
    4294967296;
  const CHARS =
    "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const runOf = (r: () => number, n: number) =>
    Array.from(
      { length: n },
      () => CHARS[Math.floor(r() * CHARS.length)]!
    ).join("");

  test("the index answers exactly what the pairwise scan answered", () => {
    // The shapes that break a window index if it is wrong: values shorter than
    // one window and longer than the index will take, values sharing a long
    // head (every JWT does) or a long tail, values nested inside each other,
    // and repeats.
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const head = runOf(r, 20);
      const tail = runOf(r, 20);
      const index = createSeenValues(4096);
      const kept: string[] = [];

      for (let i = 0; i < 60; i++) {
        const pickShape = Math.floor(r() * 9);
        let value =
          pickShape === 0
            ? runOf(r, 1 + Math.floor(r() * 11)) // below one window
            : pickShape === 1
              ? `${head}${runOf(r, 1 + Math.floor(r() * 20))}`
              : pickShape === 2
                ? `${runOf(r, 1 + Math.floor(r() * 20))}${tail}`
                : pickShape === 3
                  ? `${head}${runOf(r, 10)}${tail}`
                  : pickShape === 4 && kept.length > 0
                    ? kept[Math.floor(r() * kept.length)]!
                    : pickShape === 5 && kept.length > 0
                      ? (() => {
                          const base = kept[Math.floor(r() * kept.length)]!;
                          return (
                            base.slice(Math.floor(r() * base.length)) || base
                          );
                        })()
                      : pickShape === 6 && kept.length > 0
                        ? `${runOf(r, 3)}${kept[Math.floor(r() * kept.length)]!}${runOf(r, 3)}`
                        : // Past the length the index will take: a runaway connection-string
                          // match is megabytes, and those are held aside rather than indexed.
                          pickShape === 7
                          ? `${head}${runOf(r, 1000 + Math.floor(r() * 60))}`
                          : runOf(r, 12 + Math.floor(r() * 40));
        if (value === "") value = "x";

        expect(index.overlaps(value)).toBe(pairwise(kept, value));
        expect(index.has(value)).toBe(kept.includes(value));

        // Mirror scanContent: a value is only kept when nothing suppressed it.
        if (!index.has(value) && !index.overlaps(value)) {
          index.add(value);
          kept.push(value);
        }
      }
    }
  });

  test("a value equal to, inside, or around a kept value all suppress", () => {
    const index = createSeenValues(4096);
    const key = `AIza${"b".repeat(35)}`; // pragma: allowlist secret
    index.add(key);

    expect(index.overlaps(key)).toBe(true); // the same value
    expect(index.overlaps(`apiKey:"${key}"`)).toBe(true); // wrapped around it
    expect(index.overlaps(key.slice(4))).toBe(true); // sitting inside it
    expect(index.overlaps(`AIza${"c".repeat(35)}`)).toBe(false); // unrelated
  });

  test("a value shorter than one window is still matched both ways", () => {
    const index = createSeenValues(4096);
    index.add("ya29.ab"); // 7 characters, below the window size
    expect(index.overlaps("ya29.ab")).toBe(true);
    expect(index.overlaps("token=ya29.ab;")).toBe(true);
    expect(index.overlaps("ya29.a")).toBe(true); // inside the kept value
    expect(index.overlaps("ya29.zz")).toBe(false);
  });

  test("suppression stays linear enough to survive a 16k-finding page", () => {
    // The page from #176's report: a bundle of distinct browser keys, every one
    // of them a finding. Pairwise, this took 2.1s; the shape of the check is
    // what this pins, so the assertion is on how the cost SCALES — an absolute
    // budget only measures the CI runner, but going quadratic again shows up as
    // 64x for an 8x page whatever the machine.
    const r = rng(7);
    const page = (n: number) =>
      Array.from(
        { length: n },
        () => `cfg.push({k:"AIza${runOf(r, 35)}"});`
      ).join("");
    const small = page(2000);
    const large = page(16000);

    scanContent(small, "inline-script"); // warm the JIT before either reading
    scanContent(large, "inline-script");

    // Fastest of three: a scheduling pause can only ever make a run look
    // slower, so the minimum is the reading least likely to flake.
    const timeOf = (content: string) => {
      let ms = Infinity;
      let findings = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = performance.now();
        findings = scanContent(content, "inline-script").length;
        ms = Math.min(ms, performance.now() - started);
      }
      return { ms, findings };
    };
    const smallRun = timeOf(small);
    const largeRun = timeOf(large);

    // Near enough to one finding per key: a couple of the generated keys
    // genuinely overlap, and suppressing those is the point of the function.
    expect(smallRun.findings).toBeGreaterThan(1990);
    expect(largeRun.findings).toBeGreaterThan(15900);
    // 8x the page. Linear would be 8x the time; the pairwise scan was 64x.
    expect(largeRun.ms / Math.max(smallRun.ms, 0.5)).toBeLessThan(24);
    // A backstop for the absolute cliff the issue reported, loose enough for a
    // loaded CI runner and still an order of magnitude under 2.1s.
    expect(largeRun.ms).toBeLessThan(1000);
  });
});

// #574: a vendor's public identifier in the query of a script URL is not a
// leak. The fixtures use secret-shaped values on purpose (a DigitalOcean
// Spaces key shape, an AWS access key ID shape), so the suppression is proven
// against a real finding rather than against a value nothing would flag.
const SPACES_SHAPE = "DO" + "ABCDEFGHJKLMNPQRST12"; // pragma: allowlist secret
const AWS_SHAPE = "AKIA" + "IOSFODNN7EXAMPLE"; // pragma: allowlist secret
const REAL_SECRET = "sk_live_" + "Zq7mR2xKd9LpV4nB8cT5wY3j"; // pragma: allowlist secret

async function reported(pageHtml: string) {
  const result = await leakedSecretsRule.run(ctx(pageHtml));
  return {
    findings: findings(result.checks),
    names: result.checks.map((c) => c.name),
  };
}

describe("security/leaked-secrets: vendor public identifiers in URL queries (#574)", () => {
  // The issue's repro, in the shape its reporter saw (a medium finding).
  test("the Mida optimize.js repro reports nothing", async () => {
    const { findings: items, names } = await reported(
      html(
        `<script async src="https://cdn.mida.so/js/optimize.js?key=${SPACES_SHAPE}"></script>`
      )
    );
    expect(items).toEqual([]);
    expect(names).toEqual(["leaked-secrets"]);
  });

  // [vendor, tag, value] — one row per table entry, with both attributes.
  const VENDOR_CASES: Array<[string, string]> = [
    ["Mida", "https://cdn.mida.so/js/optimize.js?key="],
    ["Mida (EU)", "https://cdn-eu.mida.so/js/optimize.js?key="],
    ["Klaviyo", "https://static.klaviyo.com/onsite/js/klaviyo.js?company_id="],
    [
      "Klaviyo (extra params)",
      "https://static.klaviyo.com/onsite/js/klaviyo.js?v=2&company_id=",
    ],
    ["reCAPTCHA", "https://www.google.com/recaptcha/api.js?render="],
    [
      "reCAPTCHA (recaptcha.net)",
      "https://www.recaptcha.net/recaptcha/enterprise.js?render=",
    ],
    ["protocol-relative", "//cdn.mida.so/js/optimize.js?key="],
  ];

  for (const value of [SPACES_SHAPE, AWS_SHAPE]) {
    for (const [vendor, prefix] of VENDOR_CASES) {
      test(`${vendor}: ${value.slice(0, 4)}-shaped value in src and href is not reported`, async () => {
        const { findings: items, names } = await reported(
          html(
            `<script async src="${prefix}${value}"></script><link rel="preload" as="script" href="${prefix}${value}&x=1">`
          )
        );
        expect(items).toEqual([]);
        expect(names).not.toContain("leaked-secrets-public");
      });
    }
  }

  test("every table row is exercised above and names real hosts, paths and params", () => {
    const covered = VENDOR_CASES.map(([, prefix]) => prefix).join("\n");
    for (const entry of PUBLIC_URL_IDENTIFIERS) {
      expect(entry.hosts.length).toBeGreaterThan(0);
      expect(entry.params.length).toBeGreaterThan(0);
      for (const host of entry.hosts) expect(host).toBe(host.toLowerCase());
      for (const path of entry.paths) expect(path.startsWith("/")).toBe(true);
      expect(entry.hosts.some((host) => covered.includes(host))).toBe(true);
    }
  });

  // Same parameter, same shape: not a known vendor, so still a credential.
  const STILL_REPORTED: Array<[string, string]> = [
    [
      "unknown host, Mida's path and param",
      "https://cdn.example.net/js/optimize.js?key=",
    ],
    [
      "unknown host, Klaviyo's path and param",
      "https://static.example.net/onsite/js/klaviyo.js?company_id=",
    ],
    [
      "lookalike host suffix",
      "https://cdn.mida.so.evil.test/js/optimize.js?key=",
    ],
    ["lookalike host prefix", "https://evilcdn.mida.so/js/optimize.js?key="],
    ["userinfo trick", "https://cdn.mida.so@evil.test/js/optimize.js?key="],
    ["port on the vendor host", "https://cdn.mida.so:8443/js/optimize.js?key="],
    [
      "vendor host inside another URL's path",
      "https://evil.test/redirect//cdn.mida.so/js/optimize.js?key=",
    ],
    ["vendor host, other path", "https://cdn.mida.so/js/other.js?key="],
    ["vendor host, other param", "https://cdn.mida.so/js/optimize.js?token="],
    [
      "vendor param, wrong parameter name case",
      "https://cdn.mida.so/js/optimize.js?KEY=",
    ],
  ];
  for (const [label, prefix] of STILL_REPORTED) {
    test(`still reported: ${label}`, async () => {
      const { findings: items } = await reported(
        html(`<script async src="${prefix}${SPACES_SHAPE}"></script>`)
      );
      expect(items.length).toBe(1);
      expect(items[0]!.id).toContain("DigitalOcean Spaces Key");
    });
  }

  test("a vendor URL does not hide a real secret elsewhere on the page", async () => {
    const { findings: items } = await reported(
      html(
        `<script async src="https://cdn.mida.so/js/optimize.js?key=${SPACES_SHAPE}"></script>` +
          `<script>var cfg = { token: "${REAL_SECRET}" };</script>`
      )
    );
    expect(items.map((i) => i.id).join("\n")).toContain("Stripe Live Key");
    expect(items.some((i) => i.id.includes("DigitalOcean"))).toBe(false);
  });

  test("the same value outside the vendor URL is still reported", async () => {
    const { findings: items } = await reported(
      html(
        `<script async src="https://cdn.mida.so/js/optimize.js?key=${SPACES_SHAPE}"></script>` +
          `<p>Spaces key: ${SPACES_SHAPE}</p>`
      )
    );
    expect(items.length).toBe(1);
  });

  test("a longer secret that contains the identifier is not hidden by it", async () => {
    const { findings: items } = await reported(
      html(
        `<script async src="https://cdn.mida.so/js/optimize.js?key=${SPACES_SHAPE}"></script>` +
          `<script>var u = "postgres://app:${SPACES_SHAPE}@db.internal/prod";</script>`
      )
    );
    expect(items.map((i) => i.id).join("\n")).toContain("PostgreSQL");
  });

  test("a secret in a non-identifier parameter of a vendor URL is still reported", async () => {
    const { findings: items } = await reported(
      html(
        `<script async src="https://cdn.mida.so/js/optimize.js?key=abc123&auth=${REAL_SECRET}"></script>`
      )
    );
    expect(items.map((i) => i.id).join("\n")).toContain("Stripe Live Key");
  });
});

describe("evidence context (repo#2215)", () => {
  test("finding carries a redacted context with neighbours masked", async () => {
    const { scanContent } = await import("../src/security/leaked-secrets");
    const key = ["sk", "live", "abcdefghijklmnopqrstuvwx12"].join("_"); // assembled so the fixture is not a literal secret
    const neighbour = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const html = `<script>var a="x"; var k="${key}"; var other="${neighbour}";</script>`;
    const found = scanContent(
      html,
      "inline-script",
      "https://example.com/a.js"
    );
    const stripe = found.find((f) => f.type === "Stripe Live Key");
    expect(stripe?.context).toBe(
      `<script>var a="*"; var k="sk_liv********************wx12"; var other="********************";</script>`
    );
    for (const f of found) {
      expect(f.context).toBeDefined();
      expect(f.context).not.toContain(key);
      expect(f.context).not.toContain(neighbour);
    }
    expect(stripe?.sourceUrl).toBe("https://example.com/a.js");
  });
});

describe("evidence context redacts every nearby secret (repo#2215)", () => {
  const key = ["sk", "live", "abcdefghijklmnopqrstuvwx12"].join("_"); // assembled so the fixture is not a literal secret

  test("a short quoted password beside the match is masked", async () => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    const pw = ["hunter", "2pw!"].join("");
    const content = `var k="${key}"; var pw="${pw}"; var n="ab";`;
    const ctx = evidenceContext(content, content.indexOf(key), key.length, key);
    expect(ctx).toBeDefined();
    expect(ctx).not.toContain(pw);
    expect(ctx).toContain(`var pw="**********"`);
    expect(ctx).toContain(`var k="sk_liv`);
    expect(ctx).toContain(`var n="**"`);
  });

  test("a quoted literal before the match is masked and the code between literals is kept", async () => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    const pw = ["pass", " word", " 99"].join("");
    const content = `login('${pw}'); stripe("${key}")`;
    const ctx = evidenceContext(content, content.indexOf(key), key.length, key);
    expect(ctx).not.toContain(pw);
    expect(ctx?.startsWith(`login('************'); stripe("sk_liv`)).toBe(true);
  });

  test("a token run cut off at either window edge is dropped, not shown in part", async () => {
    const { evidenceContext, EVIDENCE_CONTEXT_RADIUS } =
      await import("../src/security/leaked-secrets");
    const left = "L".repeat(10) + "0123456789abcdefghij"; // 30 token chars, only the tail inside the window
    const right = "zyxwvutsrqponmlkjihg" + "R".repeat(10);
    const fill = (n: number) => " ".repeat(n);
    const content = `${left}${fill(EVIDENCE_CONTEXT_RADIUS - 15)}=${key};${fill(EVIDENCE_CONTEXT_RADIUS - 15)}${right}`;
    const at = content.indexOf(key);
    const ctx = evidenceContext(content, at, key.length, key);
    expect(ctx).toBeDefined();
    for (const frag of ["fghij", "abcde", "zyxwv", "rqpon"])
      expect(ctx).not.toContain(frag);
    expect(ctx).toBe(` =sk_liv********************wx12; `);
  });

  test("a literal cut off at the window edge is masked up to that edge", async () => {
    const { evidenceContext, EVIDENCE_CONTEXT_RADIUS } =
      await import("../src/security/leaked-secrets");
    const secretTail = "my secret pass!";
    const content = `x="${"a".repeat(EVIDENCE_CONTEXT_RADIUS)} ${secretTail}"; k="${key}"`;
    const ctx = evidenceContext(content, content.indexOf(key), key.length, key);
    expect(ctx).not.toContain("secret pass");
    expect(ctx).toContain(`"; k="sk_liv`);
  });

  test("when the match is not directly quoted, both readings of the nearby quotes are masked", async () => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    const pw = ["hunter", "2pw"].join("");
    const content = `u("https://a.example/?k=${key}&x=1", pw="${pw}")`;
    const ctx = evidenceContext(content, content.indexOf(key), key.length, key);
    expect(ctx).not.toContain(pw);
  });

  test("an unquoted password beside a quoted match is masked, punctuation and all", async () => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    for (const pw of [
      ["p@ss", "w0rd!"].join(""),
      ["a#b$", "c&d!e%f"].join(""),
      ["s3cr", "et"].join(""),
      ["p@ss", "w0rd!x".repeat(4)].join(""),
    ]) {
      const content = `STRIPE_KEY="${key}"\nDB_PASSWORD=${pw}\nDEBUG=1`;
      const ctx = evidenceContext(
        content,
        content.indexOf(key),
        key.length,
        key
      );
      expect(ctx).toBeDefined();
      expect(ctx).not.toContain(pw);
      expect(ctx).not.toContain(pw.slice(4));
      expect(ctx).toContain(`STRIPE_KEY="sk_liv`);
      expect(ctx).toContain("DEBUG=*");
    }
  });

  test("an unquoted password before the match and in a query string is masked", async () => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    const pw = ["hun", "ter2!@#"].join("");
    const content = `password: ${pw} key: "${key}" u=https://a.example/?pw=${pw}&x=1`;
    const ctx = evidenceContext(content, content.indexOf(key), key.length, key);
    expect(ctx).not.toContain(pw);
    expect(ctx).not.toContain(pw.slice(3));
    // The labelled value on the match's own line is starred up to the match (pub#1959 round 4), `key:` with it.
    expect(ctx).toContain("password: ");
    expect(ctx).toContain(`"sk_liv`);
  });

  test("a punctuated run cut off at the window edge is dropped", async () => {
    const { evidenceContext, EVIDENCE_CONTEXT_RADIUS } =
      await import("../src/security/leaked-secrets");
    const tail = "!@#$%^&*p@ss";
    const content = `${"x".repeat(10)}${tail}${" ".repeat(EVIDENCE_CONTEXT_RADIUS - tail.length)}${key}`;
    const ctx = evidenceContext(content, content.indexOf(key), key.length, key);
    expect(ctx).not.toContain("p@ss");
    expect(ctx).not.toContain("!@#");
  });
});

// Batch 2 redaction fix: a nearby value the scanner did not recognize shows none of its characters. The draft masked
// nearby values like the item id (first six and last four characters kept), so a 13 to 19 character password kept 10 of
// its characters, and an unquoted 16-character bearer token or a bare `p@ssw0rd!` after a label was shown in full.
describe("evidence context never shows part of a nearby secret (repo#2215)", () => {
  const key = ["sk", "live", "abcdefghijklmnopqrstuvwx12"].join("_"); // assembled so the fixture is not a literal secret

  test("a short bearer token after the match is starred out", async () => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    const token = ["abcdEFGH", "1234ijkl"].join("");
    const content = `const s="${key}"; fetch(u,{headers:{Authorization: Bearer ${token}}})`;
    const ctx = evidenceContext(content, content.indexOf(key), key.length, key);
    expect(ctx).toBeDefined();
    for (const frag of [token.slice(0, 4), token.slice(-4), token.slice(4, 12)])
      expect(ctx).not.toContain(frag);
  });

  test("a letter-and-digit word after a label is starred out", async () => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    const pw = ["p@ss", "w0rd!"].join("");
    const content = `const s="${key}"; password ${pw}`;
    const ctx = evidenceContext(content, content.indexOf(key), key.length, key);
    expect(ctx).not.toContain("p@ss");
    expect(ctx).not.toContain("w0rd");
  });

  test("a 13-character quoted password keeps none of its characters", async () => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    const pw = ["Tr0ub", "4dor&3x"].join("");
    const content = `var k="${key}"; var pw="${pw}";`;
    const ctx = evidenceContext(content, content.indexOf(key), key.length, key);
    expect(ctx).toContain(`var pw="${"*".repeat(pw.length)}"`);
    for (const frag of [pw.slice(0, 4), pw.slice(-4)])
      expect(ctx).not.toContain(frag);
  });

  test("the match itself is masked exactly as its item id", async () => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    const content = `var k="${key}";`;
    const ctx = evidenceContext(content, content.indexOf(key), key.length, key);
    expect(ctx).toBe(
      `var k="${key.slice(0, 6)}${"*".repeat(20)}${key.slice(-4)}";`
    );
    expect(ctx).not.toContain(key);
  });
});

// pub#1959 review fix: a quoted value under 8 characters was never masked while its label was, and a quoted match was read
// with one quote reading only, so an apostrophe in a comment flipped which quotes open and showed the next literal whole.
// Every expected string here is the full context, so any character of the secret showing fails the test.
describe("evidence context masks short quoted values and survives a stray apostrophe (repo#2215)", () => {
  const key = ["sk", "live", "abcdefghijklmnopqrstuvwx12"].join("_"); // assembled so the fixture is not a literal secret
  const masked = `sk_liv${"*".repeat(20)}wx12`;
  const ctxOf = async (content: string) => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    return evidenceContext(content, content.indexOf(key), key.length, key);
  };

  test("a 7-character JSON password after its label is starred out", async () => {
    const pw = ["Zx9!", "qT4"].join("");
    expect(await ctxOf(`{"key":"${key}","password":"${pw}"}`)).toBe(
      `{"***"*"${masked}"*"********"*"*******"}`
    );
  });

  test("a 7-character value after => is starred out", async () => {
    const pw = ["Sum", "mer1"].join("");
    expect(
      await ctxOf(`$cfg = ['stripe' => '${key}', 'db_pass' => '${pw}'];`)
    ).toBe(`$cfg = *'******' => '${masked}', '*******' => '*******'];`);
  });

  test("a 7-character HTML attribute value is starred out", async () => {
    const pw = ["Pw12", "345"].join("");
    expect(
      await ctxOf(
        `<input name="k" value="${pw}"><script>var k="${key}";</script>`
      )
    ).toBe(
      `<input name="*" value="*******"><script>var k="${masked}";</script>`
    );
  });

  test("a 4-character assigned literal is starred out", async () => {
    const pw = ["Pa", "55"].join("");
    expect(await ctxOf(`const k = "${key}"; const pw = "${pw}";`)).toBe(
      `const k = "${masked}"; const pw = "****";`
    );
  });

  test("an apostrophe in a comment after the match does not unmask the next literal", async () => {
    const pw = ["Correct", "Horse", "Battery"].join("");
    expect(
      await ctxOf(`const k = "${key}"; // don't ship this\nconst pw='${pw}';`)
    ).toBe(
      `const k = "${masked}"; // don'${"*".repeat(20)}'${"*".repeat(19)}'*`
    );
  });

  test("an apostrophe in a comment before the match does not unmask the literal before it", async () => {
    const pw = ["Correct", "Horse", "Battery"].join("");
    expect(
      await ctxOf(`const pw='${pw}'; // don't ship\nconst k = "${key}";`)
    ).toBe(
      `${"*".repeat(9)}'${"*".repeat(19)}'********'t ship const k = "${masked}";`
    );
  });

  test("no 3-character run of a generated secret appears in any quoting style (property)", async () => {
    // Deterministic generator: the alphabet avoids lowercase letters, quotes, backslashes, whitespace and `*`, so a run of
    // three secret characters cannot occur in the labels, the match mask or the stars by chance.
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&?~-_.+/;,:=()[]{}<>|";
    let seed = 2215;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const styles: Array<(s: string) => string> = [
      (s) => `{"password":"${s}"}`,
      (s) => `'db_pass' => '${s}'`,
      (s) => `<input value="${s}">`,
      (s) => `const pw = "${s}";`,
      (s) => `pw='${s}';`,
      (s) => `pw=\`${s}\`;`,
      (s) => `login("${s}");`,
      (s) => `// don't ship\npw='${s}';`,
      (s) => `// don't ship\nlogin('${s}');`,
      (s) => `/* it's a list */ ['a', '${s}']`,
    ];
    let checked = 0;
    for (let len = 1; len <= 40; len++) {
      for (let round = 0; round < 3; round++) {
        const secret = Array.from(
          { length: len },
          () => alphabet[next() % alphabet.length]
        ).join("");
        for (const style of styles) {
          for (const content of [
            `var k="${key}"; ${style(secret)}`,
            `${style(secret)} var k="${key}";`,
          ]) {
            const ctx = await ctxOf(content);
            expect(ctx).toBeDefined();
            expect(ctx).toContain(masked);
            for (let i = 0; i + 3 <= len; i++) {
              const frag = secret.slice(i, i + 3);
              if (ctx?.includes(frag))
                throw new Error(
                  `"${frag}" of ${JSON.stringify(secret)} shows in ${JSON.stringify(ctx)}`
                );
            }
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(40 * 3 * styles.length * 2);
  });
});

// pub#1959 review round 2: a literal that is not an operand and holds code punctuation showed in full after a stray quote
// (`|| 'fallback'`, `echo '...'`, `-p'...'`), an unquoted value was cut at the first `;` or `,`, a 1 to 3 character value
// was kept, and a letters-only run after a label with no `=` or `:` was kept. Every expectation is the full context.
describe("evidence context round 2: punctuation literals, unquoted values, short values and bare labels (repo#2215)", () => {
  const key = ["sk", "live", "abcdefghijklmnopqrstuvwx12"].join("_"); // assembled so the fixture is not a literal secret
  const masked = `sk_liv${"*".repeat(20)}wx12`;
  const Q = `"${key}"`;
  const D = "// don't log this\n";
  const ctxOf = async (content: string) => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    return evidenceContext(content, content.indexOf(key), key.length, key);
  };
  const stars = (n: number) => "*".repeat(n);

  test.each([
    [
      "a bundle regex with quotes, then || 'fallback'",
      `var k=${Q};var r=/['"]/g;var v=e.PW||'Hunt&er;x';`,
      `var k="${masked}";var r=**'${stars(17)}'${stars(9)}'*`,
    ],
    [
      "a stray apostrophe, then || 'fallback'",
      `var k=${Q}; ${D}var v = env.PW || 'Hunt&er;x';`,
      `var k="${masked}"; // don'${stars(20)}'${stars(9)}'*`,
    ],
    [
      "a stray apostrophe, then && 'x'",
      `var k=${Q}; ${D}ok && 'Hunt&er;x';`,
      `var k="${masked}"; // don'${stars(17)}'${stars(9)}'*`,
    ],
    [
      "a stray apostrophe, then echo 'x'",
      `var k=${Q}; ${D}echo 'Hunt;er2pass'`,
      `var k="${masked}"; // don'${stars(16)}'${stars(12)}'`,
    ],
    [
      "a stray apostrophe, then mysql -p'x'",
      `var k=${Q}; ${D}cmd = mysql -u root -p'S3cr;tPw' db;`,
      `var k="${masked}"; // don'${stars(20)}'${stars(8)}'****`,
    ],
    [
      "an apostrophe in HTML text, then login 'x'",
      `<a data-k=${Q}>it's</a><code>login 'Pw;9xQ!'</code>`,
      `<a data-k="${masked}****'${stars(17)}'${stars(7)}'*******`,
    ],
    [
      "|| 'fallback', then a stray apostrophe before the match",
      `x = cond || 'Hunt&er;x'; // don't\nvar k=${Q};`,
      `${stars(12)}'${stars(9)}'********'t var k="${masked}";`,
    ],
  ])(
    "a punctuation literal in a non-operand place is starred out: %s",
    async (_name, content, expected) => {
      const ctx = await ctxOf(content);
      expect(ctx).toBe(expected);
      for (const secret of ["Hunt&er;x", "Hunt;er2pass", "S3cr;tPw", "Pw;9xQ!"])
        expect(ctx).not.toContain(secret.slice(-4));
    }
  );

  test.each([
    [
      "DB_PASS=Tr0ub;4dor&x",
      `STRIPE=${Q}\nDB_PASS=Tr0ub;4dor&x`,
      `STRIPE="${masked}" DB_PASS=${stars(12)}`,
    ],
    [
      "PASS=Xy;kq,Lm2",
      `var k=${Q};\nPASS=Xy;kq,Lm2`,
      `var k="${masked}"; PASS=${stars(9)}`,
    ],
    [
      "password: Xy;kq,Lmzz",
      `stripe: ${Q}\npassword: Xy;kq,Lmzz`,
      `stripe: "${masked}" password: ${stars(10)}`,
    ],
  ])(
    "an unquoted value is starred to the next whitespace, punctuation and all: %s",
    async (_name, content, expected) => {
      expect(await ctxOf(content)).toBe(expected);
    }
  );

  test("an unquoted value of 1 to 3 characters is starred out", async () => {
    // Keys that are not secret labels, so the value is starred to the next whitespace (a label stars the whole line).
    expect(await ctxOf(`var k=${Q}; n=482; cvv=91; x:Ab9`)).toBe(
      `var k="${masked}"; n=**** cvv=*** x:***`
    );
  });

  test.each([
    [
      "X-Api-Key abcdEFGHijklMNOP",
      `var k=${Q}; X-Api-Key abcdEFGHijklMNOP`,
      `var k="${masked}"; X-Api-Key ${stars(16)}`,
    ],
    [
      "// password qwertyuiopasdfghjk",
      `var k=${Q}; // password qwertyuiopasdfghjk\n`,
      `var k="${masked}"; // password ${stars(18)} `,
    ],
  ])(
    "a 12+ character run after a secret's label with no = or : is starred out: %s",
    async (_name, content, expected) => {
      expect(await ctxOf(content)).toBe(expected);
    }
  );

  test("prose after a label keeps its words", async () => {
    const content = `var k=${Q}; // the password field is required\n`;
    expect(await ctxOf(content)).toBe(
      `var k="${masked}"; // the password field is required `
    );
  });

  // The reviewer's probes (redact4.ts, redact5.ts) against pub#1959 at 94ca8926 and at this fix, ported case for case:
  // none of the listed fragments may show in the finding's context.
  const PK = ["sk", "live", "Zq8vT3mP9wX2kL7nR4bY6cJ1"].join("_");
  const PQ = `"${PK}"`;
  const probes: Array<[string, string, string[], "inline-script" | "html"]> = [
    [
      "label: 'p;ss!w0rd'",
      `var k=${PQ};\nvar o={password: 'p;ss!w0rd'};`,
      ["p;ss!w0rd", "ss!w0rd"],
      "inline-script",
    ],
    ['"pwd":"a,b;c"', `{"k":${PQ},"pwd":"a,b;c"}`, ["a,b;c"], "inline-script"],
    [
      'pass => "x(y)z"',
      `$c=['k'=>${PQ}, 'pass' => "x(y)z"];`,
      ["x(y)z"],
      "inline-script",
    ],
    [
      "desync label: 'p;ss!w0rd'",
      `var k=${PQ}; ${D}var o={password: 'p;ss!w0rd'};`,
      ["p;ss!w0rd", "ss!w0rd"],
      "inline-script",
    ],
    [
      'desync pass => "x(y)z"',
      `$c=['k'=>${PQ}]; ${D}$d=['pass' => "x(y)z"];`,
      ["x(y)z"],
      "inline-script",
    ],
    [
      "desync sshpass -p 'Pa;ss'",
      `var k=${PQ}; ${D}run("sshpass -p 'Pa;ssw'");`,
      ["Pa;ssw"],
      "inline-script",
    ],
    [
      "desync mysql -p'S3cr;t'",
      `var k=${PQ}; ${D}cmd = mysql -u root -p'S3cr;tPw' db;`,
      ["S3cr;tPw", "S3cr"],
      "inline-script",
    ],
    [
      "desync || 'a&b;c'",
      `var k=${PQ}; ${D}var pw = env.PW || 'Hunt&er;x';`,
      ["Hunt&er;x"],
      "inline-script",
    ],
    [
      "desync && 'x'",
      `var k=${PQ}; ${D}ok && 'Hunt&er;x';`,
      ["Hunt&er;x"],
      "inline-script",
    ],
    [
      "desync echo 'a;b'",
      `var k=${PQ}; ${D}echo 'Hunt;er2pass'`,
      ["Hunt;er2pass", "er2pass"],
      "inline-script",
    ],
    [
      "desync html text",
      `<a data-k=${PQ}>it's</a><code>login 'Pw;9xQ!'</code>`,
      ["Pw;9xQ!"],
      "html",
    ],
    [
      "template with apostrophe",
      "var k=`" + PK + "`; var m=`Don't share ${user}: p;ss!w0rd`;",
      ["p;ss!w0rd"],
      "inline-script",
    ],
    [
      "template nested quote",
      "var k=" + PQ + "; var m=`pw=${'Zx9;q'}`;",
      ["Zx9;q"],
      "inline-script",
    ],
    [
      "backtick after desync",
      `var k=${PQ}; ${D}x = run \`Hu;nter\`;`,
      ["Hu;nter"],
      "inline-script",
    ],
    [
      "multiline json",
      `{\n  "stripe": ${PQ},\n  "db": {\n    "user": "admin",\n    "pass": "a;b,c"\n  }\n}`,
      ["a;b,c"],
      "inline-script",
    ],
    [
      "multiline json apostrophe value",
      `{\n  "stripe": ${PQ},\n  "note": "it's",\n  "pass": "Hu;nt,er"\n}`,
      ["Hu;nt,er"],
      "inline-script",
    ],
    [
      "escaped quote in secret",
      `var k=${PQ}; var pw="ab\\"c;d";`,
      ["c;d", 'ab\\"c'],
      "inline-script",
    ],
    [
      "escaped apostrophe in secret",
      `var k=${PQ}; var pw='it\\'s;pw';`,
      ["s;pw"],
      "inline-script",
    ],
    [
      "json in string",
      `var k=${PQ}; var cfg="{\\"pass\\":\\"Zx;9q\\"}";`,
      ["Zx;9q"],
      "inline-script",
    ],
    [
      "url with apostrophe then pw",
      `var k=${PQ}; var u="https://ex.com/o'brien"; login('Hu;nt');`,
      ["Hu;nt"],
      "inline-script",
    ],
    [
      "far side of url, label",
      `var k=${PQ}; fetch("https://api.example.com/v1/it's"); pw = 'a;b';`,
      ["a;b"],
      "inline-script",
    ],
    [
      "comment then unquoted",
      `var k=${PQ}; // don't\n PASS = Xy7;kq,Lm2`,
      ["Xy7;kq,Lm2", "kq,Lm2", "Lm2"],
      "inline-script",
    ],
    [
      "unquoted yaml-ish",
      `stripe: ${PK}\npassword: Xy;kq,Lmzz`,
      ["Xy;kq,Lmzz", "kq,Lmzz", "Lmzz"],
      "inline-script",
    ],
    [
      "unquoted env ;",
      `STRIPE=${PK}\nDB_PASS=Tr0ub;4dor&x`,
      ["4dor&x", "Tr0ub;4dor"],
      "inline-script",
    ],
    [
      "unquoted after =>",
      `$c = [k => ${PK}, pass => hunterpass];`,
      ["hunterpass"],
      "inline-script",
    ],
    [
      "label space no digit",
      `var k=${PQ}; X-Api-Key abcdEFGHijklMNOP`,
      ["abcdEFGHijklMNOP"],
      "inline-script",
    ],
    [
      "quoted match, unquoted ; value",
      `var k=${PQ};\nPASS=Xy7;kq,Lm2`,
      ["Xy7;kq,Lm2", "kq,Lm2", "Lm2", "Xy7"],
      "inline-script",
    ],
    [
      "quoted match, yaml ; value",
      `stripe: ${PQ}\npassword: Xy;kq,Lmzz`,
      ["kq,Lmzz", "Lmzz"],
      "inline-script",
    ],
    [
      "quoted match, env ; value 5+",
      `STRIPE="${PK}"\nDB_PASS=Tr0ub;4dor&x`,
      ["4dor&x"],
      "inline-script",
    ],
    [
      "in sync || fallback",
      `var k=${PQ}; var pw = env.PW || 'Hunt&er;x';`,
      ["Hunt&er;x"],
      "inline-script",
    ],
    [
      "bundle regex quote then ||",
      `var k=${PQ};var r=/['"]/g;var pw=e.PW||'Hunt&er;x';`,
      ["Hunt&er;x"],
      "inline-script",
    ],
    [
      "1-3 char unquoted",
      `var k=${PQ}; pin=482; pw:Ab9`,
      ["482", "Ab9"],
      "inline-script",
    ],
    ["4 char unquoted", `var k=${PQ}; pin=4821`, ["4821"], "inline-script"],
    [
      "backward desync",
      `x = cond || 'Hunt&er;x'; // don't\nvar k=${PQ};`,
      ["Hunt&er;x"],
      "inline-script",
    ],
  ];
  test.each(probes)(
    "reviewer probe: %s",
    async (_name, content, secrets, loc) => {
      const { scanContent } = await import("../src/security/leaked-secrets");
      const found = scanContent(content, loc, "https://example.com/a.js");
      const f = found.find((x) => /Stripe/.test(x.type));
      expect(f?.context).toBeDefined();
      expect(f?.context).toContain(
        `${PK.slice(0, 6)}${stars(20)}${PK.slice(-4)}`
      );
      expect(secrets.filter((s) => f?.context?.includes(s))).toEqual([]);
    }
  );

  // Non-operand placements, punctuation-bearing secrets, and a stray apostrophe between the secret and the match on the
  // before side. A secret of 3 or more characters must show no 3-character run; a 1 or 2 character secret is checked
  // exactly: the context must equal the one where the secret's characters are stars.
  test("no part of a generated secret shows in a non-operand place, after or between a stray apostrophe (property)", async () => {
    // Lowercase letters and spaces are in (round 3: an alphabet without them hid the multi-word leak after a label).
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&?~-_.+/;,:=()[]{}<>|    ";
    let seed = 1959;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    // The second field is false for the placements whose literal is not an operand: a secret there with both whitespace
    // and code punctuation is the documented Known limit (a), so its spaces become `_`.
    const placements: Array<[(s: string) => string, boolean]> = [
      [(s) => `x = env.PW || '${s}';`, true],
      [(s) => `ok && '${s}';`, true],
      [(s) => `echo '${s}'`, false],
      [(s) => `mysql -u root -p'${s}' db`, false],
      [(s) => `sshpass -p '${s}' ssh host`, false],
      [(s) => `PASS=${s}\n`, true],
      [(s) => `password: ${s}\n`, true],
    ];
    let checked = 0;
    for (let len = 1; len <= 30; len++) {
      for (let round = 0; round < 3; round++) {
        // Every secret carries one of `; , ( ) & |`, so the code-punctuation path is always taken.
        const punct = ";,()&|"[next() % 6] as string;
        const chars = Array.from(
          { length: len },
          () => alphabet[next() % alphabet.length] as string
        );
        chars[next() % len] = punct;
        // Starts and ends visible, so an unquoted value is not trimmed by the operator's own whitespace.
        if (chars[0] === " ") chars[0] = "a";
        if (chars[len - 1] === " ") chars[len - 1] = "z";
        const spaced = chars.join("");
        for (const [place, spacesAllowed] of placements) {
          const secret = spacesAllowed ? spaced : spaced.replaceAll(" ", "_");
          const variants = (s: string) => [
            `var k="${key}"; ${place(s)}`,
            `var k="${key}"; // don't ship\n${place(s)}`,
            `${place(s)} var k="${key}";`,
            `${place(s)} // don't ship\nvar k="${key}";`,
          ];
          const real = variants(secret);
          const starred = variants(stars(len));
          for (let v = 0; v < real.length; v++) {
            const ctx = await ctxOf(real[v] as string);
            expect(ctx).toContain(masked);
            const starredCtx = await ctxOf(starred[v] as string);
            if (len <= 2) {
              // Every character shown is one the all-stars context shows too; code punctuation next to the literal may be
              // starred on top (the stated "punctuation between two literals" behaviour), nothing more.
              expect(ctx?.length).toBe(starredCtx?.length);
              const extra = [...(ctx ?? "")].filter(
                (ch, i) => ch !== "*" && ch !== starredCtx?.[i]
              );
              expect(extra).toEqual([]);
            } else {
              for (let i = 0; i + 3 <= len; i++) {
                const frag = secret.slice(i, i + 3);
                // A run the surrounding code also holds (`var`, ` sh`) shows whatever the secret is: not a leak.
                if (ctx?.includes(frag) && !starredCtx?.includes(frag))
                  throw new Error(
                    `"${frag}" of ${JSON.stringify(secret)} shows in ${JSON.stringify(ctx)}`
                  );
              }
            }
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(30 * 3 * 7 * 4);
  });
});

// pub#1959 review round 3: an unquoted value with spaces after a labelled key showed every word after its first
// (`password: correct horse battery staple`), and `passcode`, `API key`, `apikey` and `pin` were not labels. A labelled key's
// unquoted value is now starred to the end of its line, read before the line ends are collapsed. Full-context expectations.
describe("evidence context round 3: labelled values to the end of the line and more labels (repo#2215)", () => {
  const key = ["sk", "live", "abcdefghijklmnopqrstuvwx12"].join("_"); // assembled so the fixture is not a literal secret
  const masked = `sk_liv${"*".repeat(20)}wx12`;
  const Q = `"${key}"`;
  const stars = (n: number) => "*".repeat(n);
  const ctxOf = async (content: string) => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    return evidenceContext(content, content.indexOf(key), key.length, key);
  };

  test.each([
    [
      "yaml password: with spaces",
      `stripe: ${Q}\npassword: correct horse battery staple`,
      `stripe: "${masked}" password: ${stars(20)}`,
    ],
    [
      "dotenv DB_PASSWORD= with spaces",
      `STRIPE_KEY=${Q}\nDB_PASSWORD=correct horse battery staple`,
      `STRIPE_KEY="${masked}" DB_PASSWORD=${stars(20)}`,
    ],
    [
      "ini password = with ; and spaces",
      `stripe = ${Q}\npassword = Hunt;er ab;cd`,
      `stripe = "${masked}" password = ${stars(13)}`,
    ],
    [
      "camelCase key",
      `var k=${Q};\nconfig.dbPassword = correct horse`,
      `var k="${masked}"; config.dbPassword = ${stars(13)}`,
    ],
    [
      "acronym then camelCase key",
      `var k=${Q};\nDBPassword: correct horse`,
      `var k="${masked}"; DBPassword: ${stars(13)}`,
    ],
    [
      "header-style key",
      `var k=${Q};\nX-Api-Key: abcd efgh ijkl`,
      `var k="${masked}"; X-Api-Key: ${stars(14)}`,
    ],
  ])(
    "a labelled key's unquoted value is starred to the end of its line: %s",
    async (_name, content, expected) => {
      expect(await ctxOf(content)).toBe(expected);
    }
  );

  test.each([
    [
      "passcode",
      `var k=${Q}; passcode qwertyuiopasdfgh`,
      `var k="${masked}"; passcode ${stars(16)}`,
    ],
    [
      "API key",
      `var k=${Q}; API key qwertyuiopasdfgh`,
      `var k="${masked}"; API key ${stars(16)}`,
    ],
    [
      "apikey",
      `var k=${Q}; apikey qwertyuiopasdfgh`,
      `var k="${masked}"; apikey ${stars(16)}`,
    ],
    [
      "pin",
      `var k=${Q}; pin qwertyuiopasdfgh`,
      `var k="${masked}"; pin ${stars(16)}`,
    ],
  ])(
    "a 12+ character run after the new label is starred out: %s",
    async (_name, content, expected) => {
      expect(await ctxOf(content)).toBe(expected);
    }
  );

  test("pin is a whole-word label: spinner, pinned and pinterest keep their words", async () => {
    const content = `var k=${Q}; // spinner pinned pinterest qwertyuiopasdfgh\n`;
    expect(await ctxOf(content)).toBe(
      `var k="${masked}"; // spinner pinned pinterest qwertyuiopasdfgh `
    );
  });

  test.each([
    [
      "yaml, label line after the match",
      `stripe: ${Q}\npassword: correct horse battery staple\nport: 5432`,
      `stripe: "${masked}" password: ${stars(20)} port: ****`,
    ],
    [
      "yaml, label line before the match",
      `password: correct horse battery staple\nport: 5432\nstripe: ${Q}`,
      `password: ${stars(20)} port: **** stripe: "${masked}"`,
    ],
    [
      "dotenv, label line after the match",
      `STRIPE_KEY=${Q}\nDB_PASSWORD=correct horse battery staple\nDEBUG=true\n`,
      `STRIPE_KEY="${masked}" DB_PASSWORD=${stars(20)} DEBUG=**** `,
    ],
    [
      "dotenv, label line before the match",
      `DB_PASSWORD=correct horse battery staple\r\nDEBUG=true\r\nSTRIPE_KEY=${Q}`,
      `DB_PASSWORD=${stars(20)} DEBUG=**** STRIPE_KEY="${masked}"`,
    ],
  ])(
    "multi-line config: the label line is starred to its end and the next key stays: %s",
    async (_name, content, expected) => {
      expect(await ctxOf(content)).toBe(expected);
    }
  );

  test("a key that is not a label keeps today's behaviour: its value is starred to the next whitespace only", async () => {
    expect(await ctxOf(`stripe: ${Q}\ntitle: The Nut Shop\nport: 5432`)).toBe(
      `stripe: "${masked}" title: *** Nut Shop port: ****`
    );
  });

  // Unquoted values after a labelled key, with lowercase letters and spaces in the secret (the round 2 alphabet had neither,
  // which hid the multi-word leak). The context must equal the one where the secret's characters are stars, so no
  // character of it, in any length, shows.
  test("no character of a generated multi-word value after a labelled key shows (property)", async () => {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&?~-_.+/;,:=()[]{}<>|      ";
    let seed = 3215;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const placements: Array<(s: string) => string> = [
      (s) => `password: ${s}\nport: 5432\n`,
      (s) => `DB_PASSWORD=${s}\nDEBUG=true\n`,
      (s) => `password = ${s}\n`,
      (s) => `api_key: ${s}\n`,
      (s) => `pin=${s}\r\n`,
    ];
    let checked = 0;
    for (let len = 1; len <= 30; len++) {
      for (let round = 0; round < 3; round++) {
        const chars = Array.from(
          { length: len },
          () => alphabet[next() % alphabet.length] as string
        );
        // A value starts and ends with a visible character, and holds a space whenever it has room for one. It does not start
        // with `>`, which `KEY=>` reads as the `=>` operator.
        if (chars[0] === " " || chars[0] === ">") chars[0] = "a";
        if (chars[len - 1] === " ") chars[len - 1] = "z";
        if (len >= 3) chars[1 + (next() % (len - 2))] = " ";
        const secret = chars.join("");
        for (const place of placements) {
          const variants = (s: string) => [
            `var k="${key}";\n${place(s)}`,
            `var k="${key}"; // don't ship\n${place(s)}`,
            `${place(s)}var k="${key}";`,
            `${place(s)}// don't ship\nvar k="${key}";`,
          ];
          const real = variants(secret);
          const starred = variants(stars(len));
          for (let v = 0; v < real.length; v++) {
            const ctx = await ctxOf(real[v] as string);
            expect(ctx).toContain(masked);
            expect(ctx).toBe(await ctxOf(starred[v] as string));
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(30 * 3 * 5 * 4);
  });

  // The reviewer's round 3 probes against pub#1959 at 96b78dfc (redact6.ts, context-quality.ts, timing.ts), ported.
  const PK = ["sk", "live", "Zq8vT3mP9wX2kL7nR4bY6cJ1"].join("_");
  const PQ = `"${PK}"`;
  const PM = `${PK.slice(0, 6)}${stars(20)}${PK.slice(-4)}`;
  const D = "// don't log this\n";
  const findingOf = async (
    content: string,
    loc: "inline-script" | "html" = "inline-script"
  ) => {
    const { scanContent } = await import("../src/security/leaked-secrets");
    const found = scanContent(content, loc, "https://example.com/a.js");
    return found.find((x) => /Stripe/.test(x.type)) ?? found[0];
  };
  test.each([
    [
      "sshpass -p after a stray apostrophe",
      `var k=${PQ}; ${D}run("sshpass -p 'my pass;word' ssh host")`,
      ["pass;word", "my pass"],
    ],
    [
      '|| "pass phrase!" desync',
      `var k=${PQ}; ${D}var pw = env.PW || "pass phrase!";`,
      ["pass phrase", "phrase!"],
    ],
    [
      "|| 'correct horse;battery' desync",
      `var k=${PQ}; ${D}var pw = env.PW || 'correct horse;battery';`,
      ["horse;battery", "correct horse"],
    ],
    [
      "&& passphrase desync",
      `var k=${PQ}; ${D}ok && 'correct horse;battery'`,
      ["horse;battery"],
    ],
    [
      "?? passphrase desync",
      `var k=${PQ}; ${D}pw = a ?? 'correct horse;battery'`,
      ["horse;battery"],
    ],
    [
      "regex desync then || passphrase",
      `var k=${PQ};var r=/['"]/g;var p=e.PW||'correct horse;battery';`,
      ["horse;battery"],
    ],
    [
      "backward || passphrase desync",
      `var p = e.PW || 'correct horse;battery'; // don't\nvar k=${PQ};`,
      ["horse;battery"],
    ],
    [
      "label not listed: passcode",
      `var k=${PQ}; passcode qwertyuiopasdfgh`,
      ["qwertyuiopasdfgh"],
    ],
    [
      "label with space: API key",
      `var k=${PQ}; API key qwertyuiopasdfgh`,
      ["qwertyuiopasdfgh"],
    ],
    ["label 'pin'", `var k=${PQ}; pin qwertyuiopasdfgh`, ["qwertyuiopasdfgh"]],
    [
      "yaml passphrase",
      `stripe: ${PQ}\npassword: correct horse battery staple`,
      ["horse battery staple", "battery staple"],
    ],
    [
      "env passphrase",
      `STRIPE_KEY=${PQ}\nDB_PASSWORD=correct horse battery staple`,
      ["horse battery", "battery staple"],
    ],
    ["ini spaced =", `stripe = ${PQ}\npassword = Hunt;er ab;cd`, ["ab;cd"]],
    [
      "unquoted with quote inside",
      `var k=${PQ};\nDB_PASS=ab"cd;ef gh`,
      ["cd;ef"],
    ],
    ["=> unquoted", `$c=[k=>${PQ}, pass=>Tr0ub;4dor&x];`, ["Tr0ub", "4dor"]],
    ["url guard pw://", `var k=${PQ}; pw://Hunt;er2`, ["Hunt;er2", "er2"]],
    [
      "host:port no guard needed",
      `var k=${PQ}; db=pg.example.com:5432 user=admin`,
      [],
    ],
  ])("reviewer probe round 3: %s", async (_name, content, secrets) => {
    const f = await findingOf(content);
    expect(f?.context).toContain(PM);
    expect(secrets.filter((s) => f?.context?.includes(s))).toEqual([]);
  });

  // The Known limits the changelog states, pinned so the stated limits keep matching real output: (a) after a stray quote, a
  // literal with whitespace and code punctuation that is not an operand; (b) a letters-only word under 12 characters after a
  // label with no `=` or `:`. If one of these starts starring its value, update the changelog and docs with it.
  test.each([
    [
      "limit a: echo 'a b;c'",
      `var k=${PQ}; ${D}echo 'correct horse;battery'`,
      "horse;battery",
    ],
    [
      "limit a: mysql -p'a b;c'",
      `var k=${PQ}; ${D}cmd = mysql -p'correct horse;battery' db;`,
      "horse;battery",
    ],
    [
      "limit b: password hunterabc",
      `var k=${PQ}; password hunterabc`,
      "hunterabc",
    ],
    [
      "limit b: secret Qwertyuiopa",
      `var k=${PQ}; secret Qwertyuiopa`,
      "Qwertyuiopa",
    ],
  ])(
    "documented known limit still holds as stated: %s",
    async (_name, content, shown) => {
      const f = await findingOf(content);
      expect(f?.context).toContain(PM);
      expect(f?.context).toContain(shown);
    }
  );

  test.each([
    [
      "stripe init",
      `import Stripe from "stripe";\nconst stripe = new Stripe("${PK}", { apiVersion: "2023-10-16" });\nexport default stripe;`,
      "inline-script",
      `${stars(19)}"******"; const stripe = *** Stripe("${PM}", { apiVersion: "**********" }); export default stripe;`,
    ],
    [
      "config object",
      `window.__CONFIG__ = { env: "production", stripeSecret: "${PK}", sentryDsn: null, debug: false };`,
      "inline-script",
      `window.__CONFIG__ = * env: "**********", stripeSecret: "${PM}", sentryDsn: ***** debug: ***** };`,
    ],
    [
      "html attr",
      `<div id="checkout" data-stripe-key="${PK}" class="btn primary">Pay now</div>`,
      "html",
      `<div id="********" data-stripe-key="${PM}" class="***********">Pay now</div>`,
    ],
  ] as const)(
    "reviewer context-quality sample stays readable: %s",
    async (_name, content, loc, expected) => {
      expect((await findingOf(content, loc))?.context).toBe(expected);
    }
  );

  // Two samples the open-literal rule (NEARBY_OPEN_LITERAL_MIN) stars on the before side, since the match is not quoted:
  // the key is masked and nothing of the code around it is shown (unchanged from 96b78dfc).
  test.each([
    [
      "minified",
      `function n(e){return fetch("/api/pay",{method:"POST",headers:{Authorization:"Bearer ${PK}","Content-Type":"application/json"},body:JSON.stringify(e)})}`,
      `${stars(20)}${PM}${stars(20)}`,
    ],
    [
      "unquoted env",
      `NODE_ENV=production\nSTRIPE_SECRET_KEY=${PK}\nPORT=3000`,
      `${stars(20)}${PM}${stars(10)}`,
    ],
  ])(
    "reviewer context-quality sample, starred around the match: %s",
    async (_name, content, expected) => {
      expect((await findingOf(content))?.context).toBe(expected);
    }
  );

  test("a 1 MB quote-dense line with 40 keys scans with context well within budget (timing probe)", async () => {
    const { scanContent } = await import("../src/security/leaked-secrets");
    const alnum =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let seed = 7;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const mk = () =>
      [
        "sk",
        "live",
        Array.from({ length: 24 }, () => alnum[rnd(62)]).join(""),
      ].join("_");
    const chunk = `a="x'y\\"z";b='p"q\\'r';c=\`t'u"v\`;d=/['"]/g;e=f||'g;h';`;
    let s = "";
    let keys = 0;
    while (s.length < 1_000_000) {
      s += chunk.repeat(40);
      if (keys < 40) {
        s += `k${keys}="${mk()}";`;
        keys++;
      }
    }
    const t0 = performance.now();
    const found = scanContent(
      s,
      "external-script",
      "https://example.com/bundle.js"
    );
    const ms = performance.now() - t0;
    expect(found.length).toBe(40);
    expect(found.filter((f) => f.context).length).toBe(40);
    // Measured at about 14 ms; the bound leaves room for a slow CI runner.
    expect(ms).toBeLessThan(1000);
  });
});

// pub#1959 review round 4: a labelled value on the match's own line, before the match, showed its later words
// (`password: correct horse battery; key="…"`), and YAML block, folded and continued values, XML element text, `PASSWORD2=`,
// `db_pass_1:` and quoted keys (`"password":`) were missed. Labelled values are now read on both sides of the match, from a
// little before the window, onto deeper-indented lines and inside elements named by a label. Full-context expectations.
describe("evidence context round 4: same-line labels, YAML blocks, XML text and key variants (repo#2215)", () => {
  const key = ["sk", "live", "abcdefghijklmnopqrstuvwx12"].join("_"); // assembled so the fixture is not a literal secret
  const masked = `sk_liv${"*".repeat(20)}wx12`;
  const Q = `"${key}"`;
  const stars = (n: number) => "*".repeat(n);
  const ctxOf = async (content: string) => {
    const { evidenceContext } = await import("../src/security/leaked-secrets");
    return evidenceContext(content, content.indexOf(key), key.length, key);
  };

  test.each([
    [
      "yaml, `;` after the value",
      `password: correct horse battery; key=${Q}`,
      `password: ${stars(20)}"${masked}"`,
    ],
    [
      "dotenv, one line",
      `PASSWORD=correct horse battery STRIPE=${Q}`,
      `PASSWORD=${stars(20)}"${masked}"`,
    ],
    [
      "minified HTML",
      `<p>Password: correct horse battery</p><code data-k=${Q}></code>`,
      `<p>Password: ${stars(20)}"${masked}"${stars(8)}`,
    ],
  ])(
    "a labelled value on the match's own line, before the match, is starred up to it: %s",
    async (_name, content, expected) => {
      expect(await ctxOf(content)).toBe(expected);
    }
  );

  test.each([
    [
      "block scalar |",
      `stripe: ${Q}\npassword: |\n  correct horse battery\n  staple\nport: 5432`,
      `stripe: "${masked}" password: * ${stars(20)} ${stars(6)} port: ****`,
    ],
    [
      "folded scalar > with a blank line",
      `stripe: ${Q}\npassword: >\n  correct horse\n\n  battery staple\nport: 5432`,
      `stripe: "${masked}" password: * ${stars(13)} ${stars(14)} port: ****`,
    ],
    [
      "continued plain scalar, before the match",
      `password: correct horse\n  battery staple\nstripe: ${Q}`,
      `password: ${stars(13)} ${stars(14)} stripe: "${masked}"`,
    ],
    [
      "nested key, value spans lines",
      `db:\n  password: correct horse\n    battery staple\n  key: ${Q}`,
      `db: ${stars(9)} ${stars(13)} ${stars(14)} key: "${masked}"`,
    ],
  ])(
    "YAML: lines indented deeper than a labelled key are starred, the next key keeps its name: %s",
    async (_name, content, expected) => {
      expect(await ctxOf(content)).toBe(expected);
    }
  );

  test("a labelled key above the window still stars its value inside it", async () => {
    const ctx = await ctxOf(
      `password: ${"word ".repeat(30)}correct horse battery\nstripe: ${Q}`
    );
    expect(ctx).toBe(`${stars(20)} stripe: "${masked}"`);
    const block = await ctxOf(
      `db:\n  password: |\n${"    line of text\n".repeat(12)}    correct horse battery\n  key: ${Q}`
    );
    expect(block).not.toContain("horse");
    expect(block).not.toContain("line of");
    expect(block).toContain(`key: "${masked}"`);
  });

  test.each([
    [
      "12+ letters",
      `var k=${Q};\n<password>correcthorsebattery</password>`,
      `var k="${masked}"; <password>${stars(19)}</password>`,
    ],
    [
      "under 12 letters",
      `var k=${Q};\n<password>hunterabc</password>`,
      `var k="${masked}"; <password>${stars(9)}</password>`,
    ],
    [
      "passphrase",
      `var k=${Q};\n<password>correct horse battery</password>`,
      `var k="${masked}"; <password>${stars(20)}</password>`,
    ],
    [
      "an element that is not a label keeps its text",
      `var k=${Q};\n<title>The Nut Shop</title>`,
      `var k="${masked}"; <title>The Nut Shop</title>`,
    ],
  ])(
    "XML: the text of an element named by a label is starred: %s",
    async (_name, content, expected) => {
      expect(await ctxOf(content)).toBe(expected);
    }
  );

  test.each([
    [
      "digit suffix PASSWORD2",
      `STRIPE=${Q}\nPASSWORD2=correct horse battery staple`,
      `STRIPE="${masked}" ${stars(20)}`,
    ],
    [
      "digit segment db_pass_1",
      `STRIPE=${Q}\ndb_pass_1: correct horse battery`,
      `STRIPE="${masked}" ${stars(10)} ${stars(20)}`,
    ],
    [
      "quoted yaml key",
      `stripe: ${Q}\n"password": correct horse battery staple`,
      `stripe: "${masked}" "********": ${stars(20)}`,
    ],
    [
      "passwordless holds password: starred",
      `STRIPE=${Q}\npasswordless: correct horse battery\n`,
      `STRIPE="${masked}" passwordless: ${stars(20)} `,
    ],
  ])("key variants are labels: %s", async (_name, content, expected) => {
    expect(await ctxOf(content)).toBe(expected);
  });

  test.each([
    [
      "password_hint",
      `STRIPE=${Q}\npassword_hint: name of my first pet\n`,
      `STRIPE="${masked}" password_hint: **** of my first pet `,
    ],
    [
      "spinner",
      `var k=${Q};\nspinner: very slow wheel`,
      `var k="${masked}"; spinner: **** slow wheel`,
    ],
    [
      "token_url",
      `var k=${Q};\ntoken_url: see the docs page`,
      `var k="${masked}"; token_url: *** the docs page`,
    ],
  ])(
    "a key that names something about a secret keeps its later words: %s",
    async (_name, content, expected) => {
      expect(await ctxOf(content)).toBe(expected);
    }
  );

  test("a single-quoted key is a label", async () => {
    const ctx = await ctxOf(`STRIPE=${Q}\n'api_key' = correct horse battery`);
    expect(ctx).toContain(masked);
    expect(ctx).not.toContain("horse");
    expect(ctx).not.toContain("battery");
  });

  // The round 3 property put the labelled value on its own line; this one puts it on the match's line, before the match, and
  // on a deeper-indented line under a block key. The context must equal the one where the secret's characters are stars.
  test("no character of a generated value on the match's line or in a YAML block shows (property)", async () => {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&?~-_.+/;,:=()[]{}|      ";
    let seed = 4219;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const placements: Array<(s: string) => string> = [
      (s) => `password: ${s}; key="${key}";\nport: 5432\n`,
      (s) => `DB_PASSWORD=${s} STRIPE="${key}"\n`,
      (s) => `<p>Password: ${s}</p><code data-k="${key}"></code>`,
      (s) => `api_key = ${s}, k = "${key}"`,
      (s) => `password: |\n  ${s}\nstripe: "${key}"\n`,
      (s) => `stripe: "${key}"\ndb:\n  password: >\n    ${s}\n  port: 5432\n`,
    ];
    let checked = 0;
    for (let len = 1; len <= 30; len++) {
      for (let round = 0; round < 3; round++) {
        const chars = Array.from(
          { length: len },
          () => alphabet[next() % alphabet.length] as string
        );
        if (chars[0] === " " || chars[0] === ">" || chars[0] === "=")
          chars[0] = "a";
        if (chars[len - 1] === " ") chars[len - 1] = "z";
        if (len >= 3) chars[1 + (next() % (len - 2))] = " ";
        const secret = chars.join("");
        for (const place of placements) {
          const variants = (s: string) => [
            place(s),
            `// don't ship\n${place(s)}`,
            `${place(s)}\n// don't ship`,
          ];
          const real = variants(secret);
          const starred = variants(stars(len));
          for (let v = 0; v < real.length; v++) {
            const ctx = await ctxOf(real[v] as string);
            expect(ctx).toContain(masked);
            expect(ctx).toBe(await ctxOf(starred[v] as string));
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(30 * 3 * 6 * 3);
  });

  // The reviewer's round 4 probes against pub#1959 at a8341e92 (redact7.ts, redact8.ts), ported: no case leaks.
  const PK = ["sk", "live", "Zq8vT3mP9wX2kL7nR4bY6cJ1"].join("_");
  const PQ = `"${PK}"`;
  const PM = `${PK.slice(0, 6)}${stars(20)}${PK.slice(-4)}`;
  const findingOf = async (
    content: string,
    loc: "inline-script" | "html" = "inline-script"
  ) => {
    const { scanContent } = await import("../src/security/leaked-secrets");
    const found = scanContent(content, loc, "https://example.com/a.js");
    return found.find((x) => /Stripe/.test(x.type)) ?? found[0];
  };
  test.each([
    [
      "yaml block |",
      `stripe: ${PQ}\npassword: |\n  correct horse battery\n  staple\nport: 5432`,
      ["horse battery", "correct horse", "staple"],
    ],
    [
      "yaml folded >",
      `stripe: ${PQ}\npassword: >\n  correct horse\n  battery staple\n`,
      ["correct horse", "battery staple"],
    ],
    [
      "yaml plain multi-line",
      `password: correct horse\n  battery staple\nstripe: ${PQ}`,
      ["battery staple", "correct horse"],
    ],
    [
      "label above match, value spans lines",
      `db:\n  password: correct horse\n    battery staple\n  key: ${PQ}`,
      ["battery staple", "horse"],
    ],
    [
      "quoted then unquoted",
      `stripe: ${PQ}\npassword: "abc def" ghi jkl`,
      ["ghi jkl"],
    ],
    [
      "PASSWORD quoted with spaces + unquoted",
      `STRIPE=${PQ}\nPASSWORD = "quoted with spaces"\nSECRET = correct horse battery`,
      ["quoted with", "horse battery"],
    ],
    [
      "CRLF",
      `STRIPE=${PQ}\r\nDB_PASSWORD=correct horse battery staple\r\nPORT=5432`,
      ["horse battery", "battery staple"],
    ],
    [
      "CR only",
      `STRIPE=${PQ}\rDB_PASSWORD=correct horse battery staple\rPORT=5432`,
      ["horse battery"],
    ],
    [
      "password_hint (over-star?)",
      `STRIPE=${PQ}\npassword_hint: name of my first pet\n`,
      [],
    ],
    [
      "passwordless",
      `STRIPE=${PQ}\npasswordless: correct horse battery\n`,
      ["horse battery"],
    ],
    ["PIN=1234", `var k=${PQ};\nPIN=1234`, ["1234"]],
    ["user.pin = 9876", `var k=${PQ};\nuser.pin = 9876 ok`, ["9876"]],
    ["spinner key not label", `var k=${PQ};\nspinner: very slow wheel`, []],
    [
      "password2 key",
      `STRIPE=${PQ}\nPASSWORD2=correct horse battery staple`,
      ["horse battery"],
    ],
    [
      "db_pass_1 key",
      `STRIPE=${PQ}\ndb_pass_1: correct horse battery`,
      ["horse battery"],
    ],
    [
      "quoted key yaml",
      `stripe: ${PQ}\n"password": correct horse battery staple`,
      ["horse battery"],
    ],
    [
      "same line before match",
      `password: correct horse battery; key=${PQ}`,
      ["horse battery"],
    ],
    [
      "same line before match html",
      `<p>Password: correct horse battery</p><code data-k=${PQ}></code>`,
      ["horse battery"],
      "html",
    ],
    [
      "xml element 12+ letters",
      `<key>${PK}</key><password>correcthorsebattery</password>`,
      ["correcthorsebattery"],
    ],
    [
      "xml element passphrase",
      `<key>${PK}</key>\n<password>correct horse battery</password>`,
      ["horse battery"],
    ],
    [
      "minified a.token=e trade-off",
      `var k=${PQ};a.token=e,b.c=function(){return n.user.name},d=1;`,
      [],
    ],
    [
      "redact8: xml 12+ letters, quoted match",
      `var k=${PQ};\n<password>correcthorsebattery</password>`,
      ["correcthorsebattery"],
    ],
    [
      "redact8: xml under 12, quoted match",
      `var k=${PQ};\n<password>hunterabc</password>`,
      ["hunterabc"],
    ],
    [
      "redact8: one-line before match, labelled =",
      `PASSWORD=correct horse battery STRIPE=${PQ}`,
      ["horse battery"],
    ],
  ] as Array<[string, string, string[], ("inline-script" | "html")?]>)(
    "reviewer probe round 4: %s",
    async (_name, content, secrets, loc) => {
      // test.each passes a callback after the row's values when a row has no location, so read it only when it is a string.
      const f = await findingOf(
        content,
        typeof loc === "string" ? loc : "inline-script"
      );
      expect(f?.context).toContain(PM);
      expect(secrets.filter((s) => f?.context?.includes(s))).toEqual([]);
    }
  );

  test("controls stay readable: password_hint and spinner keep their later words", async () => {
    expect(
      (await findingOf(`STRIPE=${PQ}\npassword_hint: name of my first pet\n`))
        ?.context
    ).toContain("of my first pet");
    expect(
      (await findingOf(`var k=${PQ};\nspinner: very slow wheel`))?.context
    ).toContain("slow wheel");
  });
});
