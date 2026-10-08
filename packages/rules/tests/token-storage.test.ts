// security/token-storage: auth tokens written to localStorage or sessionStorage.
//
// The no-false-positive fixtures carry more weight than the detection cases: web
// storage is full of theme, cart and UI state, and a key with `session` or `auth`
// in it is usually one of those.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { rules as securityRules } from "../src/security";
import {
  findTokenStorageWrites,
  isJwtShaped,
  isThirdPartyScript,
  isTokenKey,
  tokenStorageRule,
} from "../src/security/token-storage";
import { loadAllRules } from "../src/loader";
import type { ParsedPage, RuleContext } from "../src/types";

// Not a credential: a decodable header and payload with a made-up signature.
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLWZpeHR1cmU"; // pragma: allowlist secret

const PAGE = "https://shop.test/account";
const html = (inline = "") =>
  `<html><head><title>t</title></head><body><script>${inline}</script></body></html>`;

function run(inline: string, scripts: Array<{ url: string; content: string; sourcePages: string[] }> = [], url = PAGE) {
  const { document } = parseHTML(html(inline));
  const ctx = {
    page: { url, html: html(inline), statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as unknown as ParsedPage,
    options: {},
    site: {
      scripts: scripts.map((s) => ({
        status: 200,
        error: null,
        contentType: "application/javascript",
        sizeBytes: s.content.length,
        ...s,
      })),
    },
  } as unknown as RuleContext;
  return tokenStorageRule.run(ctx).checks;
}

const keys = (text: string) => findTokenStorageWrites(text).map((w) => `${w.storage}:${w.key}:${w.reason}`);

describe("jwt-and-auth-keys-flagged", () => {
  test.each([
    ['localStorage.setItem("token", t)', "localStorage:token:key-name"],
    ["localStorage.setItem('access_token', res.access)", "localStorage:access_token:key-name"],
    ['sessionStorage.setItem("jwt", data.jwt)', "sessionStorage:jwt:key-name"],
    ['localStorage.setItem("accessToken", a)', "localStorage:accessToken:key-name"],
    ['localStorage.setItem("id_token", a)', "localStorage:id_token:key-name"],
    ['localStorage.setItem("refreshToken", a)', "localStorage:refreshToken:key-name"],
    ['localStorage.setItem("auth", JSON.stringify(u))', "localStorage:auth:key-name"],
    ['sessionStorage.setItem("session", sid)', "sessionStorage:session:key-name"],
    ['localStorage.setItem("session_id", sid)', "localStorage:session_id:key-name"],
    ['localStorage.setItem("authUser", u)', "localStorage:authUser:key-name"],
    ['window.localStorage.setItem("app:token", t)', "localStorage:app:token:key-name"],
    ['localStorage["token"] = t', "localStorage:token:key-name"],
    ["sessionStorage['authToken']=t", "sessionStorage:authToken:key-name"],
    ["localStorage.token = t", "localStorage:token:key-name"],
    ["window.sessionStorage.jwt = t", "sessionStorage:jwt:key-name"],
  ])("%s", (code, expected) => {
    expect(keys(code)).toEqual([expected]);
  });

  test("a JWT-shaped literal value is flagged under any key", () => {
    expect(keys(`localStorage.setItem("u", "${JWT}")`)).toEqual(["localStorage:u:jwt-value"]);
    expect(keys(`sessionStorage["x"] = '${JWT}'`)).toEqual(["sessionStorage:x:jwt-value"]);
  });

  test("a JWT written under a computed key is flagged without a key", () => {
    expect(keys(`localStorage.setItem(KEY + "_v", "${JWT}")`)).toEqual(["localStorage:null:jwt-value"]);
  });

  test("an inline script and an external script are both read", () => {
    const checks = run('localStorage.setItem("token", t)', [
      { url: "https://shop.test/app.js", content: 'sessionStorage.setItem("jwt", j)', sourcePages: [PAGE] },
    ]);
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.status === "warn")).toBe(true);
    expect(checks.map((c) => c.items!.map((i) => i.id))).toEqual([
      [`${PAGE}: localStorage["token"] (key-name)`],
      ['https://shop.test/app.js: sessionStorage["jwt"] (key-name)'],
    ]);
  });

  test("isJwtShaped needs three parts and eyJ headers", () => {
    expect(isJwtShaped(JWT)).toBe(true);
    expect(isJwtShaped("eyJhbGciOiJIUzI1NiJ9")).toBe(false);
    expect(isJwtShaped("abc.def.ghi")).toBe(false);
  });
});

