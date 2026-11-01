// security/leaked-secrets: signed-URL tokens and browser SDK or widget keys are
// public by design (#1293, #1294). Each block pairs what drops out of the leak
// tiers with the real-shaped control that must still report. Synthetic values,
// built at runtime.

import { describe, expect, test } from "bun:test";

import { scanContent, type SecretLocation } from "../../src/security/leaked-secrets";
import { issuerJwt, mixedRun, runOf, seededRng } from "./leaked-secrets/generators";

const HEX = "0123456789abcdef";
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PAGE = "https://app.acme.test/";
const r = seededRng(1293);

function found(text: string, location: SecretLocation = "inline-script", url = PAGE) { // pragma: allowlist secret
  return scanContent(text, location, url).map((f) => [f.type, f.confidence, f.publicByDesign]);
}

describe("signed-URL tokens (#1293)", () => {
  const grant = issuerJwt(r, { url: "avatars/a.png", iat: 1761000000, exp: 1961003600 });
  const storage = "https://abc.supabase.co/storage/v1/object/sign/avatars/a.png";

  test("a JWT that is the value of a URL query parameter is labelled a signed-URL grant, still reported at medium with its expiry", () => {
    const where: Array<[string, SecretLocation]> = [
      [`<img src="${storage}?token=${grant}">`, "html"],
      [`<meta property="og:image" content="${storage}?token=${grant}&w=1">`, "html"],
      [`<img srcset="${storage}?token=${grant} 1x, ${storage}?token=${grant} 2x">`, "html"],
      [`var d={"img":"https://cdn.acme.test/a.png?jwt=${grant}"};`, "inline-script"],
      [`var u="https://cdn.acme.test/a.png?x=1&sig=${grant}";`, "inline-script"],
      [`var u="https://cdn.acme.test/a.png?signature=${grant}";`, "inline-script"],
    ];
    for (const [text, location] of where) {
      const reported = found(text, location);
      expect(reported.length).toBeGreaterThan(0);
      expect(reported.every((f) => f[0] === "Signed URL Token (JWT)" && f[1] === "medium" && f[2] === false)).toBe(true);
    }
  });

  test("the same token outside a URL parameter is a JWT as before", () => {
    expect(found(`var t="${grant}";`)).toEqual([["JSON Web Token", "medium", false]]);
    expect(found(`var u="https://cdn.acme.test/a.png?other=${grant}";`)).toEqual([["JSON Web Token", "medium", false]]);
  });

  test("a service_role key, an admin token and an sb_secret_ key still report inside a URL", () => {
    const serviceRole = issuerJwt(r, { iss: "supabase", role: "service_role", ref: "abc", exp: 1961003600 });
    expect(found(`var u="${storage}?token=${serviceRole}";`)).toEqual([["Supabase Service Role JWT", "high", false]]);
    const admin = issuerJwt(r, { sub: "u1", scope: "admin", exp: 1961003600 });
    expect(found(`var u="https://cdn.acme.test/x?token=${admin}";`)).toEqual([["JSON Web Token (admin scope)", "high", false]]);
    const secret = "sb_" + "secret_" + runOf(r, ALNUM, 28); // pragma: allowlist secret
    expect(found(`var u="https://abc.supabase.co/x?token=${secret}";`).map((f) => f[0])).toEqual(["Supabase Secret Key"]);
  });

  test("a user or session JWT in a URL parameter is not a storage grant: no url claim and no sign path", () => {
    const session = issuerJwt(r, { sub: "u1", email: "a@acme.test", exp: 1961003600 });
    expect(found(`var u="https://app.acme.test/cb?token=${session}";`)).toEqual([["JSON Web Token", "medium", false]]);
    expect(found(`var u="https://app.acme.test/cb?access_token=${session}";`)).toEqual([["JSON Web Token", "medium", false]]);
    // The storage sign path alone is not enough either: a token with no url claim is not a grant.
    expect(found(`var u="${storage}?token=${session}";`)).toEqual([["JSON Web Token", "medium", false]]);
  });

  test("a token with no expiry in a URL parameter is a long-lived credential, not a signed grant", () => {
    const forever = issuerJwt(r, { url: "avatars/a.png", iat: 1761000000 });
    expect(found(`var u="https://cdn.acme.test/a.png?token=${forever}";`)).toEqual([["JSON Web Token", "medium", false]]);
  });

  test("a role-carrying token in a URL parameter is not waved through", () => {
    const authenticated = issuerJwt(r, { sub: "u1", role: "authenticated", exp: 1961003600 });
    expect(found(`var u="https://cdn.acme.test/x?token=${authenticated}";`).map((f) => f[0])).not.toContain("Signed URL Token (JWT)");
  });
});

