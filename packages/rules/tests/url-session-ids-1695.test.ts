// url/session-ids: a session ID in a crawlable URL (#1695).

import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";
import { looksLikeSessionValue, sessionIdsRule, sessionParamsOf } from "../src/url/session-ids";

// Built from parts so no fixture reads as a real credential.
const SID = ["a1b2c3d4", "e5f6a7b8", "c9d0"].join("");
const HEX32 = ["0f1e2d3c", "4b5a6978", "8796a5b4", "c3d2e1f0"].join("");
const ALNUM26 = ["Qx7Lm2Vn", "Rt9Ys4Kd", "Hw3Bp6Fz", "Gc"].join("");

function run(pageUrl: string, links: { url: string; isInternal: boolean }[] = []): CheckResult[] {
  const ctx = {
    page: { url: pageUrl, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: { links: links.map((l) => ({ text: "", ...l })) },
    options: {},
    wantsItemSelectors: false,
  } as unknown as RuleContext;
  const result = sessionIdsRule.run(ctx);
  if (result instanceof Promise) throw new Error("session-ids is sync");
  return result.checks;
}

const warnOf = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name && c.status === "warn");

describe("sessionParamsOf table", () => {
  const table: [string, string[]][] = [
    [`https://x.test/?PHPSESSID=${SID}`, ["PHPSESSID"]],
    [`https://x.test/?jsessionid=${SID}`, ["jsessionid"]],
    [`https://x.test/?sid=${SID}`, ["sid"]],
    [`https://x.test/?SessionID=${SID}`, ["SessionID"]],
    [`https://x.test/?session_id=${SID}`, ["session_id"]],
    [`https://x.test/?ASPSESSIONIDQQQQ=${SID}`, ["ASPSESSIONIDQQQQ"]],
    ["https://x.test/?CFID=1234567&CFTOKEN=98765432", ["CFID", "CFTOKEN"]],
    ["https://x.test/?CFID=1234567", []],
    ["https://x.test/?CFTOKEN=98765432", []],
    ["https://x.test/?CFID=1&CFTOKEN=2", []],
    ["https://x.test/?sid=2", []],
    ["https://x.test/?sid=main", []],
    ["https://x.test/?sid=", []],
    ["https://x.test/?page=3&utm_source=x", []],
    [`https://x.test/?token=${SID}`, []],
    [`https://x.test/a;jsessionid=${SID}`, ["jsessionid"]],
    [`https://x.test/a;JSESSIONID=${SID}?x=1`, ["JSESSIONID"]],
    [`https://x.test/a;jsessionid=${SID}/b`, ["jsessionid"]],
    ["https://x.test/a;jsessionid=2", []],
    ["https://x.test/a;color=red", []],
    ["not a url", []],
  ];
  for (const [url, names] of table) {
    test(url, () => expect(sessionParamsOf(url).map((p) => p.name)).toEqual(names));
  }
});

describe("looksLikeSessionValue", () => {
  // [value, loose (unambiguous names), strict (sid, sessionid)]
  const table: [string, boolean, boolean][] = [
    ["", false, false],
    ["2", false, false],
    ["main", false, false],
    ["abcdefg", false, false],
    ["abcdefgh", false, false],
    ["abcd1234", true, true],
    ["12345678", false, false],
    ["abcdefghijklmnop", false, false],
    ["summer-collection-2024", false, false],
    ["my_cart_items_list", false, false],
    ["1234567890123456", false, false],
    ["1730000000000000000", false, false],
    ["SummerCollectionOnlineStoreHome", true, true],
    ["SummerCollectionOnline", true, false],
    [HEX32, true, true],
    [ALNUM26, true, true],
    ["0123456789abcdef", true, true],
    ["ab-12cd34ef56", true, true],
  ];
  for (const [value, loose, strict] of table) {
    test(`${JSON.stringify(value)}: loose ${loose}, strict ${strict}`, () => {
      expect(looksLikeSessionValue(value)).toBe(loose);
      expect(looksLikeSessionValue(value, true)).toBe(strict);
    });
  }
});

