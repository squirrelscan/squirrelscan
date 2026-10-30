// security/leaked-secrets: the public-by-design tier (#1287, #1229).
//
// A token moves to the informational tier only on positive evidence in the
// token or beside it: its own claims, the attribute it sits in, a URL it is
// shipped with. A name, a path or an issuer on its own is not evidence, and
// anything the evidence does not cover keeps reporting. Each block pairs what
// moves with the real-shaped control that must still report. Every value is
// synthetic and built at runtime.

import { describe, expect, test } from "bun:test";

import { leakedSecretsRule, scanContent, type SecretLocation } from "../../src/security/leaked-secrets";
import type { CheckItem, RuleContext } from "../../src/types";
import { mixedRun, runOf, seededRng } from "./leaked-secrets/generators";

const HEX = "0123456789abcdef";
const PAGE = "https://shop.acme.test/";

function found(text: string, location: SecretLocation = "inline-script", url = PAGE) { // pragma: allowlist secret
  return scanContent(text, location, url).map((f) => [f.type, f.confidence, f.publicByDesign]);
}

const b64u = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: object, header: object = { alg: "HS256", typ: "JWT" }) =>
  `${b64u(header)}.${b64u(payload)}.${runOf(seededRng(2), "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-", 43)}`; // pragma: allowlist secret

describe("Shopify platform tokens (#1287)", () => {
  const wallet = { iat: 1761000000, merchantId: "58212", merchantOrigin: "https://shop.acme.test", expiresAt: 1761003600 };
  const session = { client_id: "a1b2c3", client_account_id: "99", unique_id: "u-17", iat: 1761000000 };

  test("the wallet token is public, whatever page carries it", () => {
    const html = `<script type="application/json">{"auth":[{"jwt":"${jwt(wallet)}"}]}</script>`;
    expect(found(html, "html")).toEqual([["Shopify Wallet Token", "medium", true]]);
    expect(found(`var w="${jwt(wallet)}";`)).toEqual([["Shopify Wallet Token", "medium", true]]);
  });

  test("the Shop sessions token is public only with the sessions URL beside it", () => {
    const token = jwt(session);
    expect(found(`<a href="https://shopifyinc.com/sessions">x</a><script>var s="${token}"</script>`, "html").map((f) => f[0])).toEqual([
      "Shopify Shop Session Token",
    ]);
    expect(found(`<!-- https://shopifyinc.com/sessions/v1 --><script>var s="${token}"</script>`, "html").map((f) => f[0])).toEqual([
      "Shopify Shop Session Token",
    ]);
    // The claim names alone are what any custom app's own session token is made of.
    expect(found(`var s="${token}";`)).toEqual([["JSON Web Token", "medium", false]]);
    // A lookalike host is not the sessions URL.
    for (const host of ["shopifyinc.com.evil.test", "evilshopifyinc.com"]) {
      expect(found(`<a href="https://${host}/sessions">x</a><script>var s="${token}"</script>`, "html")).toEqual([["JSON Web Token", "medium", false]]);
    }
  });

  test("a wallet-shaped token with a role, an admin scope or no signature is not claimed", () => {
    expect(found(`var w="${jwt({ ...wallet, scope: "admin" })}";`)).toEqual([["JSON Web Token (admin scope)", "high", false]]);
    expect(found(`var w="${jwt({ ...wallet, role: "service_role" })}";`).map((f) => f[2])).toEqual([false]);
    expect(found(`var w="${jwt({ iat: 1761000000, merchantId: "58212" })}";`)).toEqual([["JSON Web Token", "medium", false]]);
    for (const header of [{ alg: "none", typ: "JWT" }, { typ: "JWT" }]) {
      expect(found(`var w="${jwt(wallet, header)}";`)).toEqual([["JSON Web Token", "medium", false]]);
    }
  });

  describe("Shopify's platform bundles", () => {
    const r = seededRng(1287);
    const apiKey = `var c={apiKey:"${runOf(r, HEX, 32)}"};`;
    const others = `var o={secret:"${mixedRun(r, 24)}",accessToken:"${mixedRun(r, 40)}",aws_secret_access_key:"${mixedRun(r, 40)}"};`;
    const shopifyish = "/* Shopify.wallets */ var s=window.Shopify; var t='shopify-pay';";

    const store = "https://acme.myshopify.com/cdn/shopifycloud/portable-wallets/latest/portable-wallets.en.js";

    test("an apiKey in a bundle on cdn.shopify.com or a myshopify.com store is not reported", () => {
      expect(found(apiKey, "external-script", "https://cdn.shopify.com/shopifycloud/portable-wallets/latest/portable-wallets.en.js")).toEqual([]);
      expect(found(apiKey, "external-script", store)).toEqual([]);
    });

    test("nothing else in the bundle is skipped: secrets, tokens and AWS keys still report", () => {
      expect(found(apiKey + others + shopifyish, "external-script", store).map((f) => f[0]).sort()).toEqual([
        "AWS Secret Access Key",
        "Generic Secret Assignment",
        "Generic Token Assignment",
      ]);
    });

    test("a path alone, or the word Shopify in the file, is not enough: only a Shopify host qualifies", () => {
      for (const [content, url] of [
        [apiKey, "https://shop.acme.test/cdn/shopifycloud/x.js"],
        [apiKey + shopifyish.repeat(10), "https://shop.acme.test/cdn/shopifycloud/x.js"],
        [apiKey + shopifyish.repeat(10), "https://evil.test/cdn/shopifycloud/x.js"],
        [apiKey + shopifyish, "https://acme.myshopify.com.evil.test/cdn/shopifycloud/x.js"],
        [apiKey + shopifyish, "https://myshopify.com.evil.test/cdn/shopifycloud/x.js"],
        [apiKey + shopifyish, "https://cdn.shopify.com/cdn/shopifycloud/x.js"],
        [apiKey + shopifyish, "https://shop.acme.test/cdn/shop/t/1/assets/theme.js"],
        [apiKey + shopifyish, "https://shop.acme.test/assets/cdn/shopifycloud/x.js"],
        [apiKey + shopifyish, "https://not-cdn.shopify.com.evil.test/shopifycloud/x.js"],
        [apiKey + shopifyish, "https://shop.acme.test/cdn/shopifycloudx/x.js"],
      ] as const) {
        expect([url, found(content, "external-script", url).map((f) => f[0]).includes("Generic API Key Assignment")]).toEqual([url, true]);
      }
    });

    test("a provider token in a theme asset still reports", () => {
      const key = "sk_" + "live_" + mixedRun(r, 24);
      expect(found(`var k="${key}";`, "external-script", "https://shop.acme.test/cdn/shop/t/1/assets/theme.js")).toEqual([
        ["Stripe Live Key", "high", false],
      ]);
    });
  });

  describe("the App Store listing's api-key", () => {
    const key = runOf(seededRng(3), HEX, 32);
    const listing = (attr: string) => `<div ${attr}="${key}"></div>`;

    test("is not reported on apps.shopify.com", () => {
      for (const attr of ["api-key", "data-api-key"]) {
        expect(found(listing(attr), "html", "https://apps.shopify.com/some-app")).toEqual([]);
      }
    });

    test("is reported on any other host, and other keys on the listing still are", () => {
      for (const url of ["https://apps.shopify.com.evil.test/x", "https://apps.shopify.com@evil.test/x"]) {
        expect(found(listing("api-key"), "html", url).map((f) => f[0])).toEqual(["Generic API Key Assignment"]);
      }
      expect(found(`<div data-secret="${mixedRun(seededRng(4), 24)}"></div>`, "html", "https://apps.shopify.com/x").map((f) => f[0])).toEqual([
        "Generic Secret Assignment",
      ]);
    });
  });
});

