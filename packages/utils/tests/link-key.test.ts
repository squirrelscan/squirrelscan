/**
 * The canonical-key table (#2114). This table IS the normalisation spec: the
 * epic's acceptance criterion asks for exactly that, so every rule gets a row
 * (tracking params, ports, fragments, encoding, IDN, trailing slashes) and the
 * expectation is the whole key, never a substring.
 */
import { describe, expect, test } from "bun:test";

import { redactSecretText, siteHostsOf } from "../src/secret-url-redaction";

import {
  applyTrailingSlashPolicy,
  canonicalLinkKey,
  canonicalQuery,
  groupByLinkKey,
  isCredentialParam,
  isTrackingParam,
  keyCarriesCredential,
  keyCarriesSecret,
  MAX_LINK_KEY_LENGTH,
  normalizePercentEncoding,
  redactCredentialParams,
  sanitizeLinkUrl,
} from "../src/link-key";

const cases: Array<{ desc: string; raw: string; key: string | null }> = [
  // ── scheme + host ────────────────────────────────────────────────────────
  { desc: "lowercases the scheme", raw: "HTTPS://example.com/a", key: "https://example.com/a" },
  { desc: "lowercases the host", raw: "https://ExAmPlE.COM/a", key: "https://example.com/a" },
  {
    desc: "keeps http and https apart",
    raw: "http://example.com/a",
    key: "http://example.com/a",
  },
  {
    desc: "drops the default https port",
    raw: "https://example.com:443/a",
    key: "https://example.com/a",
  },
  {
    desc: "drops the default http port",
    raw: "http://example.com:80/a",
    key: "http://example.com/a",
  },
  {
    desc: "keeps a non-default port",
    raw: "https://example.com:8443/a",
    key: "https://example.com:8443/a",
  },
  {
    desc: "drops embedded credentials: a global key must not carry a secret",
    raw: "https://user:pass@example.com/a",
    key: "https://example.com/a",
  },
  // ── IDN ──────────────────────────────────────────────────────────────────
  {
    desc: "punycodes an IDN host",
    raw: "https://bücher.example/a",
    key: "https://xn--bcher-kva.example/a",
  },
  {
    desc: "an already-punycoded host is unchanged",
    raw: "https://xn--bcher-kva.example/a",
    key: "https://xn--bcher-kva.example/a",
  },
  {
    desc: "IDN host case folds the same as ASCII",
    raw: "https://BÜCHER.example/a",
    key: "https://xn--bcher-kva.example/a",
  },
  // ── fragment ─────────────────────────────────────────────────────────────
  {
    desc: "drops the fragment",
    raw: "https://example.com/a#section",
    key: "https://example.com/a",
  },
  {
    desc: "drops a bare fragment marker",
    raw: "https://example.com/a#",
    key: "https://example.com/a",
  },
  {
    desc: "drops the fragment but keeps the query",
    raw: "https://example.com/a?b=1#c",
    key: "https://example.com/a?b=1",
  },
  // ── tracking params ──────────────────────────────────────────────────────
  {
    desc: "drops every utm_ parameter",
    raw: "https://example.com/a?utm_source=x&utm_medium=y&utm_campaign=z",
    key: "https://example.com/a",
  },
  {
    desc: "drops the named click ids",
    raw: "https://example.com/a?fbclid=1&gclid=2&msclkid=3&yclid=4&igshid=5",
    key: "https://example.com/a",
  },
  {
    desc: "drops the mailing-list ids and ref",
    raw: "https://example.com/a?mc_cid=1&mc_eid=2&_hsenc=3&ref=twitter",
    key: "https://example.com/a",
  },
  {
    desc: "tracking params are matched case-insensitively",
    raw: "https://example.com/a?UTM_Source=x&FBCLID=1",
    key: "https://example.com/a",
  },
  {
    desc: "keeps a real parameter alongside tracking ones",
    raw: "https://example.com/a?id=7&utm_source=x",
    key: "https://example.com/a?id=7",
  },
  {
    desc: "does not drop a parameter that merely contains a tracking name",
    raw: "https://example.com/a?referrer=x&preference=y",
    key: "https://example.com/a?preference=y&referrer=x",
  },
  // ── query ordering ───────────────────────────────────────────────────────
  {
    desc: "sorts the remaining parameters",
    raw: "https://example.com/a?b=2&a=1",
    key: "https://example.com/a?a=1&b=2",
  },
  {
    desc: "two orderings of the same query produce one key",
    raw: "https://example.com/a?a=1&b=2",
    key: "https://example.com/a?a=1&b=2",
  },
  {
    desc: "repeated names keep their relative order",
    raw: "https://example.com/a?x=2&x=1",
    key: "https://example.com/a?x=2&x=1",
  },
  {
    desc: "a query that is entirely tracking leaves no question mark",
    raw: "https://example.com/a?utm_source=x",
    key: "https://example.com/a",
  },
  {
    desc: "an empty query leaves no question mark",
    raw: "https://example.com/a?",
    key: "https://example.com/a",
  },
  {
    desc: "keeps a valueless parameter as an explicit empty value",
    raw: "https://example.com/a?flag",
    key: "https://example.com/a?flag=",
  },
  // ── percent encoding ─────────────────────────────────────────────────────
  {
    desc: "decodes a percent-escaped unreserved character",
    raw: "https://example.com/%7Euser",
    key: "https://example.com/~user",
  },
  {
    desc: "uppercases the hex of an escape that must stay encoded",
    raw: "https://example.com/a%2fb",
    key: "https://example.com/a%2Fb",
  },
  {
    desc: "an escaped space keeps its encoding",
    raw: "https://example.com/a%20b",
    key: "https://example.com/a%20b",
  },
  {
    desc: "resolves dot segments",
    raw: "https://example.com/a/../b",
    key: "https://example.com/b",
  },
  {
    // Round-tripping the query through URLSearchParams would decode both to
    // U+FFFD and re-encode them identically, handing two different requests one
    // verdict. The escapes are normalised textually instead.
    desc: "keeps percent escapes that are not valid UTF-8 distinct",
    raw: "https://example.com/a?q=%FE",
    key: "https://example.com/a?q=%FE",
  },
  {
    desc: "the other invalid escape keys differently",
    raw: "https://example.com/a?q=%FF",
    key: "https://example.com/a?q=%FF",
  },
  {
    desc: "a plus in a value is left as the origin will read it",
    raw: "https://example.com/a?q=b+c",
    key: "https://example.com/a?q=b+c",
  },
  {
    desc: "normalises escape case inside a query value",
    raw: "https://example.com/a?q=%2fb",
    key: "https://example.com/a?q=%2Fb",
  },
  // ── trailing slash ───────────────────────────────────────────────────────
  {
    desc: "strips the trailing slash from an extensionless path",
    raw: "https://example.com/blog/",
    key: "https://example.com/blog",
  },
  {
    desc: "the extensionless path without a slash keys the same",
    raw: "https://example.com/blog",
    key: "https://example.com/blog",
  },
  { desc: "keeps the root path", raw: "https://example.com/", key: "https://example.com/" },
  {
    desc: "a bare origin keys as the root path",
    raw: "https://example.com",
    key: "https://example.com/",
  },
  {
    desc: "a file path is left alone",
    raw: "https://example.com/logo.png",
    key: "https://example.com/logo.png",
  },
  {
    // NOT collapsed onto `/logo.png`: most origins 404 the slashed form while
    // serving the image, so sharing a verdict would hand one url the other's
    // answer: in whichever direction happened to be checked first.
    desc: "a file path keeps its trailing slash, because it is a different request",
    raw: "https://example.com/logo.png/",
    key: "https://example.com/logo.png/",
  },
  {
    desc: "an extension mid-path does not protect the trailing slash",
    raw: "https://example.com/a.html/b/",
    key: "https://example.com/a.html/b",
  },
  {
    desc: "the trailing slash goes before the query is appended",
    raw: "https://example.com/blog/?id=1",
    key: "https://example.com/blog?id=1",
  },
  // ── not checkable ────────────────────────────────────────────────────────
  { desc: "mailto is not a checkable link", raw: "mailto:a@example.com", key: null },
  { desc: "tel is not a checkable link", raw: "tel:+15551234", key: null },
  { desc: "javascript is not a checkable link", raw: "javascript:void(0)", key: null },
  { desc: "ftp is not a checkable link", raw: "ftp://example.com/a", key: null },
  { desc: "a data url is not a checkable link", raw: "data:text/plain,hi", key: null },
  { desc: "a relative path has no base to resolve against", raw: "/about", key: null },
  { desc: "a protocol-relative url has no scheme", raw: "//example.com/a", key: null },
  { desc: "an empty string is not a link", raw: "", key: null },
  { desc: "whitespace is not a link", raw: "   ", key: null },
  {
    desc: "surrounding whitespace is trimmed",
    raw: "  https://example.com/a  ",
    key: "https://example.com/a",
  },
];