describe("the signed-URL label needs the claim, the expiry and the parameter (#1293)", () => {
  const exp = 1961003600;
  const grant = (extra: object = {}) => issuerJwt(r, { url: "avatars/a.png", iat: 1761000000, exp, ...extra });
  const types = (text: string) => found(text).map((f) => f[0]);

  test("a url claim, an expiry and a URL parameter name are all required, on any host: still medium, never public", () => {
    for (const url of ["https://abc.supabase.co/storage/v1/object/sign/a/b.png", "https://evil.test/x.png", "https://cdn.acme.test/a.png"]) {
      expect(found(`var u="${url}?token=${grant()}";`)).toEqual([["Signed URL Token (JWT)", "medium", false]]);
    }
    // each part missing in turn
    expect(types(`var u="https://x.test/a.png?token=${issuerJwt(r, { iat: 1761000000, exp })}";`)).toEqual(["JSON Web Token"]);
    expect(types(`var u="https://x.test/a.png?token=${issuerJwt(r, { url: "a/b.png", iat: 1761000000 })}";`)).toEqual(["JSON Web Token"]);
    expect(types(`var u="https://x.test/a.png?name=${grant()}";`)).toEqual(["JSON Web Token"]);
    expect(types(`var u="https://x.test/a.png?token=${grant({ url: 5 })}";`)).toEqual(["JSON Web Token"]);
  });

  test("an API or user token inside a sign path is not a grant", () => {
    const sign = "https://abc.supabase.co/storage/v1/object/sign/avatars/a.png";
    for (const payload of [{ sub: "u1", exp }, { sub: "u1", email: "a@acme.test", exp }, { iss: "https://acme.test", exp }]) {
      expect([JSON.stringify(payload), types(`var u="${sign}?token=${issuerJwt(r, payload)}";`)]).toEqual([JSON.stringify(payload), ["JSON Web Token"]]);
    }
  });

  test("a role or an admin scope on a token with a url claim keeps its own classification", () => {
    const sign = "https://abc.supabase.co/storage/v1/object/sign/avatars/a.png";
    expect(types(`var u="${sign}?token=${grant({ role: "authenticated" })}";`)).not.toContain("Signed URL Token (JWT)");
    expect(found(`var u="${sign}?token=${grant({ scope: "admin" })}";`)).toEqual([["JSON Web Token (admin scope)", "high", false]]);
    expect(found(`var u="${sign}?token=${grant({ iss: "supabase", role: "service_role", ref: "abc" })}";`)).toEqual([["Supabase Service Role JWT", "high", false]]);
    expect(found(`var u="${sign}?token=${grant({ iss: "supabase", role: "anon", ref: "abc" })}";`)).toEqual([["Supabase Anon Key", "medium", true]]);
    expect(found(`var u="${sign}?token=${grant({ iss: "supabase", ref: "abc" })}";`)).toEqual([["Signed URL Token (JWT)", "medium", false]]);
    // an admin scope on a Supabase-issued token with a url claim is not relabelled a grant
    expect(found(`var u="${sign}?token=${grant({ iss: "supabase", ref: "abc", scope: "admin" })}";`)).toEqual([["Supabase JWT", "medium", false]]);
  });

  test("the classifications that come first keep winning: a platform token, a Hygraph token, an expired one", () => {
    const shopify = grant({ iss: "https://acme.myshopify.com" });
    expect(found(`var u="https://cdn.acme.test/a.png?token=${shopify}";`)).toEqual([["Shopify Storefront JWT", "medium", true]]);
    const wallet = issuerJwt(r, { iat: 1761000000, merchantId: "58212", merchantOrigin: "https://shop.acme.test", expiresAt: exp });
    expect(types(`var u="https://cdn.acme.test/a.png?token=${wallet}";`)).toEqual(["Shopify Wallet Token"]);
    const hygraph = grant({ iss: "https://management-eu.hygraph.com/graphql" });
    expect(types(`var u="https://cdn.acme.test/a.png?token=${hygraph}";`)).toEqual(["Hygraph Management Token"]);
    const expired = issuerJwt(r, { url: "a/b.png", iat: 1500000000, exp: 1500003600 });
    expect(found(`var u="https://cdn.acme.test/a.png?token=${expired}";`)).toEqual([["JSON Web Token (expired)", "info", false]]);
  });
});

