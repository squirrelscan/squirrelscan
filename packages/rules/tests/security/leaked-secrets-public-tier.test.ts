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

  test("an admin-named provider key reports at high; other privileged and ordinary names stay medium", () => {
    for (const name of ["searchOwnerKey", "search_sudo_api_key", "searchIndexingApiKey", "azure_search_api_key", "apiKey"]) {
      const reported = found(`{"${name}":"${key}"}`);
      expect([name, reported.every((f) => f[1] === "medium" && f[2] === false)]).toEqual([name, true]);
    }
    for (const name of ["search_admin_api_key", "adminApiKey", "admin_api_key"]) {
      const [finding] = one(`{"${name}":"${key}"}`);
      expect([name, finding?.confidence, finding?.extra?.keyKind, finding?.extra?.hint]).toEqual([
        name,
        "high",
        "admin-named",
        undefined,
      ]);
    }
  });

  test("Algolia and Typesense shapes change tier only when the variable names admin scope", () => {
    const algolia = runOf(seededRng(61), HEX, 32);
    const typesense = mixedRun(seededRng(62), 32);
    for (const [provider, providerKey] of [["algolia", algolia], ["typesense", typesense]] as const) {
      expect([provider, one(`{"adminApiKey":"${providerKey}"}`)[0]?.confidence]).toEqual([provider, "high"]);
      const search = one(`{"searchApiKey":"${providerKey}"}`)[0];
      expect([provider, search?.confidence, typeof search?.extra?.hint]).toEqual([provider, "medium", "string"]);
    }
    const short = mixedRun(seededRng(63), 24);
    expect(one(`{"adminApiKey":"${short}"}`)[0]?.confidence).toBe("medium");
  });

  test("Meilisearch masterKey and searchKey assignments are detected at their scope tiers", () => {
    const master = mixedRun(seededRng(64), 24);
    const search = mixedRun(seededRng(65), 32);
    const masterFinding = one(`MeiliSearch({masterKey:"${master}"})`)[0];
    const searchFinding = one(`MeiliSearch({searchKey:"${search}"})`)[0];
    expect([masterFinding?.confidence, masterFinding?.extra?.keyKind]).toEqual(["high", "admin-named"]);
    expect([searchFinding?.confidence, typeof searchFinding?.extra?.hint]).toEqual(["medium", "string"]);
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

describe("guards pinned after review (#1287, #1229)", () => {
  const wallet = { iat: 1761000000, merchantId: "58212", merchantOrigin: "https://shop.acme.test", expiresAt: 1761003600 };
  const session = { client_id: "a1b2c3", client_account_id: "99", unique_id: "u-17", iat: 1761000000 };
  const claims = { site_id: "a", account_id: "b", deploy_id: "c", iss: "netlify", iat: 1761000000 };
  const types = (text: string, location: SecretLocation = "inline-script", url = PAGE) => found(text, location, url).map((f) => f[0]); // pragma: allowlist secret

  test("the sessions URL counts after the token, within the 1,024 characters read, and not beyond", () => {
    const token = jwt(session);
    const link = '<a href="https://shopifyinc.com/sessions">x</a>';
    expect(types(`<script>var s="${token}"</script>${" ".repeat(900)}${link}`, "html")).toEqual(["Shopify Shop Session Token"]);
    expect(types(`<script>var s="${token}"</script>${" ".repeat(1_200)}${link}`, "html")).toEqual(["JSON Web Token"]);
    // Before the token, close by.
    expect(types(`${link}<script>var s="${token}"</script>`, "html")).toEqual(["Shopify Shop Session Token"]);
    // A path that merely starts like it is not the sessions URL.
    expect(types(`<a href="https://shopifyinc.com/sessionsx">x</a><script>var s="${token}"</script>`, "html")).toEqual(["Shopify Shop Session Token"]);
    expect(types(`<a href="https://shopifyinc.com/other">x</a><script>var s="${token}"</script>`, "html")).toEqual(["JSON Web Token"]);
    // Extra claims, or ids of another type, are not the session token.
    for (const payload of [{ ...session, email: "a@acme.test" }, { ...session, client_id: 7 }, { ...session, unique_id: 7 }]) {
      expect([JSON.stringify(payload), types(`${link}<script>var s="${jwt(payload)}"</script>`, "html")]).toEqual([JSON.stringify(payload), ["JSON Web Token"]]);
    }
  });

  test("the Netlify beacon needs its attribute AND the netlify issuer AND only its own claims", () => {
    const attr = (token: string, quote = '"') => `<div data-netlify-cwv-token=${quote}${token}${quote}></div>`;
    expect(types(attr(jwt(claims)), "html")).toEqual(["Netlify Web Vitals Token"]);
    expect(types(attr(jwt(claims), "'"), "html")).toEqual(["Netlify Web Vitals Token"]);
    for (const iss of ["netlify.evil.test", "Netlify", "", undefined]) {
      const payload = iss === undefined ? { site_id: "a", account_id: "b", deploy_id: "c" } : { ...claims, iss };
      expect([String(iss), types(attr(jwt(payload)), "html")]).toEqual([String(iss), ["JSON Web Token"]]);
    }
    expect(types(attr(jwt({ ...claims, extra: 1 })), "html")).toEqual(["JSON Web Token"]);
  });

  test("a wallet token is public in any context, and only with its own claims of the right types", () => {
    for (const [location, url] of [
      ["html", PAGE],
      ["inline-script", PAGE],
      ["external-script", "https://evil.test/w.js"],
      ["external-script", "https://cdn.shopify.com/shopifycloud/w.js"],
    ] as const) {
      expect([location, url, found(`var w="${jwt(wallet)}";`, location, url)]).toEqual([location, url, [["Shopify Wallet Token", "medium", true]]]);
    }
    expect(types(`var w="${jwt({ ...wallet, merchantId: 58212 })}";`)).toEqual(["Shopify Wallet Token"]);
    for (const payload of [
      { ...wallet, merchantId: true },
      { ...wallet, merchantId: null },
      { ...wallet, merchantId: { id: 1 } },
      { ...wallet, merchantOrigin: 5 },
      { ...wallet, merchantOrigin: undefined },
      { ...wallet, email: "a@acme.test" },
      { ...wallet, permissions: ["x"] },
    ]) {
      expect([JSON.stringify(payload), types(`var w="${jwt(payload)}";`)]).toEqual([JSON.stringify(payload), ["JSON Web Token"]]);
    }
  });

  test("a platform bundle is skipped only as an external script", () => {
    const key = `var c={apiKey:"${runOf(seededRng(31), HEX, 32)}"};`;
    const url = "https://cdn.shopify.com/shopifycloud/portable-wallets/latest/x.js";
    expect(types(key, "external-script", url)).toEqual([]);
    expect(types(key, "inline-script", url)).toEqual(["Generic API Key Assignment"]);
    expect(types(key, "html", url)).toEqual(["Generic API Key Assignment"]);
  });

  test("on apps.shopify.com every api-key assignment is dropped, in markup or in a script: a first-party host rule", () => {
    const key = runOf(seededRng(32), HEX, 32);
    const host = "https://apps.shopify.com/some-app";
    for (const [text, location] of [
      [`<div data-api-key="${key}"></div>`, "html"],
      [`<div api-key="${key}"></div>`, "html"],
      [`var c={apiKey:"${key}"};`, "inline-script"],
      [`var c={api_key:"${key}"};`, "inline-script"],
      [`var c={apiKey:"${key}"};`, "external-script"],
    ] as const) {
      expect([text, location, types(text, location, host)]).toEqual([text, location, []]);
      // The same text on another host reports.
      expect([text, location, types(text, location, "https://shop.acme.test/").length]).toEqual([text, location, 1]);
    }
    // Only the api-key names: any other credential on the listing still reports.
    const other = mixedRun(seededRng(33), 24);
    expect(types(`var c={secret:"${other}",apiSecret:"${other}x"};`, "inline-script", host).length).toBeGreaterThan(0);
    expect(types(`var c={accessToken:"${mixedRun(seededRng(34), 40)}"};`, "inline-script", host)).toEqual(["Generic Token Assignment"]);
  });

  test("a search hint is for the search key only: every privileged word, and other names, get none", () => {
    const key = mixedRun(seededRng(35), 32);
    const hint = (name: string) => scanContent(`{"${name}":"${key}"}`, "inline-script", PAGE)[0]?.extra?.hint;
    for (const word of ["admin", "secret", "private", "write", "master", "management", "manage", "backend", "server", "root"]) {
      expect([word, hint(`search_${word}_api_key`)]).toEqual([word, undefined]);
      expect([word, hint(`${word}SearchApiKey`)]).toEqual([word, undefined]);
    }
    expect(typeof hint("searchApiKey")).toBe("string");
    expect(typeof hint("typesense_search_api_key")).toBe("string");
    expect(hint("apiKey")).toBeUndefined();
    expect(hint("research_api_key")).toBeUndefined();
  });
});

describe("survivors pinned in the delta review (#1287, #1229)", () => {
  const wallet = { iat: 1761000000, merchantId: "58212", merchantOrigin: "https://shop.acme.test", expiresAt: 1761003600 };
  const session = { client_id: "a1b2c3", client_account_id: "99", unique_id: "u-17", iat: 1761000000 };
  const claims = { site_id: "a", account_id: "b", deploy_id: "c", iss: "netlify", iat: 1761000000 };
  const types = (text: string, location: SecretLocation = "inline-script", url = PAGE) => found(text, location, url).map((f) => f[0]); // pragma: allowlist secret

  test("the Netlify token counts only in the attribute it is the value of", () => {
    const token = jwt(claims);
    // spaces around the equals sign, any case, a single quote or none
    for (const attr of [`data-netlify-cwv-token = "${token}"`, `DATA-NETLIFY-CWV-TOKEN="${token}"`, `data-netlify-cwv-token='${token}'`, `data-netlify-cwv-token=${token}`]) {
      expect([attr.slice(0, 40), types(`<div ${attr}></div>`, "html")]).toEqual([attr.slice(0, 40), ["Netlify Web Vitals Token"]]);
    }
    // another attribute after it, a value before the token, or the name merely nearby: an ordinary JWT
    for (const html of [
      `<div data-netlify-cwv-token="x" data-other="${token}"></div>`,
      `<div data-netlify-cwv-token="not the token ${token}"></div>`,
      `<div data-netlify-cwv-token data-other="${token}"></div>`,
      `<div data-netlify-cwv-tokens="${token}"></div>`,
      `<!-- data-netlify-cwv-token --><div data-x="${token}"></div>`,
    ]) {
      expect([html.slice(0, 50), types(html, "html")]).toEqual([html.slice(0, 50), ["JSON Web Token"]]);
    }
  });

  test("a store's platform bundle path is /cdn/shopifycloud/ on a myshopify.com host, not the bare /shopifycloud/", () => {
    const key = `var c={apiKey:"${runOf(seededRng(41), HEX, 32)}"};`;
    expect(types(key, "external-script", "https://acme.myshopify.com/cdn/shopifycloud/portable-wallets/x.js")).toEqual([]);
    for (const url of [
      "https://acme.myshopify.com/shopifycloud/portable-wallets/x.js",
      "https://acme.myshopify.com/cdn/shop/t/1/assets/shopifycloud.js",
      "https://acme.myshopify.com/cdn/shopifycloudx/x.js",
      "https://acme.myshopify.com/x/cdn/shopifycloud/x.js",
    ]) {
      expect([url, types(key, "external-script", url)]).toEqual([url, ["Generic API Key Assignment"]]);
    }
    // and the bare path is the CDN host's, not a store's
    expect(types(key, "external-script", "https://cdn.shopify.com/shopifycloud/x.js")).toEqual([]);
  });

  test("every registered claim is allowed on a platform token, and `exp` too; any other claim is not", () => {
    const registered = { iss: "https://a.test", aud: "x", iat: 1761000000, exp: 1961003600, nbf: 1761000000, jti: "j1", sub: "s1" };
    for (const [name, value] of Object.entries(registered)) {
      expect([name, types(`var w="${jwt({ ...wallet, [name]: value })}";`)]).toEqual([name, ["Shopify Wallet Token"]]);
      expect([name, types(`<a href="https://shopifyinc.com/sessions">x</a><script>var s="${jwt({ ...session, [name]: value })}"</script>`, "html")]).toEqual([name, ["Shopify Shop Session Token"]]);
      // (the Netlify token's own issuer is fixed: overriding `iss` is a different token)
      if (name !== "iss") expect([name, types(`<div data-netlify-cwv-token="${jwt({ ...claims, [name]: value })}"></div>`, "html")]).toEqual([name, ["Netlify Web Vitals Token"]]);
    }
    for (const claim of ["email", "name", "azp", "scp", "typ", "kid"]) {
      expect([claim, types(`var w="${jwt({ ...wallet, [claim]: "x" })}";`)]).toEqual([claim, ["JSON Web Token"]]);
    }
  });
});