describe("canonicalLinkKey", () => {
  for (const { desc, raw, key } of cases) {
    test(desc, () => {
      const result = canonicalLinkKey(raw);
      expect(result?.key ?? null).toBe(key);
      // The submitted url is handed back untouched for the caller's own use;
      // `fetchUrl` is the one that may leave the process.
      if (key !== null) expect(result?.raw).toBe(raw);
    });
  }

  test("a url past the key ceiling is unkeyable rather than truncated", () => {
    const long = `https://example.com/${"a".repeat(MAX_LINK_KEY_LENGTH)}`;
    expect(canonicalLinkKey(long)).toBeNull();
    // One character under the ceiling still keys, so the guard is a ceiling and
    // not an accidental refusal of every long url.
    const fits = `https://example.com/${"a".repeat(MAX_LINK_KEY_LENGTH - "https://example.com/".length)}`;
    expect(canonicalLinkKey(fits)?.key.length).toBe(MAX_LINK_KEY_LENGTH);
  });

  test("differently-tagged links to one resource collapse to a single key", () => {
    const keys = new Set(
      [
        "https://example.com/post?utm_source=twitter",
        "https://EXAMPLE.com/post/#comments",
        "https://example.com:443/post?fbclid=abc",
        "https://example.com/post",
      ].map((url) => canonicalLinkKey(url)?.key),
    );
    expect([...keys]).toEqual(["https://example.com/post"]);
  });

  test("two different resources do not collapse", () => {
    const distinct: Array<[string, string]> = [
      ["https://example.com/a?id=1", "https://example.com/a?id=2"],
      // A file and the same path with a trailing slash are two requests.
      ["https://example.com/logo.png", "https://example.com/logo.png/"],
      // Two escapes that are not valid UTF-8.
      ["https://example.com/a?q=%FE", "https://example.com/a?q=%FF"],
      // A non-default port is part of the origin.
      ["https://example.com/a", "https://example.com:8443/a"],
    ];
    for (const [left, right] of distinct) {
      expect(canonicalLinkKey(left)?.key).not.toBe(canonicalLinkKey(right)?.key as string);
    }
  });
});