describe("the issuer claim is shown bounded and without credentials (#1293)", () => {
  test("a URL issuer loses userinfo, query and fragment; a long issuer is cut", () => {
    const hostile = issuerJwt(r, { iss: "https://user:" + "Xk9mQ2vL8z" + "@auth.acme.test/realm?token=abc#frag", sub: "u", exp: 1961003600 });
    const [a] = scanContent(`var t="${hostile}";`, "inline-script", PAGE);
    expect(a?.extra?.issuer).toBe("https://auth.acme.test/realm");
    const long = issuerJwt(r, { iss: "i".repeat(5000), sub: "u", exp: 1961003600 });
    const [b] = scanContent(`var t="${long}";`, "inline-script", PAGE);
    expect(String(b?.extra?.issuer).length).toBeLessThanOrEqual(203);
  });
});

describe("the signed-URL label carries its evidence (#1293)", () => {
  test("expiresAt and a hint ride along, and the output keeps the finding", () => {
    const grant = issuerJwt(r, { url: "a/b.png", iat: 1761000000, exp: 1961003600 });
    const [finding] = scanContent(`var u="https://cdn.acme.test/a.png?token=${grant}";`, "inline-script", PAGE);
    expect(finding?.extra).toMatchObject({ kind: "signed-url", expired: false, expiresAt: expect.any(String), hint: expect.stringContaining("valid until") });
  });
});

describe("browser SDK keys (#1294)", () => {
  const key = () => mixedRun(r, 32);

  test("a key in the init call of a browser SDK whose key is public is public", () => {
    for (const [sdk, type] of [
      ["Bugsnag.start", "Bugsnag API Key"],
      ["amplitude.getInstance().init", "Amplitude API Key"],
    ] as const) {
      expect(found(`${sdk}({apiKey:"${key()}"});`)).toEqual([[type, "medium", true]]);
    }
    expect(found(`window.bugsnag={apiKey:"${key()}"};`)).toEqual([["Bugsnag API Key", "medium", true]]);
  });

  test("SDKs whose apiKey is the secret key, or whose id has no distinctive shape, are not claimed", () => {
    for (const text of [
      `datadogSetup({apiKey:"${key()}"});`,
      `new Rollbar({accessToken:"${key()}"});`,
      `Crisp.configure({apiKey:"${key()}"});`,
      `Tawk_API.init({apiKey:"${key()}"});`,
    ]) {
      expect([text.slice(0, 30), found(text).every((f) => f[2] === false)]).toEqual([text.slice(0, 30), true]);
    }
  });

  test("the brand word nearby, in a comment or a sibling, is not the enclosing call", () => {
    for (const text of [
      `// bugsnag, clean config\nvar sendgrid={apiKey:"${key()}"};`,
      `/* amplitude */ var svc={apiKey:"${key()}"};`,
      `Bugsnag.start({other:1}); var svc={apiKey:"${key()}"};`,
      `var bugsnagish=1,svc={apiKey:"${key()}"};`,
    ]) {
      expect([text.slice(0, 30), found(text)]).toEqual([text.slice(0, 30), [["Generic API Key Assignment", "medium", false]]]);
    }
  });

  test("the same assignment with no SDK around it is still a generic key", () => {
    expect(found(`var cfg={apiKey:"${key()}"};`)).toEqual([["Generic API Key Assignment", "medium", false]]);
  });
});