describe("non-sensitive-storage-not-flagged", () => {
  test.each([
    'localStorage.setItem("theme", "dark")',
    'localStorage.setItem("cart", JSON.stringify(items))',
    'localStorage.setItem("ui_state", s)',
    'localStorage.setItem("session_theme", "dark")',
    'sessionStorage.setItem("auth_banner_dismissed", "1")',
    'localStorage.setItem("authority", a)',
    'localStorage.setItem("tokenizer", a)',
    'localStorage.setItem("csrf_token", c)',
    'localStorage.setItem("next_page_token", c)',
    'localStorage.setItem("push_token", c)',
    'localStorage.setItem("token_expires_at", String(Date.now()))',
    'localStorage.setItem("session_start_time", String(Date.now()))',
    'localStorage.setItem("lang", "en")',
    'localStorage.setItem("cookie_consent", "1")',
    'localStorage["theme"] = "dark"',
    "localStorage.theme = 'dark'",
    'sessionStorage.setItem("authBannerSeen", "1")',
  ])("%s", (code) => {
    expect(keys(code)).toEqual([]);
  });

  test("reads, removals and comparisons are not writes", () => {
    expect(keys('localStorage.getItem("token")')).toEqual([]);
    expect(keys('localStorage.removeItem("token")')).toEqual([]);
    expect(keys('if (localStorage.token == null) {}')).toEqual([]);
    expect(keys('const f = () => localStorage.token => 1')).toEqual([]);
    expect(keys('localStorage.clear()')).toEqual([]);
  });

  test("clearing a token key writes no credential", () => {
    expect(keys('localStorage.setItem("token", "")')).toEqual([]);
    expect(keys('localStorage.setItem("token", null)')).toEqual([]);
    expect(keys('localStorage.setItem("auth", "false")')).toEqual([]);
  });

  test("another object's setItem and a lookalike name are ignored", () => {
    expect(keys('myStore.setItem("token", t)')).toEqual([]);
    expect(keys('$localStorage.token = t')).toEqual([]);
    expect(keys('mylocalStorage.setItem("token", t)')).toEqual([]);
  });

  test("a page with no web storage passes", () => {
    const checks = run("var theme = 'dark'; localStorage.setItem('theme', theme);");
    expect(checks).toEqual([
      expect.objectContaining({ name: "token-storage", status: "pass" }),
    ]);
  });

  test("a JSON data block is not executed code", () => {
    const { document } = parseHTML(
      `<html><body><script type="application/json">{"a":"localStorage.setItem('token', t)"}</script></body></html>`,
    );
    const checks = tokenStorageRule.run({
      page: { url: PAGE, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: { document } as unknown as ParsedPage,
      options: {},
    } as unknown as RuleContext).checks;
    expect(checks[0]!.status).toBe("pass");
  });
});

describe("isTokenKey", () => {
  test("segments decide, not substrings", () => {
    expect(isTokenKey("token")).toBe(true);
    expect(isTokenKey("X-Auth-Token")).toBe(true);
    expect(isTokenKey("authUser")).toBe(true);
    expect(isTokenKey("authority")).toBe(false);
    expect(isTokenKey("session_theme")).toBe(false);
    expect(isTokenKey("auth_banner_dismissed")).toBe(false);
    expect(isTokenKey("")).toBe(false);
  });
});

describe("finding-redacts-value", () => {
  test("names the script and the key and never prints the value", () => {
    const checks = run(
      "",
      [
        {
          url: "https://shop.test/static/app.js",
          content: `localStorage.setItem("access_token", res.token); sessionStorage.setItem("u", "${JWT}");`,
          sourcePages: [PAGE],
        },
      ],
    );
    expect(checks).toHaveLength(1);
    const check = checks[0]!;
    expect(check.status).toBe("warn");
    expect(check.message).toContain("https://shop.test/static/app.js");
    expect(check.message).toContain('"access_token"');
    expect(JSON.stringify(checks)).not.toContain("eyJ");
    expect(JSON.stringify(checks)).not.toContain(JWT.split(".")[2]!);
    expect(check.items!.map((i) => i.meta)).toEqual([
      expect.objectContaining({ storage: "localStorage", key: "access_token", reason: "key-name" }),
      expect.objectContaining({ storage: "sessionStorage", key: "u", reason: "jwt-value" }),
    ]);
  });

  test("a JWT in the key position is not echoed", () => {
    const w = findTokenStorageWrites(`localStorage.setItem("${JWT}", "${JWT}")`);
    expect(JSON.stringify(w)).not.toContain("eyJ");
  });
});

describe("third-party scripts", () => {
  const vendor = {
    url: "https://cdn.vendor.test/sdk.js",
    content: 'localStorage.setItem("session_id", s)',
    sourcePages: [PAGE],
  };

  test("a script from another registrable domain is labelled third-party", () => {
    const checks = run("", [vendor]);
    expect(checks[0]!.status).toBe("warn");
    expect(checks[0]!.message).toContain("third-party script https://cdn.vendor.test/sdk.js");
    expect(checks[0]!.items![0]!.meta).toMatchObject({ thirdParty: true });
    expect(checks[0]!.items![0]!.label).toContain("third-party script");
  });

  test("a first-party CDN subdomain is not labelled third-party", () => {
    const checks = run("", [{ ...vendor, url: "https://static.shop.test/app.js" }]);
    expect(checks[0]!.message).not.toContain("third-party");
    expect(checks[0]!.items![0]!.meta).not.toHaveProperty("thirdParty");
  });

  test("isThirdPartyScript compares registrable domains", () => {
    expect(isThirdPartyScript("https://cdn.shop.test/a.js", "https://www.shop.test/")).toBe(false);
    expect(isThirdPartyScript("https://x.vendor.test/a.js", "https://shop.test/")).toBe(true);
    expect(isThirdPartyScript("not a url", "https://shop.test/")).toBe(false);
  });
});

describe("namespaced keys", () => {
  test("only the last part after a namespace separator is judged", () => {
    expect(keys('localStorage.setItem("app:token", t)')).toEqual(["localStorage:app:token:key-name"]);
    expect(keys('localStorage.setItem("auth:theme", t)')).toEqual([]);
    expect(keys('localStorage.setItem("token:foo", t)')).toEqual([]);
  });
});

describe("write cap", () => {
  test("a script with thousands of token writes yields a bounded list", () => {
    const code = Array.from({ length: 3000 }, (_, i) => `localStorage.setItem("k${i}_token", v);`).join("\n");
    expect(findTokenStorageWrites(code)).toHaveLength(25);
  });
});

describe("shared bundles", () => {
  const bundle = { url: "https://shop.test/b.js", content: 'localStorage.setItem("token", t)' };
  const pages = ["https://shop.test/a", "https://shop.test/b"];

  test("every page that loads a script reports it, with an identical check", () => {
    const onA = run("", [{ ...bundle, sourcePages: pages }], pages[0]);
    const onB = run("", [{ ...bundle, sourcePages: pages }], pages[1]);
    expect(onA[0]!.status).toBe("warn");
    expect(onB).toEqual(onA);
    expect(onA[0]!.details!.foldKey).toBe("security/token-storage:https://shop.test/b.js");
  });

  test("a skipped first page does not hide the script from the others", () => {
    // Only page b runs; page a (the lowest-sorted loader) is, say, a soft 404.
    const onB = run("", [{ ...bundle, sourcePages: pages }], pages[1]);
    expect(onB[0]!.status).toBe("warn");
  });

  test("a page that does not load the script does not report it", () => {
    const other = run("", [{ ...bundle, sourcePages: pages }], "https://shop.test/c");
    expect(other[0]!.status).toBe("pass");
  });
});

describe("minified forms", () => {
  test.each([
    ["localStorage.token=e", "localStorage:token:key-name"],
    ['localStorage.setItem("token",e)', "localStorage:token:key-name"],
    ['sessionStorage["jwt"]=e.jwt', "sessionStorage:jwt:key-name"],
    ['window.localStorage?.setItem("id_token",e)', "localStorage:id_token:key-name"],
  ])("%s", (code, expected) => {
    expect(keys(code)).toEqual([expected]);
  });

  test("a large bundle of unrelated storage writes stays fast", () => {
    const code = Array.from({ length: 50_000 }, (_, i) => `localStorage.x${i}=${i};`).join("");
    const t0 = performance.now();
    expect(findTokenStorageWrites(code)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("registration", () => {
  test("is in the security rule list and the loaded rule set", () => {
    expect(securityRules).toContain(tokenStorageRule);
    expect(loadAllRules().get("security/token-storage")).toBe(tokenStorageRule);
  });
});