describe("fetchUrl: the only spelling allowed to leave the process", () => {
  test("drops embedded credentials", () => {
    // The cache key is credential-BLIND, so a verdict fetched with these would
    // be stored under the credential-free key and handed to every later
    // requester: a cross-tenant secret disclosure through a cache, and a
    // verdict about a different response than the key describes.
    const canonical = canonicalLinkKey("https://alice:secret@example.com/a");
    expect(canonical?.fetchUrl).toBe("https://example.com/a");
    expect(canonical?.fetchUrl).not.toContain("secret");
    expect(canonical?.fetchUrl).not.toContain("alice");
  });

  test("drops a username with no password", () => {
    expect(canonicalLinkKey("https://alice@example.com/a")?.fetchUrl).toBe("https://example.com/a");
  });

  test("drops the fragment, including one that looks like credentials", () => {
    const canonical = canonicalLinkKey("https://alice:secret@example.com/#x@y");
    expect(canonical?.key).toBe("https://example.com/");
    expect(canonical?.fetchUrl).toBe("https://example.com/");
    expect(canonical?.fetchUrl).not.toContain("@");
  });

  test("keeps everything the origin actually needs", () => {
    // Path case, the trailing slash and the query are preserved verbatim: this
    // is the url a trailing-slash-sensitive origin will be asked for.
    const canonical = canonicalLinkKey("https://example.com/Blog/?b=2&a=1&utm_source=x");
    expect(canonical?.fetchUrl).toBe("https://example.com/Blog/?b=2&a=1&utm_source=x");
    // The KEY still normalises, which is the whole point of having both.
    expect(canonical?.key).toBe("https://example.com/Blog?a=1&b=2");
  });

  test("falls back to the key when the sanitised url outruns the ceiling", () => {
    // The key drops tracking parameters, so it can fit while the fetch url does
    // not. Falling back to the key still checks the same resource; dropping the
    // link would not.
    const padded = `https://example.com/a?utm_content=${"x".repeat(MAX_LINK_KEY_LENGTH)}`;
    const canonical = canonicalLinkKey(padded);
    expect(canonical?.key).toBe("https://example.com/a");
    expect(canonical?.fetchUrl).toBe("https://example.com/a");
  });

  test("is never longer than the ceiling", () => {
    const long = `https://example.com/a?q=${"x".repeat(5000)}`;
    // The key itself is over the ceiling here, so the whole url is unkeyable.
    expect(canonicalLinkKey(long)).toBeNull();
  });
});

