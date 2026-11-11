// security/password-form-get: a form with a password field must not submit by GET (#1698).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { methodOf, passwordFormGetRule } from "../src/security/password-form-get";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
    wantsItemSelectors: false,
  } as unknown as RuleContext;
  const result = passwordFormGetRule.run(ctx);
  if (result instanceof Promise) throw new Error("password-form-get is sync");
  return result.checks;
}

const failOf = (checks: CheckResult[]) => checks.find((c) => c.status === "fail");
const isPass = (checks: CheckResult[]) => checks.length === 1 && checks[0]?.status === "pass";

describe("methodOf table", () => {
  const table: [string | null, string][] = [
    [null, "get"],
    ["", "get"],
    ["get", "get"],
    ["GET", "get"],
    ["  Post ", "post"],
    ["POST", "post"],
    ["dialog", "dialog"],
    ["put", "get"],
    ["garbage", "get"],
  ];
  for (const [raw, want] of table) {
    test(`${JSON.stringify(raw)} is ${want}`, () => expect(methodOf(raw)).toBe(want));
  }
});

describe("failures", () => {
  test("method=get fails as an error and names the form by action and position", () => {
    const checks = run(
      '<form action="/login" method="get"><input type="password" name="p"><button>Go</button></form>',
    );
    const f = failOf(checks);
    expect(f?.message).toBe("1 form(s) with a password field submit by GET");
    expect(f?.items?.[0]?.id).toBe('form[action="/login"]');
    expect(f?.items?.[0]?.label).toContain("form 1 of 1 (/login)");
    expect(f?.items?.[0]?.meta).toMatchObject({ reason: "get-method", action: "/login", position: 1 });
    expect(passwordFormGetRule.meta.severity).toBe("error");
  });

  test("no method attribute fails, GET is the default", () => {
    const checks = run('<form action="/login"><input type="password"></form>');
    expect(failOf(checks)).toBeDefined();
  });

  test("method matched in any letter case", () => {
    expect(failOf(run('<form action="/a" method="GeT"><input type="password"></form>'))).toBeDefined();
    expect(isPass(run('<form action="/a" method="PoSt"><input type="PASSWORD"></form>'))).toBe(true);
  });

  test("an unknown method value is GET", () => {
    expect(failOf(run('<form action="/a" method="put"><input type="password"></form>'))).toBeDefined();
  });

  test("position counts every form on the page", () => {
    const checks = run(
      '<form action="/s" method="post"><input name="q"></form><form action="/login"><input type="password"></form>',
    );
    expect(failOf(checks)?.items?.[0]?.label).toContain("form 2 of 2");
  });

  test("a password field associated by the form attribute counts", () => {
    const checks = run('<form id="f" action="/l"></form><input type="password" form="f">');
    expect(failOf(checks)).toBeDefined();
  });

  test("a password field in another form does not count for this one", () => {
    const checks = run(
      '<form id="f" action="/l" method="post"><input type="password"></form><form action="/s"><input name="q"><input type="password" form="f"></form>',
    );
    expect(isPass(checks)).toBe(true);
  });

  test("a disabled password field is not submitted", () => {
    expect(run('<form action="/l"><input type="password" disabled></form>')).toEqual([]);
  });
});