describe("widget embed attributes (#1294)", () => {
  const widget = (attrs: string) => `<script src="https://widget.acme-chat.test/w.js" ${attrs}></script>`;

  test("a data-*-api-key on a third-party script tag is public client config", () => {
    expect(found(widget(`data-api-key="${mixedRun(r, 32)}"`), "html")).toEqual([["Third-party Widget Key", "medium", true]]);
    expect(found(widget(`data-widget-api-key="${mixedRun(r, 32)}"`), "html")).toEqual([["Third-party Widget Key", "medium", true]]);
  });

  test("a secret-named attribute is not claimed, on a third-party script or any other", () => {
    for (const attr of ["data-secret", "data-tb-secret", "data-client-secret", "data-password", "data-aws-secret"]) {
      const reported = found(widget(`${attr}="${mixedRun(r, 32)}"`), "html");
      expect([attr, reported.length > 0 && reported.every((f) => f[2] === false)]).toEqual([attr, true]);
    }
  });

  test("a privileged word anywhere in the attribute name, not just its last segment, keeps the finding a leak", () => {
    for (const attr of ["data-admin-api-key", "data-secret-api-key", "data-server-api-key", "data-private-access-token", "data-service-api-key", "data-master-api-key"]) {
      const reported = found(widget(`${attr}="${mixedRun(r, 32)}"`), "html");
      expect([attr, reported.length > 0 && reported.every((f) => f[0] !== "Third-party Widget Key" && f[2] === false)]).toEqual([attr, true]);
    }
  });

  test("on a first-party script, or with a secret-prefixed value, they still report", () => {
    expect(found(`<script src="/app.js" data-api-key="${mixedRun(r, 32)}"></script>`, "html").map((f) => f[2])).toEqual([false]);
    const live = "sk_" + "live_" + runOf(r, ALNUM, 24);
    expect(found(widget(`data-api-key="${live}"`), "html")).toEqual([["Stripe Live Key", "high", false]]);
  });
});

describe("RevenueCat public SDK keys (#1294)", () => {
  test("each store prefix reports as public beside the SDK's name", () => {
    for (const prefix of ["app" + "l_", "goo" + "g_", "amz" + "n_", "str" + "p_", "rc" + "b_"]) {
      expect(found(`Purchases.configure({apiKey:"${prefix}7${runOf(r, ALNUM, 31)}"});`)).toEqual([["RevenueCat Public SDK Key", "medium", true]]);
      expect(found(`var revenuecat={key:"${prefix}7${runOf(r, ALNUM, 31)}"};`)).toEqual([["RevenueCat Public SDK Key", "medium", true]]);
    }
  });

  test("without the SDK's name beside it the shape is nothing: no finding", () => {
    expect(found(`var a="${"goo" + "g_"}ModuleLoaderConfigurationData1xx";`)).toEqual([]);
    expect(found(`var a="${"app" + "l_"}7${runOf(r, ALNUM, 31)}";`)).toEqual([]);
  });

  test("an identifier with the prefix, a short tail and a digit-less tail are not keys", () => {
    for (const js of [`var a="${"goo" + "g_"}analyticsconfigurationoptionname";`, `var a="${"app" + "l_"}${runOf(r, ALNUM, 10)}";`, `var a="my${"app" + "l_"}7${runOf(r, ALNUM, 31)}";`]) {
      expect(found(js).map((f) => f[0])).not.toContain("RevenueCat Public SDK Key");
    }
  });
});