describe("sanitizeLinkUrl", () => {
  test.each([
    ["https://alice:secret@example.com/a", "https://example.com/a"],
    ["https://example.com/a#frag", "https://example.com/a"],
    ["https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["https://EXAMPLE.com/A/", "https://example.com/A/"],
  ])("%s -> %s", (input, expected) => {
    expect(sanitizeLinkUrl(input as string)).toBe(expected);
  });

  test.each(["mailto:a@example.com", "/relative", "", "not a url", "ftp://example.com/a"])(
    "%s is not sanitisable",
    (input) => {
      expect(sanitizeLinkUrl(input as string)).toBeNull();
    },
  );
});

describe("isTrackingParam", () => {
  test.each([
    ["utm_source", true],
    ["utm_anything_at_all", true],
    ["UTM_SOURCE", true],
    ["fbclid", true],
    ["ref", true],
    ["referrer", false],
    ["id", false],
    ["utmx", false],
  ])("%s -> %s", (name, expected) => {
    expect(isTrackingParam(name as string)).toBe(expected);
  });
});

describe("normalizePercentEncoding", () => {
  test.each([
    ["/%7e", "/~"],
    ["/%2f", "/%2F"],
    ["/%41", "/A"],
    ["/plain", "/plain"],
    ["/%zz", "/%zz"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePercentEncoding(input as string)).toBe(expected);
  });
});

describe("applyTrailingSlashPolicy", () => {
  test.each([
    ["/", "/"],
    ["//", "/"],
    ["/blog/", "/blog"],
    ["/blog", "/blog"],
    ["/a.html", "/a.html"],
    ["/a.html/", "/a.html/"],
    ["/v1.2.3", "/v1.2.3"],
  ])("%s -> %s", (input, expected) => {
    expect(applyTrailingSlashPolicy(input as string)).toBe(expected);
  });
});

describe("canonicalQuery", () => {
  test("empty inputs produce no query", () => {
    expect(canonicalQuery("")).toBe("");
    expect(canonicalQuery("?")).toBe("");
    expect(canonicalQuery("?utm_source=x")).toBe("");
  });
});

describe("groupByLinkKey", () => {
  test("fans several raw urls onto one key and keeps the first as the fetch target", () => {
    const { byKey, unkeyable } = groupByLinkKey([
      "https://example.com/post?utm_source=a",
      "https://example.com/post",
      "mailto:a@example.com",
      "https://other.example/x",
    ]);

    expect([...byKey.keys()].sort()).toEqual([
      "https://example.com/post",
      "https://other.example/x",
    ]);
    const post = byKey.get("https://example.com/post");
    expect(post?.fetchUrl).toBe("https://example.com/post?utm_source=a");
    expect(post?.rawUrls).toEqual([
      "https://example.com/post?utm_source=a",
      "https://example.com/post",
    ]);
    expect(unkeyable).toEqual(["mailto:a@example.com"]);
  });
});

describe("credential query parameters (#2782)", () => {
  // A dummy JWT: three base64url segments, no real claims.
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLW5vdC1yZWFs";
  const article = "https://www.bloomberg.com/news/articles/2026-10-06/example-story";

  test("a gift link and the plain article share one key, with no token in it", () => {
    const gift = canonicalLinkKey(`${article}?accessToken=${JWT}&leadSource=article-gifting`);
    const plain = canonicalLinkKey(`${article}?leadSource=article-gifting`);
    expect(gift?.key).toBe(plain?.key);
    expect(gift?.key).not.toContain(JWT);
    expect(gift?.key).not.toContain("accessToken");
  });

  test("a signed url keys without its signature, and is still fetched with it", () => {
    const signed =
      "https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Credential=AKIDEXAMPLE&X-Amz-Expires=600&X-Amz-Signature=deadbeef";
    const canonical = canonicalLinkKey(signed);
    expect(canonical?.key).toBe("https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Expires=600");
    expect(canonical?.fetchUrl).toContain("X-Amz-Signature=deadbeef");
  });

  test("a JWT is a credential under any name; an ordinary value under a token-ish name is not", () => {
    expect(isCredentialParam("t", JWT)).toBe(true);
    expect(isCredentialParam("token", "abc")).toBe(true);
    expect(isCredentialParam("Access_Token", "abc")).toBe(true);
    expect(isCredentialParam("tokenizer", "bpe")).toBe(false);
    expect(isCredentialParam("q", "eyJ")).toBe(false);
    expect(canonicalLinkKey(`https://example.com/p?t=${JWT}&page=2`)?.key).toBe(
      "https://example.com/p?page=2",
    );
  });

  test("what is stored or printed keeps the names and redacts the values, idempotently", () => {
    const url = `${article}?accessToken=${JWT}&leadSource=article-gifting`;
    const redacted = redactCredentialParams(url);
    expect(redacted).toBe(`${article}?accessToken=REDACTED&leadSource=article-gifting`);
    expect(redactCredentialParams(redacted)).toBe(redacted);
    expect(redactCredentialParams(article)).toBe(article);
    expect(redactCredentialParams("https://example.com/?a=1&sig=xyz#top")).toBe(
      "https://example.com/?a=1&sig=REDACTED#top",
    );
  });

  test("a percent-encoded name or value is redacted as surely as it is dropped from the key", () => {
    const encodedName = "https://example.com/p?access%5Ftoken=opaque123&%74oken=abc&page=2";
    expect(redactCredentialParams(encodedName)).toBe(
      "https://example.com/p?access%5Ftoken=REDACTED&%74oken=REDACTED&page=2",
    );
    expect(canonicalLinkKey(encodedName)?.key).toBe("https://example.com/p?page=2");
    // Encode only the FIRST dot so the token mixes encoded and literal separators.
    const [jwtHead, ...jwtRest] = JWT.split(".");
    const encodedJwt = `https://example.com/p?t=${jwtHead}%2E${jwtRest.join(".")}`;
    expect(redactCredentialParams(encodedJwt)).toBe("https://example.com/p?t=REDACTED");
    expect(keyCarriesCredential(encodedJwt)).toBe(true);
  });

  test("hyphenated credential names count too", () => {
    for (const name of ["access-token", "auth-token", "api-key", "X-Api-Key"]) {
      expect(isCredentialParam(name, "opaque")).toBe(true);
      expect(redactCredentialParams(`https://example.com/?${name}=opaque`)).toBe(
        `https://example.com/?${name}=REDACTED`,
      );
    }
  });

  test("a key from before the change is recognisable", () => {
    expect(keyCarriesCredential(`${article}?accessToken=${JWT}`)).toBe(true);
    expect(keyCarriesCredential(canonicalLinkKey(`${article}?accessToken=${JWT}`)!.key)).toBe(
      false,
    );
  });
});

// #3384: the key is computed from the redacted href, so a raw href and the
// published report's redacted copy of it are one key, and no secret is in one.
describe("keys join the report's redacted href (#3384)", () => {
  const JWT_VALUE = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl";
  const TOKEN = "0f8e7d6c5b4a39281706f5e4d3c2b1a0";
  const site = siteHostsOf(["https://mysite.example/"]);
  const SECRETS = [JWT_VALUE, TOKEN, "hunter2"];
  const hrefs = [
    // The three shapes the issue names.
    `https://partner.example.org/login?next=/cb?token=${TOKEN}`,
    `https://partner.example.org/p?access_token=${TOKEN}&page=2`,
    `https://partner.example.org/share/${JWT_VALUE}/view`,
    // Around them.
    `https://partner.example.org/cb?next=%2Freset%3Ftoken%3D${TOKEN}`,
    `https://partner.example.org/p?t=${JWT_VALUE}&page=2`,
    `https://alice:hunter2@partner.example.org/p?x=1`,
    `https://partner.example.org/p?password=hunter2&x=1`,
    `https://partner.example.org/docs?utm_source=a&page=3#frag`,
    `https://partner.example.org/p?sid=${TOKEN}`,
    `https://partner.example.org/a%20b/?q=1`,
  ];

  test.each(hrefs)("the key of the raw href is the key of its redacted copy: %s", (raw) => {
    const redacted = redactSecretText(raw, site);
    expect(canonicalLinkKey(raw)?.key).toBeDefined();
    expect(canonicalLinkKey(redacted)?.key).toBe(canonicalLinkKey(raw)?.key);
  });

  // A session parameter on an off-site link stays in its key (not a credential: #3339).
  const credentialHrefs = hrefs.filter((raw) => !raw.includes("sid="));
  test.each(credentialHrefs)("no credential, userinfo or JWT reaches the key: %s", (raw) => {
    const keys = [canonicalLinkKey(raw)!.key, ...groupByLinkKey([raw]).byKey.keys()];
    for (const key of keys) for (const secret of SECRETS) expect(key).not.toContain(secret);
  });

  test("the fetch url keeps what the request needs (a signed url), the key does not", () => {
    const raw = `https://partner.example.org/dl?access_token=${TOKEN}&page=2`;
    const link = canonicalLinkKey(raw)!;
    expect(link.fetchUrl).toContain(`access_token=${TOKEN}`);
    expect(link.key).toBe("https://partner.example.org/dl?page=2");
  });

  test("links that differ only by a JWT under an ordinary name share a key", () => {
    const a = canonicalLinkKey(`https://partner.example.org/p?t=${JWT_VALUE}&page=2`)!.key;
    const b = canonicalLinkKey(`https://partner.example.org/p?page=2`)!.key;
    expect(a).toBe(b);
  });

  test("a percent-encoded secret is read as the redactor reads it plain", () => {
    const encoded = [
      `https://partner.example.org/share/%65yJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl/view`,
      `https://partner.example.org/share/eyJ%68bGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl/view`,
      `https://partner.example.org/cb?tok%65n=${TOKEN}`,
    ];
    for (const raw of encoded) {
      const key = canonicalLinkKey(raw)!.key;
      expect(key).not.toContain("eyJ");
      expect(key).not.toContain(TOKEN);
    }
  });

  test("a produced key is a fixed point: re-keying it, or redacting it, changes nothing", () => {
    for (const raw of [
      ...hrefs,
      `https://partner.example.org/share/%65yJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl/view`,
      `https://partner.example.org/p?a=%7Etilde&b=%2fslash`,
      `https:/partner.example.org/p?sid=${TOKEN}`,
    ]) {
      const key = canonicalLinkKey(raw)?.key;
      if (key === undefined) continue;
      expect(canonicalLinkKey(key)?.key).toBe(key);
      expect(keyCarriesSecret(key)).toBe(false);
    }
  });

  test("keyCarriesSecret sees what keyCarriesCredential does not (a key from before)", () => {
    for (const old of [
      `https://partner.example.org/share/${JWT_VALUE}/view`,
      `https://partner.example.org/login?next=/cb?token=${TOKEN}`,
      `https://alice:hunter2@partner.example.org/p`,
    ]) {
      expect(keyCarriesCredential(old)).toBe(false);
      expect(keyCarriesSecret(old)).toBe(true);
    }
    expect(keyCarriesSecret(`https://partner.example.org/p?access_token=${TOKEN}`)).toBe(true);
    expect(keyCarriesSecret("https://partner.example.org/p?page=2")).toBe(false);
  });

  test("an over-long fetch url never falls back to a key whose path was redacted", () => {
    const long = `https://partner.example.org/share/${JWT_VALUE}/view?q=${"a".repeat(MAX_LINK_KEY_LENGTH)}`;
    // Past the key limit as well, so unkeyable either way; and a shorter key with
    // a long tracking tail has no redacted value to fall back on.
    expect(canonicalLinkKey(long)).toBeNull();
    const tail = `utm_x=${"a".repeat(MAX_LINK_KEY_LENGTH)}`;
    const ok = canonicalLinkKey(`https://partner.example.org/share/${JWT_VALUE}?${tail}`);
    expect(ok).toBeNull();
    const plain = canonicalLinkKey(`https://partner.example.org/p?${tail}&page=2`);
    expect(plain?.key).toBe("https://partner.example.org/p?page=2");
    expect(plain?.fetchUrl).toBe("https://partner.example.org/p?page=2");
  });

  test("an href far past the key limit is unkeyable without being redacted", () => {
    expect(canonicalLinkKey(`https://partner.example.org/p?q=${"a".repeat(40_000)}`)).toBeNull();
  });
});

// repo#3433, re-copied into the public redactor: a list-indexed credential name
// keeps no secret in the shared key. Keys use off-site semantics, so per-visitor
// names and path tokens stay in them by design (#3339).
describe("an indexed credential name is dropped from the key (repo#3433)", () => {
  const HEX = "3f2a9c1b8e7d6a5f4e3d";

  test.each([
    [`https://example.com/x?token[0]=${HEX}`, "https://example.com/x"],
    [`https://example.com/x?token[]=${HEX}&page=2`, "https://example.com/x?page=2"],
    [`https://example.com/x?access_token[0][1]=${HEX}&page=2`, "https://example.com/x?page=2"],
  ])("%s keys as %s", (raw, key) => {
    expect(canonicalLinkKey(raw)?.key).toBe(key);
  });
});
