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
import { SECRET_CONTEXT_WINDOW_SIZE } from "@squirrelscan/utils/constants";

import { classifyKeyContext, leakedSecretsRule, scanContent } from "../src/security/leaked-secrets";
import type { RuleContext } from "../src/types";

// A real SHA-256 of a release artifact: 64 hex characters, which is also the
// exact shape of a Together AI key.
const DIGEST = "01e4fbb0227e0f575e245eb0d8a4fc9b1d3a7e6c2f80b41d95ea7cd3f0b62a18"; // pragma: allowlist secret
const DIGEST_2 = "7b2c40e91af38d605c7e1b94a2f6d083e5c19b7a4d0f38e6215ca9b70d4f8e32"; // pragma: allowlist secret
// A second 64-hex value, this one actually assigned to an api_key.
const TOGETHER_KEY = "9f3c1d7ba24e08f65c1b93d0e47af215c806b3e9d24f71a5c0938e6b1df42a70"; // pragma: allowlist secret
const COMMIT = "3f9a1c5d7e2b48061a9c3d5f7e8b2a4c6d0e1f93"; // pragma: allowlist secret

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
});

describe("security/leaked-secrets: real credentials still report", () => {
  test("a Together key under a credential key is still reported as one", () => {
    for (const assignment of [
      `const togetherKey = "${TOGETHER_KEY}"`, // pragma: allowlist secret
      `{"together_secret":"${TOGETHER_KEY}"}`, // pragma: allowlist secret
      `window.TOGETHER_TOKEN = "${TOGETHER_KEY}"`, // pragma: allowlist secret
    ]) {
      const found = scanContent(assignment, "inline-script");
      expect(found.map((f) => f.type)).toEqual(["Together AI Key"]);
      expect(found[0]?.value).toBe(TOGETHER_KEY);
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
      expect(found.map((f) => f.value)).toContain(TOGETHER_KEY);
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

  test("a minifier's key is treated as no key, not as a key that failed", () => {
    expect(classifyKeyContext(`t.a = "`, "together")).toBe("assigned");
    expect(classifyKeyContext(`e.x2="`, "together")).toBe("assigned");
    expect(classifyKeyContext(`n={a:"`, "together")).toBe("assigned");
    // A key long enough to mean something still has to say "credential".
    expect(classifyKeyContext(`filename: "`, "together")).toBe("none");
    expect(classifyKeyContext(`description = "`, "together")).toBe("none");
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
});