describe("SDK keys: the immediately enclosing call, and the RevenueCat bounds (#1294)", () => {
  const key = () => mixedRun(r, 32);
  const ids = (text: string, location: SecretLocation = "inline-script") => found(text, location).map((f) => `${f[0]}/${f[2]}`); // pragma: allowlist secret

  test("the SDK must be the enclosing call: nested objects that closed do not hide it, a nested one that is open does", () => {
    expect(ids(`Bugsnag.start({other:{x:1},apiKey:"${key()}"});`)).toEqual(["Bugsnag API Key/true"]);
    expect(ids(`Bugsnag.start({plugins:{apiKey:"${key()}"}});`)).toEqual(["Generic API Key Assignment/false"]);
    expect(ids(`foo(bugsnag, {apiKey:"${key()}"});`)).toEqual(["Generic API Key Assignment/false"]);
    expect(ids(`amplitude.getInstance().init("x", {apiKey:"${key()}"});`)).toEqual(["Amplitude API Key/true"]);
    expect(ids(`amplitude.init(fn(), {apiKey:"${key()}"});`)).toEqual(["Generic API Key Assignment/false"]);
    expect(ids(`bugsnag: {apiKey:"${key()}"}`)).toEqual(["Bugsnag API Key/true"]);
  });

  test("the SDK read stops 240 characters back: a key further into the object is a generic key", () => {
    expect(ids(`Bugsnag.start({${"a:1,".repeat(70)}apiKey:"${key()}"});`)).toEqual(["Generic API Key Assignment/false"]);
    expect(ids(`Bugsnag.start({${"a:1,".repeat(20)}apiKey:"${key()}"});`)).toEqual(["Bugsnag API Key/true"]);
  });

  test("a RevenueCat key has a 28 to 40 character tail with a digit in its first 40", () => {
    const prefix = "app" + "l_";
    const rc = (tail: string) => ids(`Purchases.configure({apiKey:"${prefix}${tail}"});`);
    const letters = "abcdefghijklmnopqrstuvwxyz";
    expect(rc("7" + runOf(r, ALNUM, 27))).toEqual(["RevenueCat Public SDK Key/true"]);
    expect(rc("7" + runOf(r, ALNUM, 39))).toEqual(["RevenueCat Public SDK Key/true"]);
    expect(rc(runOf(r, letters, 27) + "9")).toEqual(["RevenueCat Public SDK Key/true"]);
    expect(rc(runOf(r, letters, 39) + "9")).toEqual(["RevenueCat Public SDK Key/true"]);
    // 27 characters, a tail with no digit, and a digit only past the 40th character
    expect(rc("7" + runOf(r, ALNUM, 26))).toEqual(["Generic API Key Assignment/false"]);
    expect(rc(runOf(r, letters, 28))).toEqual(["Generic API Key Assignment/false"]);
    expect(rc(runOf(r, letters, 40) + "9").includes("RevenueCat Public SDK Key/true")).toBe(false);
  });

  test("data-*-api-key attributes naming Bugsnag, Amplitude or RevenueCat are public only on a third-party script tag", () => {
    const third = (attrs: string) => `<script src="https://widget.acme-chat.test/w.js" ${attrs}></script>`;
    expect(ids(third(`data-bugsnag-api-key="${key()}"`), "html")).toEqual(["Third-party Widget Key/true"]);
    expect(ids(third(`data-amplitude-api-key="${key()}"`), "html")).toEqual(["Third-party Widget Key/true"]);
    expect(ids(third(`data-revenuecat-api-key="${"app" + "l_"}7${runOf(r, ALNUM, 31)}"`), "html")).toEqual(["RevenueCat Public SDK Key/true"]);
    expect(ids(`<script src="/own.js" data-bugsnag-api-key="${key()}"></script>`, "html")).toEqual(["Generic API Key Assignment/false"]);
  });
});

describe("keys that are public by what they are called (#1294)", () => {
  const value = () => mixedRun(r, 32);

  test("a public-looking name earns a hint, not a downgrade: the finding stays medium and visible", () => {
    const keys = ["NEXT_PUBLIC_MAPS_API_KEY", "VITE_ORDERS_API_KEY", "PUBLIC_SEARCH_API_KEY", "publicApiKey", "publishable_api_key", "clientSideApiKey"];
    for (const name of keys) {
      const [finding] = scanContent(`var e={${name}:"${value()}"};`, "inline-script", PAGE);
      expect([name, finding?.type, finding?.confidence, finding?.publicByDesign, typeof finding?.extra?.hint]).toEqual([name, "Generic API Key Assignment", "medium", false, "string"]);
    }
  });

  test("a public-looking name never removes a classification a brand, Shopify or a widget already made", () => {
    const k = mixedRun(r, 32);
    expect(found(`posthog.init({publicApiKey:"${k}"});`)).toEqual([["PostHog Project Key", "medium", true]]);
    expect(found(`var c={sentry:{publicApiKey:"${k}"}};`)).toEqual([["Sentry Client Key", "medium", true]]);
    expect(found(`var e={NEXT_PUBLIC_POSTHOG_API_KEY:"${k}"};`)).toEqual([["PostHog Project Key", "medium", true]]);
  });

  test("a secret-prefixed value is not rescued by its key name", () => {
    const live = "sk_" + "live_" + runOf(r, ALNUM, 24);
    expect(found(`var e={NEXT_PUBLIC_X_API_KEY:"${live}"};`)).toEqual([["Stripe Live Key", "high", false]]);
    expect(found(`var e={VITE_API_KEY:"${"sb_" + "secret_"}${runOf(r, ALNUM, 28)}"};`).map((f) => f[0])).toEqual(["Supabase Secret Key"]);
  });

  test("a secret under a public name (a database URL, a private key, a webhook secret) is reported like any other", () => {
    expect(found(`var e={NEXT_PUBLIC_SECRET_KEY:"${value()}",VITE_PASSWORD:"${"Xk9!" + "mQ2vL8zP"}"};`).every((f) => f[2] === false)).toBe(true); // pragma: allowlist secret
  });

  test("a client_secret, a private key name and an unrelated name are not public", () => {
    for (const name of ["client_secret_key", "publicPrivateApiKey", "myApiKey"]) {
      expect([name, found(`var e={${name}:"${value()}"};`).map((f) => f[2])]).toEqual([name, [false]]);
    }
  });
});