describe("presigned URL credential ids (#1229)", () => {
  const id = (prefix: string) => prefix + "ABCDEFGHJKLMNPQR"; // pragma: allowlist secret
  const url = (credential: string, rest: string) =>
    `<img src="https://bucket.acme.test/f.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${credential}${rest}">`;
  const signature = `&X-Amz-Signature=${runOf(seededRng(5), HEX, 64)}`;
  const expires = "&X-Amz-Expires=3600";
  const scope = "%2F20261028%2Fus-east-1%2Fs3%2Faws4_request";

  test("an id in a URL with both a signature and an expiry is informational", () => {
    for (const prefix of ["ASIA", "AKIA"]) {
      expect(found(url(id(prefix), scope + expires + signature), "html")).toEqual([["AWS Access Key ID", "info", false]]);
    }
  });

  test("without both, the scope tail and a bare signature are not enough", () => {
    for (const rest of [scope + signature, scope + expires, signature, scope, "&signature=x" + scope]) {
      expect([rest.slice(0, 20), found(url(id("AKIA"), rest), "html")[0]?.[1]]).not.toEqual([rest.slice(0, 20), "info"]);
    }
    expect(found(`var k="${id("ASIA")}";`)[0]?.[1]).not.toBe("info");
    expect(found(`<a href="/x?token=${id("ASIA")}${scope}${expires}${signature}">`, "html")[0]?.[1]).not.toBe("info");
  });
});