describe("weak names need the strict value, unambiguous names the looser one", () => {
  const long = "SummerCollectionOnline"; // 22 mixed-case letters: loose only
  const cases: [string, boolean][] = [
    [`https://x.test/?sid=${long}`, false],
    [`https://x.test/?sessionid=${long}`, false],
    [`https://x.test/?PHPSESSID=${long}`, true],
    [`https://x.test/?jsessionid=${long}`, true],
    [`https://x.test/?session_id=${long}`, true],
    [`https://x.test/?ASPSESSIONIDQQQQ=${long}`, true],
    [`https://x.test/p;sid=${long}`, false],
    [`https://x.test/p;jsessionid=${long}`, true],
  ];
  for (const [url, flagged] of cases) test(url, () => expect(sessionParamsOf(url).length > 0).toBe(flagged));

  test("long human labels and all-digit ids are not sessions under any name", () => {
    for (const name of ["sid", "sessionid", "PHPSESSID", "jsessionid", "session_id"]) {
      expect(sessionParamsOf(`https://x.test/?${name}=summer-collection-2024`)).toEqual([]);
      expect(sessionParamsOf(`https://x.test/?${name}=1234567890123456`)).toEqual([]);
      expect(sessionParamsOf(`https://x.test/?${name}=my_long_human_label`)).toEqual([]);
    }
  });

  test("a real 32-hex and a 26-char alphanumeric are flagged under every name", () => {
    for (const name of ["sid", "sessionid", "PHPSESSID", "jsessionid"]) {
      expect(sessionParamsOf(`https://x.test/?${name}=${HEX32}`)).toHaveLength(1);
      expect(sessionParamsOf(`https://x.test/?${name}=${ALNUM26}`)).toHaveLength(1);
    }
  });
});

describe("page URL", () => {
  test("a query session parameter warns and names the parameter", () => {
    const checks = run(`https://x.test/shop?PHPSESSID=${SID}&page=2`);
    const w = warnOf(checks, "session-id-in-url");
    expect(w?.message).toBe("Page URL carries a session ID (PHPSESSID)");
    expect(sessionIdsRule.meta.severity).toBe("warning");
  });

  test("the path form is detected", () => {
    const w = warnOf(run(`https://x.test/shop;jsessionid=${SID}`), "session-id-in-url");
    expect(w?.message).toBe("Page URL carries a session ID (jsessionid)");
    expect(w?.items?.[0]?.label).toContain("path");
  });

  test("the session value is masked in the item, the message and the details", () => {
    const w = warnOf(run(`https://x.test/shop;jsessionid=${SID}?PHPSESSID=${SID}&page=2`), "session-id-in-url");
    expect(JSON.stringify(w)).not.toContain(SID);
    expect(w?.items?.[0]?.id).toBe("https://x.test/shop;jsessionid=…?PHPSESSID=…&page=2");
  });

  test("a short value such as sid=2 is not flagged", () => {
    expect(run("https://x.test/?sid=2")[0]?.status).toBe("pass");
  });
});

describe("internal links", () => {
  const links = [
    { url: `https://x.test/a?PHPSESSID=${SID}`, isInternal: true },
    { url: `https://x.test/b;jsessionid=${SID}`, isInternal: true },
    { url: `https://x.test/a?PHPSESSID=${SID}`, isInternal: true },
    { url: `https://other.test/c?PHPSESSID=${SID}`, isInternal: false },
    { url: "https://x.test/d", isInternal: true },
  ];

  test("reports the count of distinct links with a masked sample", () => {
    const w = warnOf(run("https://x.test/", links), "session-id-links");
    expect(w?.message).toBe("2 internal link(s) carry a session ID (PHPSESSID, jsessionid)");
    expect(w?.items?.map((i) => i.id)).toEqual(["https://x.test/a?PHPSESSID=…", "https://x.test/b;jsessionid=…"]);
    expect(w?.details).toMatchObject({ count: 2 });
    expect(JSON.stringify(w)).not.toContain(SID);
  });

  test("links to other hosts are not reported", () => {
    const checks = run("https://x.test/", [{ url: `https://other.test/c?PHPSESSID=${SID}`, isInternal: false }]);
    expect(checks).toEqual([{ name: "session-ids", status: "pass", message: "No session IDs in URLs" }]);
  });

  test("the sample is capped at ten and the rest counted", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ url: `https://x.test/p${i}?sid=${SID}`, isInternal: true }));
    const w = warnOf(run("https://x.test/", many), "session-id-links");
    expect(w?.items).toHaveLength(10);
    expect(w?.details).toMatchObject({ count: 14, additional: 4 });
  });

  test("a page URL and its links are reported side by side", () => {
    const checks = run(`https://x.test/?sid=${SID}`, links);
    expect(checks.map((c) => c.name).sort()).toEqual(["session-id-in-url", "session-id-links"]);
  });
});

describe("clean and deterministic", () => {
  test("a site with no session IDs passes", () => {
    const checks = run("https://x.test/p?page=2", [{ url: "https://x.test/q?sort=asc", isInternal: true }]);
    expect(checks).toEqual([{ name: "session-ids", status: "pass", message: "No session IDs in URLs" }]);
  });

  test("the same input gives the same result", () => {
    const l = [{ url: `https://x.test/a?sid=${SID}`, isInternal: true }];
    expect(JSON.stringify(run("https://x.test/", l))).toBe(JSON.stringify(run("https://x.test/", l)));
  });
});
