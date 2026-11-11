// url/session-ids: a session ID in a crawlable URL (#1695).

import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";
import { looksLikeSessionValue, sessionIdsRule, sessionParamsOf } from "../src/url/session-ids";

const SID = "a1b2c3d4e5f6a7b8c9d0";

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
  const table: [string, boolean][] = [
    ["", false],
    ["2", false],
    ["main", false],
    ["abcdefg", false],
    ["abcdefgh", false],
    ["abcd1234", true],
    ["12345678", false],
    ["abcdefghijklmnop", true],
    ["0123456789abcdef", true],
  ];
  for (const [value, want] of table) test(`${JSON.stringify(value)} is ${want}`, () => expect(looksLikeSessionValue(value)).toBe(want));
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