describe("the Netlify web vitals beacon (#1229)", () => {
  const claims = { site_id: "a", account_id: "b", deploy_id: "c", iss: "netlify", iat: 1761000000 };

  test("in its attribute it is public", () => {
    expect(found(`<div data-netlify-cwv-token="${jwt(claims)}"></div>`, "html")).toEqual([["Netlify Web Vitals Token", "medium", true]]);
  });

  test("anywhere else, with a role, an extra claim or no signature, it is not claimed", () => {
    expect(found(`var t="${jwt(claims)}";`).map((f) => f[2])).toEqual([false]);
    expect(found(`<div data-other="${jwt(claims)}"></div>`, "html").map((f) => f[2])).toEqual([false]);
    for (const extra of [{ role: "admin" }, { email: "a@acme.test" }, { permissions: ["x"] }, { admin: true }]) {
      expect(found(`<div data-netlify-cwv-token="${jwt({ ...claims, ...extra })}"></div>`, "html").map((f) => f[2])).toEqual([false]);
    }
    expect(found(`<div data-netlify-cwv-token="${jwt(claims, { alg: "none" })}"></div>`, "html").map((f) => f[2])).toEqual([false]);
  });
});

describe("consent and API tokens from a consent vendor's host stay reported (#1229)", () => {
  test("an issuer host is not evidence: the token reports as an ordinary JWT, as does an unsigned one", () => {
    for (const iss of ["https://privacyportal.onetrust.com", "cdn.cookielaw.org", "https://api.transcend.io", "https://api.didomi.io"]) {
      expect(found(`var c="${jwt({ iss, sub: "cp-1", iat: 1761000000 })}";`)).toEqual([["JSON Web Token", "medium", false]]);
    }
    expect(found(`var c="${jwt({ iss: "https://app.onetrust.com", sub: "cp", iat: 1 }, { alg: "none" })}";`).map((f) => f[2])).toEqual([false]);
  });
});

describe("search keys keep reporting, with the name as a hint (#1229)", () => {
  const key = mixedRun(seededRng(6), 32);
  const one = (text: string) => scanContent(text, "inline-script", PAGE);

  test("a key named as the search key reports at medium with a hint, never as public", () => {
    for (const name of ["search_api_key", "searchApiKey", "search-only-api-key", "ALGOLIA_SEARCH_API_KEY"]) {
      const [finding] = one(`{"${name}":"${key}"}`);
      expect([name, finding?.type, finding?.confidence, finding?.publicByDesign, typeof finding?.extra?.hint]).toEqual([
        name,
        "Generic API Key Assignment",
        "medium",
        false,
        "string",
      ]);
    }
  });

  test("an admin key under a search-looking name reports like any other, as do other names", () => {
    for (const name of ["searchOwnerKey", "search_sudo_api_key", "searchIndexingApiKey", "azure_search_api_key", "search_admin_api_key", "apiKey"]) {
      const reported = found(`{"${name}":"${key}"}`);
      expect([name, reported.every((f) => f[1] === "medium" && f[2] === false)]).toEqual([name, true]);
    }
    // No hint when the name carries a privileged word.
    expect(one(`{"search_admin_api_key":"${key}"}`)[0]?.extra?.hint).toBeUndefined();
  });

  test("the same value under a search name and an admin name is reported as a leak, never as public", () => {
    const text = `{searchApiKey:"${key}",adminApiKey:"${key}"}`;
    const reported = leakedSecretsRule.run({
      site: { baseUrl: PAGE, pages: [], robotsTxt: null, sitemaps: null, scripts: [{ url: "https://shop.acme.test/a.js", content: text, status: 200, error: null, contentType: "application/javascript", sizeBytes: text.length, sourcePages: [PAGE] }] },
      options: {},
    } as unknown as RuleContext) as { checks: Array<{ name: string; items?: CheckItem[] }> };
    const medium = reported.checks.find((c) => c.name === "leaked-secrets-medium");
    // The scanner reports one finding per distinct secret value; what matters is that it is a leak, not a public key.
    expect(medium?.items?.length).toBeGreaterThanOrEqual(1);
    expect(reported.checks.some((c) => c.name === "leaked-secrets-public")).toBe(false);
  });

  test("a Typesense client config is reported like any other key", () => {
    expect(found(`{typesense:{apiKey:"${key}",nodes:[{host:"search.acme.test"}]}}`)).toEqual([["Generic API Key Assignment", "medium", false]]);
  });
});

