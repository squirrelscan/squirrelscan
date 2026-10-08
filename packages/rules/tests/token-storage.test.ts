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
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("warn");
    expect(checks[0]!.items!.map((i) => i.id)).toEqual([
      `${PAGE}: localStorage["token"]`,
      'https://shop.test/app.js: sessionStorage["jwt"]',
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

describe("shared bundles", () => {
  const bundle = { url: "https://shop.test/b.js", content: 'localStorage.setItem("token", t)' };

  test("a shared script is reported once, on the lowest-sorted page", () => {
    const pages = ["https://shop.test/b", "https://shop.test/a"];
    const onA = run("", [{ ...bundle, sourcePages: pages }], "https://shop.test/a");
    const onB = run("", [{ ...bundle, sourcePages: pages }], "https://shop.test/b");
    expect(onA[0]!.status).toBe("warn");
    expect(onB[0]!.status).toBe("pass");
  });
});

describe("registration", () => {
  test("is in the security rule list and the loaded rule set", () => {
    expect(securityRules).toContain(tokenStorageRule);
    expect(loadAllRules().get("security/token-storage")).toBe(tokenStorageRule);
  });
});
