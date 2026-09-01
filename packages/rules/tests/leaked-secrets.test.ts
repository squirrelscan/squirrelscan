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

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import {
  SECRET_CONTEXT_WINDOW_SIZE,
  SECRET_KEY_LOOKBEHIND_SIZE,
} from "@squirrelscan/utils/constants";

import {
  classifyKeyContext,
  leakedSecretsRule,
  lookBehind,
  readKeyLookBack,
  scanContent,
} from "../src/security/leaked-secrets";
import type { RuleContext } from "../src/types";

// A real SHA-256 of a release artifact: 64 hex characters, which is also the
// exact shape of a Together AI key.
const DIGEST = "01e4fbb0227e0f575e245eb0d8a4fc9b1d3a7e6c2f80b41d95ea7cd3f0b62a18"; // pragma: allowlist secret
const DIGEST_2 = "7b2c40e91af38d605c7e1b94a2f6d083e5c19b7a4d0f38e6215ca9b70d4f8e32"; // pragma: allowlist secret
// A second 64-hex value, this one actually assigned to an api_key.
const TOGETHER_KEY = "9f3c1d7ba24e08f65c1b93d0e47af215c806b3e9d24f71a5c0938e6b1df42a70"; // pragma: allowlist secret
const COMMIT = "3f9a1c5d7e2b48061a9c3d5f7e8b2a4c6d0e1f93"; // pragma: allowlist secret

// #150 fixtures. Real standard base64 — 47 bytes each, so 64 characters and
// one `=` of padding, and both carry a `+` and a `/` inside their first 20
// characters, which is where the base64url class used to give up.
const B64_TOKEN = "2MBqfKhL/eXCwg0Zt+RZ2klzNCF0inWnUM3Jb0UiyC1WDP53Cxm5f6UUyrjnQH8="; // pragma: allowlist secret
const B64_TOKEN_2 = "yS9+/xwatK/BZkejOF5vKuKCuzfMdMV55oZv26BLG8DoO6+VamfQB1mP0TbXYOc="; // pragma: allowlist secret
// A real sha384 SRI hash is standard base64 too, `+` and `/` and all.
const SRI_B64 = "oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"; // pragma: allowlist secret
const OAUTH_TOKEN = "Zk8pR3vN6mQ1tX4wL7cH2sB5dF9gJ0aY"; // pragma: allowlist secret

function html(body: string): string {
  return `<!DOCTYPE html><html><head><title>Releases</title></head><body>${body}</body></html>`;
}