describe("bypass attempts: a real secret dressed as a public token", () => {
  const r = seededRng(77);
  const extras: Array<[string, object]> = [
    ["admin: true", { admin: true }],
    ["is_admin", { is_admin: true }],
    ["an email", { email: "root@acme.test" }],
    ["a permissions list", { permissions: ["write:all"] }],
    ["a scope", { scope: "orders:write" }],
    ["a role", { role: "owner" }],
  ];

  test("each public JWT shape with one extra privilege claim stays a reported JSON Web Token", () => {
    const shapes: Array<[string, object, string, SecretLocation]> = [
      ["wallet", { merchantId: "58212", merchantOrigin: "https://shop.acme.test", iat: 1761000000 }, "var w=", "inline-script"],
      ["netlify", { site_id: "a", iss: "netlify", iat: 1761000000 }, "<div data-netlify-cwv-token=", "html"],
    ];
    for (const [shape, claims, lead, location] of shapes) {
      for (const [label, extra] of extras) {
        const token = jwt({ ...claims, ...extra });
        const text = lead.startsWith("<") ? `${lead}"${token}"></div>` : `${lead}"${token}";`;
        const result = found(text, location);
        expect([shape, label, result.length > 0 && result.every((f) => f[2] === false)]).toEqual([shape, label, true]);
      }
    }
  });

  test("a payload that spells a privileged claim with a JSON escape or a duplicate key is read as a server reads it", () => {
    const head = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
    const sig = mixedRun(seededRng(56), 43, "abcdefghijklmnopqrstuvwxyz0123456789");
    const wallet = (json: string) => `${head}.${Buffer.from(json).toString("base64url")}.${sig}`;
    const base = '"merchantId":"1","merchantOrigin":"https://shop.acme.test"';
    for (const json of [`{${base},"\\u0061dmin":true}`, `{${base},"role":"x","role":"admin"}`, `{${base},"scope":"admin","scope":"read"}`, `{${base},"__proto__":{"admin":true}}`]) {
      expect(found(`var w="${wallet(json)}";`).map((f) => f[2])).toEqual([false]);
    }
    expect(found(`var w="${wallet(`{${base},"iat":1}`)}";`).map((f) => f[0])).toEqual(["Shopify Wallet Token"]);
  });

  test("a real key id beside a presigned-looking URL is not hidden unless the URL carries the whole shape", () => {
    const id = "AKIA" + "ABCDEFGHJKLMNPQR"; // pragma: allowlist secret
    expect(found(`var k="${id}"; var u="https://b.test/f?X-Amz-Signature=${runOf(seededRng(1), HEX, 64)}";`)[0]?.[1]).not.toBe("info");
    void r;
  });
});

describe("differential probes: the classifier reads the same text the matcher matched", () => {
  const key = mixedRun(seededRng(55), 32);
  const assignment = `var c={apiKey:"${key}"};`;

  test("a script URL cannot borrow the platform path through dots, a query or userinfo", () => {
    for (const url of [
      "https://shop.acme.test/cdn/shopifycloud/../../assets/app.js",
      "https://shop.acme.test/cdn/shopifycloud/%2e%2e/%2e%2e/assets/app.js",
      "https://shop.acme.test/assets/app.js?/cdn/shopifycloud/x.js",
      "https://shop.acme.test/assets/app.js#/cdn/shopifycloud/x.js",
      "https://cdn.shopify.com.evil.test/shopifycloud/x.js",
      "https://cdn.shopify.com@evil.test/shopifycloud/x.js",
    ]) {
      const content = assignment + "/* shopify shopify shopify */";
      expect([url, found(content, "external-script", url).map((f) => f[0])]).toEqual([url, ["Generic API Key Assignment"]]);
    }
  });
});

describe("the new checks stay linear on adversarial input", () => {
  const time = (text: string, location: SecretLocation = "external-script", url = "https://shop.acme.test/cdn/shopifycloud/x.js") => { // pragma: allowlist secret
    const start = performance.now();
    scanContent(text, location, url);
    return performance.now() - start;
  };

  test("a megabyte of search-key assignments, presigned-looking URLs, JWTs and Shopify mentions", () => {
    const key = mixedRun(seededRng(9), 32);
    const inputs = [
      `search_api_key:"${key}",`.repeat(30000),
      "X-Amz-Credential=ASIAABCDEFGHJKLMNPQR%2F2026".repeat(25000), // pragma: allowlist secret
      `${jwt({ iss: "netlify" })} `.repeat(6000),
      "shopify ".repeat(120000),
    ];
    for (const text of inputs) expect(time(text)).toBeLessThan(5000);
  });
});