describe("formmethod on submit controls", () => {
  test("every submit control posting passes a GET form", () => {
    const checks = run(
      '<form action="/l"><input type="password"><button formmethod="post">A</button><input type="submit" formmethod="POST"></form>',
    );
    expect(isPass(checks)).toBe(true);
  });

  test("one GET submit control is enough to fail a POST form", () => {
    const checks = run(
      '<form action="/l" method="post"><input type="password"><button>A</button><button formmethod="get">B</button></form>',
    );
    expect(failOf(checks)).toBeDefined();
  });

  test("a GET form with one posting and one default button fails", () => {
    const checks = run(
      '<form action="/l"><input type="password"><button formmethod="post">A</button><button>B</button></form>',
    );
    expect(failOf(checks)).toBeDefined();
  });

  test("type=button and reset are not submit controls", () => {
    const checks = run(
      '<form action="/l"><input type="password"><button type="button">x</button><button type="reset" formmethod="get">y</button><button formmethod="post">Go</button></form>',
    );
    expect(isPass(checks)).toBe(true);
  });

  test("a disabled GET button does not submit", () => {
    const checks = run(
      '<form action="/l" method="post"><input type="password"><button>A</button><button disabled formmethod="get">B</button></form>',
    );
    expect(isPass(checks)).toBe(true);
  });

  test("a submit button outside the form with form= counts", () => {
    const checks = run(
      '<form id="f" action="/l" method="post"><input type="password"></form><button form="f" formmethod="get">Go</button>',
    );
    expect(failOf(checks)).toBeDefined();
  });
});

describe("passes and out of scope", () => {
  test("method=post passes", () => {
    expect(isPass(run('<form action="/l" method="post"><input type="password"></form>'))).toBe(true);
  });

  test("method=dialog passes, nothing goes on the network", () => {
    expect(isPass(run('<dialog open><form method="dialog"><input type="password"></form></dialog>'))).toBe(true);
  });

  test("a GET form with no password field is not assessed", () => {
    const checks = run('<form action="/search"><input name="q"></form>');
    expect(checks).toEqual([]);
  });

  test("a page with no form is not assessed", () => {
    expect(run("<main><p>hi</p></main>")).toEqual([]);
  });

  test("a mixed page flags only the password GET form", () => {
    const checks = run(
      '<form action="/search"><input name="q"></form><form action="/l"><input type="password"></form><form action="/ok" method="post"><input type="password"></form>',
    );
    const f = failOf(checks);
    expect(f?.items).toHaveLength(1);
    expect(f?.items?.[0]?.id).toBe('form[action="/l"]');
    expect(f?.details).toMatchObject({ formsChecked: 3, passwordForms: 2 });
  });
});

describe("script submitted forms", () => {
  test("no action plus onsubmit is not determined, not a failure", () => {
    const checks = run('<form onsubmit="return send(this)"><input type="password"><button>Go</button></form>');
    expect(failOf(checks)).toBeUndefined();
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("password-form-get-undetermined");
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.items?.[0]?.meta).toMatchObject({ reason: "script-submit" });
  });

  test("no action plus a button onclick is not determined", () => {
    const checks = run('<form><input type="password"><button onclick="go()">Go</button></form>');
    expect(checks[0]?.name).toBe("password-form-get-undetermined");
  });

  test("a javascript: action with a handler is not determined", () => {
    const checks = run('<form action="javascript:void(0)" onsubmit="x()"><input type="password"></form>');
    expect(checks[0]?.name).toBe("password-form-get-undetermined");
  });

  test("a real action with a handler is still a failure", () => {
    const checks = run('<form action="/l" onsubmit="x()"><input type="password"></form>');
    expect(failOf(checks)).toBeDefined();
  });

  test("no action and no handler is a failure: it submits to this page by GET", () => {
    expect(failOf(run('<form><input type="password"></form>'))).toBeDefined();
  });

  test("a failure and an undetermined form are reported side by side", () => {
    const checks = run(
      '<form action="/l"><input type="password"></form><form onsubmit="x()"><input type="password"></form>',
    );
    expect(checks.map((c) => c.name).sort()).toEqual(["password-form-get", "password-form-get-undetermined"]);
  });
});

describe("determinism and reading only", () => {
  test("the same input gives the same result", () => {
    const body = '<form action="/l"><input type="password"></form><form onsubmit="x()"><input type="password"></form>';
    expect(JSON.stringify(run(body))).toBe(JSON.stringify(run(body)));
  });

  test("a hostile snippet is length capped", () => {
    const f = failOf(run(`<form action="/l" data-x="${"a".repeat(100000)}"><input type="password"></form>`));
    expect((f?.items?.[0]?.snippet ?? "").length).toBeLessThanOrEqual(240);
  });
});