function ctx(pageHtml: string, url = "https://squirrelscan.com/releases"): RuleContext {
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

function findings(checks: ReturnType<typeof leakedSecretsRule.run>["checks"]) {
  return checks
    .filter((c) => c.name === "leaked-secrets-high" || c.name === "leaked-secrets-medium")
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
  test("a release page of checksums, an SRI hash and a commit id reports nothing", () => {
    const page = html(`${RELEASE_PAYLOAD}${CHECKSUM_TABLE}${SRI_TAG}${COMMIT_ID}`);
    const { checks } = leakedSecretsRule.run(ctx(page));

    expect(findings(checks)).toEqual([]);
    expect(checks.find((c) => c.name === "leaked-secrets")?.status).toBe("pass");
  });

  test("the same page plus a real Together key reports exactly one finding", () => {
    const leak = `<script>const api_key = "${TOGETHER_KEY}";</script>`; // pragma: allowlist secret
    const page = html(`${RELEASE_PAYLOAD}${CHECKSUM_TABLE}${SRI_TAG}${COMMIT_ID}${leak}`);
    const { checks } = leakedSecretsRule.run(ctx(page));

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
    for (const key of ["cacheKey", "cache_key", "cachekey", "cache", "eTag", "eTagKey"]) {
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
    for (const gap of [1, SECRET_KEY_LOOKBEHIND_SIZE, SECRET_KEY_LOOKBEHIND_SIZE * 4]) {
      const content = `{"vendor":"together","sha256"${" ".repeat(gap)}:"${DIGEST}"}`;
      expect(scanContent(content, "inline-script")).toEqual([]);
    }
    // The same distance under a credential key still reports.
    const leak = `{"vendor":"together","token"${" ".repeat(SECRET_KEY_LOOKBEHIND_SIZE * 4)}:"${TOGETHER_KEY}"}`;
    expect(scanContent(leak, "inline-script").map((f) => f.type)).toEqual([
      "Together AI Key",
    ]);

    // The invariant under all of it: the distance between a key and its value
    // is not evidence. A key that names something which is not a credential
    // reads the same at 200 spaces as it does at none — before this, the same
    // page said "checksum" up close and "unnamed assignment" further away.
    for (const key of ["filename", "description", "sha256"]) {
      for (const gap of [0, 1, SECRET_KEY_LOOKBEHIND_SIZE * 3]) {
        const content = `{"vendor":"together","${key}"${" ".repeat(gap)}:"${DIGEST}"}`;
        expect(scanContent(content, "inline-script")).toEqual([]);
      }
    }
  });

  test("a short key that names something is not a minified member access", () => {
    // A cache-busting query param and a JSON id are short but they do name
    // their value, and it is not a credential.
    const cases = [
      `<a href="/bundle.js?v=${DIGEST}">built together</a>`,
      `<script>x={"id":"${DIGEST}",vendor:"together"}</script>`,
      `<script>x={id:"${DIGEST}",vendor:"together"}</script>`,
      `<script>x={a:"${DIGEST}",vendor:"together"}</script>`,
    ];
    for (const content of cases) {
      expect(scanContent(content, "html")).toEqual([]);
    }
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
      ["GitHub Personal Access Token", `${PREFIX.github}016b3f2c9d4e7a815c0b2d6f39ea47c1b5d8`], // pragma: allowlist secret
      ["Stripe Live Key", `${PREFIX.stripe}51HxQ2mKz9pLvA3nR7dTfJw8Y`], // pragma: allowlist secret
      ["AWS Access Key ID", `${PREFIX.aws}2XJQ7LP4RNVD3KEB`], // pragma: allowlist secret
      ["Slack Token", `${PREFIX.slack}2094857361-3948572610-Kj8dPqR2mTvX5nB7wLcH1sZa`], // pragma: allowlist secret
      ["Private Key (RSA)", "-----BEGIN RSA PRIVATE KEY-----"], // pragma: allowlist secret
    ];

    for (const [type, value] of fixtures) {
      const found = scanContent(`<script>const v = "${value}";</script>`, "html");
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

  test("a minified assignment is still scanned", () => {
    // `t.a = "…"` is what a bundler leaves behind, and it is exactly where a
    // leaked key hides. The brand word is elsewhere in the window.
    const content = `var t={};t.a="${TOGETHER_KEY}";/* together.ai client */`; // pragma: allowlist secret
    const found = scanContent(content, "inline-script");
    expect(found.map((f) => f.value)).toContain(TOGETHER_KEY);
  });

  test("a naming attribute after the value is still read", () => {
    const content = `<meta content="${TOGETHER_KEY}" name="algolia-api-key">`; // pragma: allowlist secret
    const found = scanContent(content, "html");
    // Algolia's 32-hex pattern claims the leading half of the value first, so
    // assert the report, not which pattern's slice of it won.
    expect(found).not.toEqual([]);
    expect(TOGETHER_KEY.startsWith(found[0]?.value ?? "\0")).toBe(true);
  });

  test("a brand word at the far edge of the window still sees the key", () => {
    // The window opens on the value itself and the key sits in the lead-in, so
    // this only reports if the extracted window carries look-back context.
    // No FAST pattern matches `credential=`, so the context tier is on its own.
    const lead = `${"x".repeat(199)};`;
    const assignment = `credential="${TOGETHER_KEY}"`; // pragma: allowlist secret
    const valueStart = lead.length + `credential="`.length;
    const keywordAt = valueStart + SECRET_CONTEXT_WINDOW_SIZE;
    const filler = "x".repeat(keywordAt - (lead.length + assignment.length));
    const content = `${lead}${assignment}${filler}together.ai`;

    const found = scanContent(content, "inline-script");
    expect(found.map((f) => f.value)).toContain(TOGETHER_KEY);
  });

  test("a long key beginning past the look-back budget still reports", () => {
    // End to end version of the look-back test: silent from N+1 before the fix.
    const N = SECRET_KEY_LOOKBEHIND_SIZE;
    for (const distance of [N, N + 1, N + 2]) {
      const key = `key${"Z".padEnd(distance - 2 - "key".length, "z")}`;
      const content = `;${key}="${TOGETHER_KEY}" // together.ai`; // pragma: allowlist secret
      expect(scanContent(content, "inline-script").map((f) => f.value)).toContain(
        TOGETHER_KEY
      );
    }
  });

  test("a value straddling the start of the window is still reported once", () => {
    // The value begins in the lead-in and runs into the scanned region. Cutting
    // matching at the region boundary drops it entirely; scanning the lead-in
    // and requiring the match to reach the region keeps it, exactly once.
    const straddle = 32;
    const key = `credential="`;
    const lead = `${"x".repeat(199)};`;
    const valueStart = lead.length + key.length;
    // Put the brand word so the window opens partway through the value.
    const keywordAt = valueStart + straddle + SECRET_CONTEXT_WINDOW_SIZE;
    const upto = valueStart + TOGETHER_KEY.length + 1;
    const filler = "x".repeat(keywordAt - upto);
    const content = `${lead}${key}${TOGETHER_KEY}"${filler}together.ai`; // pragma: allowlist secret

    const found = scanContent(content, "inline-script");
    expect(found.map((f) => f.value)).toEqual([TOGETHER_KEY]);
  });

  test("a key too long for the look-back cannot invent a digest word", () => {
    // The walk runs out of room part-way through this key, and the fragment it
    // is left holding says `sha256` — a word the whole key never had. Reading
    // the fragment as a key suppresses a real credential, so a cut read is not
    // read at all: #175's direction, applied to the look-back itself.
    // Each separator puts the cut at a different offset inside the key, and a
    // `-`, a `.` or a digit is one the key patterns cannot start a match on.
    for (const separator of ["_", "-", ".", "7"]) {
      const key = `api_key_${"q".repeat(100)}${separator}${"z".repeat(84)}_xsha256`;
      const content = `"${key}"${" ".repeat(100)}:"${TOGETHER_KEY}"; // together.ai`; // pragma: allowlist secret
      expect(scanContent(content, "inline-script").map((f) => f.value)).toEqual([
        TOGETHER_KEY,
      ]);
    }

    // A digest key the walk does reach the start of still suppresses, so the
    // guard buys the silence back only where the evidence was never read.
    const short = `"cache_${"z".repeat(20)}_sha256"${" ".repeat(100)}:"${DIGEST}"; // together.ai`;
    expect(scanContent(short, "inline-script")).toEqual([]);
  });

  test("public-by-design client keys stay informational, not leaks", () => {
    const page = html(
      `<script>const cfg={apiKey:"AIzaSyD3mQ8xR2vT7pLnK4hW9cB1sE6yU0zJfXa"};</script>`, // pragma: allowlist secret
    );
    const { checks } = leakedSecretsRule.run(ctx(page));

    expect(findings(checks)).toEqual([]);
    expect(checks.find((c) => c.name === "leaked-secrets-public")?.status).toBe("info");
  });
});

describe("classifyKeyContext", () => {
  test("names the key in front of a value", () => {
    expect(classifyKeyContext(`{filename:"x",sha256:"`, "together")).toBe("digest");
    expect(classifyKeyContext(`<code>sha256: `, "together")).toBe("digest");
    expect(classifyKeyContext(`integrity="sha384-`, "together")).toBe("digest");
    expect(classifyKeyContext(`"x-api-key": "`, "together")).toBe("credential");
    expect(classifyKeyContext(`api_key = "`, "together")).toBe("credential");
    expect(classifyKeyContext(`Authorization: Bearer `, "together")).toBe("credential");
    expect(classifyKeyContext(`together: "`, "together")).toBe("credential");
    expect(classifyKeyContext(`<td>`, "together")).toBe("none");
    expect(classifyKeyContext(`monkey: "`, "together")).toBe("none");
  });

  test("a digest key wins over a credential word in the same key", () => {
    expect(classifyKeyContext(`sha256Key: "`, "together")).toBe("digest");
  });

  test("parses a bracket access as the preceding key", () => {
    expect(classifyKeyContext(`cfg["apiKey"] = "`, "together")).toBe("credential");
    expect(classifyKeyContext(`cfg['x-api-key'] = "`, "together")).toBe("credential");
    expect(classifyKeyContext(`cfg["together"] = "`, "together")).toBe("credential");
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
    expect(classifyKeyContext(`labels[apiKey]: "`, "together")).toBe("assigned");
    expect(classifyKeyContext(`cfg["apiKey"] || "`, "together")).toBe("credential");
    expect(classifyKeyContext(`process.env["SECRET_KEY"] || "`, "together")).toBe(
      "credential"
    );
  });

  test("a minifier's member access is treated as no key at all", () => {
    expect(classifyKeyContext(`t.a = "`, "together")).toBe("assigned");
    expect(classifyKeyContext(`e.x2="`, "together")).toBe("assigned");
    expect(classifyKeyContext(`n["a"]="`, "together")).toBe("assigned");
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
      expect(classifyKeyContext(lookBehind(text, text.length), "together")).toBe(
        "credential"
      );
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

    for (const gap of [1, SECRET_KEY_LOOKBEHIND_SIZE, SECRET_KEY_LOOKBEHIND_SIZE * 4]) {
      const space = " ".repeat(gap);
      expect(classify(`{"sha256"${space}:"`)).toBe("digest");
      // The same shape under a credential key still reads as one, so the
      // silence is bought by reading the key rather than by giving up on it.
      expect(classify(`{"api_key"${space}:"`)).toBe("credential");
    }
    // Newlines and indentation are the same separator, however they are spelt.
    expect(classify(`{\n  "checksum"\n${" ".repeat(80)}:\n    "`)).toBe("digest");
    // A non-breaking space is whitespace to the `\s*` in the key patterns, so
    // the walk has to agree with them about it.
    expect(classify(`{"sha256"${"\u00a0".repeat(100)}:"`)).toBe("digest");
    // Free is not unbounded: past the scan limit the key is out of reach and
    // the look-back is a cut read again, which reports rather than suppresses.
    expect(classify(`{"sha256"${" ".repeat(SECRET_CONTEXT_WINDOW_SIZE * 4)}:"`)).toBe(
      "assigned"
    );
  });

  test("a look-back that opens on a fragment reports the cut", () => {
    // The window's left edge can land mid-key, and the fragment left over can
    // read as a whole key: `sha256"   :"` is what `"api_key_xsha256"` looks
    // like once cut. `cut` is how classifyKeyContext knows not to trust it.
    const fragment = readKeyLookBack(`sha256"${" ".repeat(200)}:"`, 209);
    expect(fragment.cut).toBe(true);
    expect(classifyKeyContext(fragment.before, "together", undefined, true)).toBe(
      "assigned"
    );
    // Read as if it were whole, the same text says "digest" — which is exactly
    // the suppression the flag exists to withhold.
    expect(classifyKeyContext(fragment.before, "together")).toBe("digest");

    // A key with its left edge in view is not a fragment.
    const whole = readKeyLookBack(`{"sha256"${" ".repeat(200)}:"`, 211);
    expect(whole.cut).toBe(false);
    expect(classifyKeyContext(whole.before, "together", undefined, whole.cut)).toBe(
      "digest"
    );

    // Cutting must not cost the assignment itself: a minified member access at
    // the edge still means the value was assigned, and assigned values report.
    const minified = readKeyLookBack(`t.a||"`, 6);
    expect(minified.cut).toBe(true);
    expect(classifyKeyContext(minified.before, "together", undefined, true)).toBe(
      "assigned"
    );
  });

  test("a cut is where the key stops being readable, not where it starts", () => {
    const cut = (text: string) => classifyKeyContext(text, "together", undefined, true);

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
      classifyKeyContext(`<meta content="`, "together", tag(`content="x" name="release-sha256"`))
    ).toBe("digest");
    // Intervening attributes past the 64-char look-back no longer break it.
    expect(
      classifyKeyContext(
        `" data-testid="release-row" content="`,
        "algolia",
        tag(`name="algolia-api-key" lang="en" dir="ltr" data-testid="release-row" content="x"`)
      )
    ).toBe("credential");
  });

  test("reads the key across an env-var fallback", () => {
    expect(classifyKeyContext(`process.env.SECRET_KEY || "`, "together")).toBe(
      "credential"
    );
    expect(classifyKeyContext(`process.env.TOKEN ?? "`, "together")).toBe("credential");
    expect(classifyKeyContext(`togetherKey||"`, "together")).toBe("credential");
    // The fallback does not launder a digest key into a credential.
    expect(classifyKeyContext(`cacheKey || "`, "together")).toBe("digest");
    expect(classifyKeyContext(`sha256 ?? "`, "together")).toBe("digest");
    expect(classifyKeyContext(`commitHash || "`, "together")).toBe("digest");
    // Nor a key that means nothing into one that does.
    expect(classifyKeyContext(`filename || "`, "together")).toBe("none");
    expect(classifyKeyContext(`t.a || "`, "together")).toBe("assigned");
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

  test("a quoted JSON key inside a script[type=application/json] block is reported", () => {
    const page = html(
      `<script type="application/json">{"x-api-key":"${COMMIT}"}</script>` // pragma: allowlist secret
    );
    const items = findings(leakedSecretsRule.run(ctx(page)).checks);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toContain("Generic API Key Assignment");
  });

  test("the same 40 hex characters stay silent under a git-object key", () => {
    // Nothing in the value tells a git object id apart from an API key — only
    // the key in front of it does. The FAST tier carries its credential
    // keyword in the pattern, so `commit` can never reach it, and the
    // bare-shape CONTEXT tier needs a brand keyword a release page has no
    // reason to carry.
    for (const key of ["commit", "gitCommit", "sha", "revision", "etag", "cacheKey"]) {
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
      expect(scanContent(`x = ${key} || "${COMMIT}";`, "inline-script")).toEqual([]);
    }
  });

  test("a compound key whose left half says digest is not a credential", () => {
    // These start the match part-way through the key — `cache-api-key` begins
    // an `api-key` match at character 6 — and the FAST tier has no
    // classifyKeyContext behind it, so the pattern reads its own left edge.
    // `_` and camelCase join a name wherever they appear; `-` needs syntax to
    // say so, which is the next test.
    for (const key of ["cache_api_key", "cacheApiKey", "checksumSecret", "sha256_secret"]) {
      expect(scanContent(`{"${key}":"${COMMIT}"}`, "html")).toEqual([]);
      expect(scanContent(`{${key}:"${COMMIT}"}`, "html")).toEqual([]);
      expect(scanContent(`x = ${key} || "${COMMIT}";`, "inline-script")).toEqual([]);
    }
    // The word to the left has to actually say digest: `x-api-key` and
    // `stripe_secret` are the same shape and both still report.
    for (const key of ["x-api-key", "myApiKey", "stripe_secret", "next_auth_token"]) {
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
      expect(scanContent(`<img alt="" ${key}="${COMMIT}">`, "html")).toEqual([]);
      expect(scanContent(`<img alt="" data-${key}="${COMMIT}">`, "html")).toEqual([]);
      // Bare, in identifier position, `-` is the subtraction operator. Reading
      // it as one key is what let a minified expression swallow a credential.
      expect(scanContent(`const x=${key}||"${COMMIT}"`, "inline-script")).not.toEqual([]); // pragma: allowlist secret
      expect(scanContent(`x = ${key} || "${COMMIT}";`, "inline-script")).not.toEqual([]); // pragma: allowlist secret
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
    for (const path of ["cache.apiKey", "config.cache.apiKey", "sha256.apiKey"]) {
      expect(scanContent(`${path} = "${COMMIT}";`, "inline-script")).not.toEqual([]); // pragma: allowlist secret
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
      const content = `const v = ${expr} || "${DIGEST}"; // together.ai`;
      expect(scanContent(content, "inline-script")).toEqual([]);
    }
    // A name in front of the fallback still reports, minified ones included.
    for (const content of [
      `const v = cfg.token || "${TOGETHER_KEY}"; // together.ai`, // pragma: allowlist secret
      `t.a||"${TOGETHER_KEY}"; // together.ai`, // pragma: allowlist secret
    ]) {
      expect(scanContent(content, "inline-script").map((f) => f.value)).toEqual([
        TOGETHER_KEY,
      ]);
    }
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
      `const v = credential ?? "${TOGETHER_KEY}"; // together.ai`, // pragma: allowlist secret
    ]) {
      expect(scanContent(content, "inline-script").map((f) => f.value)).toEqual([
        TOGETHER_KEY,
      ]);
    }
    // Same shape, digest key: the published checksum stays silent.
    for (const key of ["cacheKey", "sha256", "etag", "commitHash", "integrityHash"]) {
      const content = `const v = ${key} || "${DIGEST}"; // together.ai`;
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
    expect(scanContent(`<p>Send a Bearer token.</p>${tag}`, "html")).toEqual([]);
  });

  test("a base64 image data URI reports nothing", () => {
    const page = html(
      `<img alt="logo" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==">`
    );
    expect(findings(leakedSecretsRule.run(ctx(page)).checks)).toEqual([]);
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
