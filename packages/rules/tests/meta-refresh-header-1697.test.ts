// a11y/meta-refresh also reads the Refresh response header (#1697).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { gradeRefreshHeader, metaRefreshRule, parseRefreshHeader, readRefreshHeader } from "../src/a11y/meta-refresh";
import type { CheckResult, RuleContext } from "../src/types";

function run(head = "", headers: Record<string, string> = {}): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body><p>x</p></body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers },
    parsed: parsePage(html, url),
    options: {},
    wantsItemSelectors: false,
  } as unknown as RuleContext;
  const result = metaRefreshRule.run(ctx);
  if (result instanceof Promise) throw new Error("meta-refresh is sync");
  return result.checks;
}

describe("parseRefreshHeader table", () => {
  const table: [string, { delay: number; target: string | null } | null][] = [
    ["0; url=https://example.com/new", { delay: 0, target: "https://example.com/new" }],
    ["0;url=/new", { delay: 0, target: "/new" }],
    ["5; URL=/new", { delay: 5, target: "/new" }],
    ["5, /new", { delay: 5, target: "/new" }],
    ["5 /new", { delay: 5, target: "/new" }],
    ["5; /new", { delay: 5, target: "/new" }],
    ['3; url="/quoted"', { delay: 3, target: "/quoted" }],
    ["3; url='/single'", { delay: 3, target: "/single" }],
    ["30", { delay: 30, target: null }],
    ["30;", { delay: 30, target: null }],
    ["30; url=", { delay: 30, target: null }],
    ["0", { delay: 0, target: null }],
    ["2.5; url=/x", { delay: 2.5, target: "/x" }],
    ["  7  ;  url = /x  ", { delay: 7, target: "/x" }],
    ["", null],
    ["soon", null],
    ["url=/x", null],
    ["-1; url=/x", null],
  ];
  for (const [raw, want] of table) {
    test(JSON.stringify(raw), () => {
      const got = parseRefreshHeader(raw);
      expect(got === null ? null : { delay: got.delay, target: got.target }).toEqual(want);
    });
  }

  test("a hostile value is length capped", () => {
    const got = parseRefreshHeader(`0; url=${"a".repeat(100000)}`);
    expect(got?.target?.length).toBe(200);
    expect(got?.raw.length).toBe(200);
  });
});

describe("header name case", () => {
  for (const name of ["Refresh", "refresh", "REFRESH", "rEfReSh"]) {
    test(name, () => expect(readRefreshHeader({ [name]: "0; url=/x" })?.target).toBe("/x"));
  }
  test("absent", () => expect(readRefreshHeader({ "content-type": "text/html" })).toBeNull());
  test("no headers", () => expect(readRefreshHeader(undefined)).toBeNull());
});

describe("header only", () => {
  test("an immediate redirect names the header and the target", () => {
    const checks = run("", { Refresh: "0; url=https://example.com/new" });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "refresh-header-redirect",
      status: "warn",
      message: "Immediate Refresh header redirect to https://example.com/new",
      value: "Refresh: 0; url=https://example.com/new",
    });
    expect(checks[0]?.details).toMatchObject({ source: "header" });
  });

  test("a delayed redirect shows the delay and fails", () => {
    const checks = run("", { refresh: "5; url=/new" });
    expect(checks[0]).toMatchObject({
      name: "refresh-header-redirect",
      status: "fail",
      message: "Refresh header redirect to /new after 5 seconds",
    });
  });

  test("no url is a reload, not a redirect", () => {
    const fast = run("", { Refresh: "10" })[0];
    expect(fast).toMatchObject({ name: "refresh-header-reload", status: "fail", message: "Page reloads every 10 seconds (Refresh header)" });
    const slow = run("", { Refresh: "60" })[0];
    expect(slow).toMatchObject({ name: "refresh-header-reload", status: "warn" });
    expect(run("", { Refresh: "0" })[0]).toMatchObject({ name: "refresh-header-reload", status: "fail", message: "Refresh header reloads the page immediately" });
  });

  test("an unparseable header is ignored like a browser ignores it", () => {
    expect(run("", { Refresh: "soon" })).toEqual([{ name: "meta-refresh", status: "pass", message: "No meta refresh found" }]);
  });

  test("the redirect finding recommends 301 or 308", () => {
    expect(gradeRefreshHeader({ raw: "0;url=/x", delay: 0, target: "/x" }).issue).toContain("301 or 308");
    expect(metaRefreshRule.meta.solution).toContain("301 or 308");
  });
});

describe("both sources", () => {
  test("one finding names the header and the meta tag", () => {
    const checks = run('<meta http-equiv="refresh" content="0;url=/a">', { Refresh: "0; url=/b" });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("refresh-header-and-meta");
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.message).toContain("Refresh header");
    expect(checks[0]?.message).toContain("meta refresh");
    expect(checks[0]?.value).toBe("Refresh: 0; url=/b; meta: 0;url=/a");
    expect(checks[0]?.details).toMatchObject({ sources: ["header", "meta"] });
  });

  test("the worse status wins", () => {
    expect(run('<meta http-equiv="refresh" content="5;url=/a">', { Refresh: "0; url=/b" })[0]?.status).toBe("fail");
    expect(run('<meta http-equiv="refresh" content="0;url=/a">', { Refresh: "5; url=/b" })[0]?.status).toBe("fail");
  });

  test("a meta tag that gives no finding leaves the header finding alone", () => {
    const checks = run('<meta http-equiv="refresh" content="0">', { Refresh: "0; url=/b" });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("refresh-header-redirect");
  });
});

describe("neither or meta only: unchanged", () => {
  test("neither passes as before", () => {
    expect(run("", { "content-type": "text/html" })).toEqual([{ name: "meta-refresh", status: "pass", message: "No meta refresh found" }]);
  });

  test("meta redirect, delayed redirect and auto refresh keep their messages", () => {
    expect(run('<meta http-equiv="refresh" content="0;url=/x">')[0]).toMatchObject({ name: "meta-refresh-redirect", status: "warn", message: "Immediate meta refresh redirect found", value: "0;url=/x" });
    expect(run('<meta http-equiv="Refresh" content="4; url=/x">')[0]).toMatchObject({ name: "meta-refresh-redirect", status: "fail", message: "Meta refresh redirect after 4 seconds" });
    expect(run('<meta http-equiv="refresh" content="10">')[0]).toMatchObject({ name: "meta-refresh-auto", status: "fail", message: "Page auto-refreshes every 10 seconds" });
    expect(run('<meta http-equiv="refresh" content="30">')[0]).toMatchObject({ name: "meta-refresh-auto", status: "warn" });
    expect(run('<meta http-equiv="refresh" content="0">')).toEqual([]);
  });

  test("a meta tag inside noscript is still skipped", () => {
    expect(run('<noscript><meta http-equiv="refresh" content="0;url=/x"></noscript>')[0]?.status).toBe("pass");
  });
});

describe("scope and determinism", () => {
  test("the verdict is per page because a header is not part of the template", () => {
    expect(metaRefreshRule.meta.verdictScope).toBe("page");
  });

  test("the same input gives the same result", () => {
    const a = run('<meta http-equiv="refresh" content="3;url=/a">', { Refresh: "0; url=/b" });
    const b = run('<meta http-equiv="refresh" content="3;url=/a">', { Refresh: "0; url=/b" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