describe("AWS access key ids (#1294)", () => {
  const id = "AKIA" + "ABCDEFGHJKLMNPQR"; // pragma: allowlist secret
  const secret = mixedRun(r, 40);

  test("an id with no secret within 300 characters is the public half: medium, visible, with a note", () => {
    expect(found(`var c={accessKeyId:"${id}"};`)).toEqual([["AWS Access Key ID", "medium", false]]);
    expect(scanContent(`var c={accessKeyId:"${id}"};`, "inline-script", PAGE)[0]?.extra).toHaveProperty("pair");
    expect(found(`var c={accessKeyId:"${id}"};${" ".repeat(400)}var s={aws_secret_access_key:"${secret}"};`)[0]).toEqual(["AWS Access Key ID", "medium", false]);
  });

  test("any 40-character secret-shaped value near the id keeps it high, keyed or not", () => {
    for (const text of [
      `var k=["${id}","${secret}"];`,
      `var c={id:"${id}",secret:"${secret}"};`,
      `var c={a:"${id}"${" ".repeat(250)},b:"${secret}"};`,
    ]) {
      expect([text.slice(0, 30), found(text).find((f) => f[0] === "AWS Access Key ID")?.[1]]).toEqual([text.slice(0, 30), "high"]);
    }
  });

  test("the common unquoted env layout keeps the id high: KEY=value on the next line", () => {
    for (const text of [
      `AWS_ACCESS_KEY_ID=${id}\nAWS_SECRET_ACCESS_KEY=${secret}\n`,
      `aws_access_key_id = ${id}\naws_secret_access_key=${secret}`,
      `?id=${id}&secret=${secret}`,
    ]) {
      expect([text.slice(0, 30), found(text, "html").find((f) => f[0] === "AWS Access Key ID")?.[1]]).toEqual([text.slice(0, 30), "high"]);
    }
  });

  test("an id beside its secret key stays high and the secret is reported", () => {
    const types = found(`var c={accessKeyId:"${id}",aws_secret_access_key:"${secret}"};`);
    expect(types).toContainEqual(["AWS Access Key ID", "high", false]);
    expect(types.map((t) => t[0])).toContain("AWS Secret Access Key");
    expect(found(`var c={aws_secret_access_key:"${secret}",accessKeyId:"${id}"};`)).toContainEqual(["AWS Access Key ID", "high", false]);
  });

  test("an AWS-shaped token that runs on past its format keeps its unknown-provider label", () => {
    expect(found(`var c={id:"${id}_PROD"};`)[0]?.[0]).toBe("Secret Key (provider unknown)");
  });
});

describe("the new checks stay linear on adversarial input", () => {
  test("a megabyte of query-parameter JWT leads, widget attributes and key names", () => {
    const inputs = [
      "?token=eyJ".repeat(100000),
      `<script src="https://w.test/x.js" ${"data-a-secret=\"x\" ".repeat(40000)}></script>`,
      `NEXT_PUBLIC_${"A_".repeat(200)}KEY:"${runOf(r, ALNUM, 32)}",`.repeat(2500),
      `AKIA${"ABCDEFGHJKLMNPQR"} `.repeat(40000),
    ];
    for (const text of inputs) {
      const start = performance.now();
      scanContent(text, "external-script", PAGE);
      expect(performance.now() - start).toBeLessThan(5000);
    }
  });
});
