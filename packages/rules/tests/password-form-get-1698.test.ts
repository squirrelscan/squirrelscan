// security/password-form-get: a form with a password field must not submit by GET (#1698).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { describeAction, methodOf, passwordFormGetRule, submissions } from "../src/security/password-form-get";
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

  test("an explicit method=get with no action and no handler is still a failure", () => {
    expect(failOf(run('<form method="get"><input type="password"></form>'))).toBeDefined();
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

// A React, Vue or Svelte login form has no method, no action and no inline handler in the DOM: the
// script submits it. It is GET only if that script has not loaded or fails, so it is a warning.
describe("script-driven forms with no method (#1698 review)", () => {
  const warnOf = (checks: CheckResult[]) =>
    checks.find((c) => c.name === "password-form-get-no-method");

  test("a bare form with only a password input and a button warns, and never fails", () => {
    const checks = run('<form><input type="password" name="p"><button>Sign in</button></form>');
    expect(failOf(checks)).toBeUndefined();
    expect(checks).toHaveLength(1);
    const w = warnOf(checks)!;
    expect(w.status).toBe("warn");
    expect(w.message).toContain("fall back to GET");
    expect(w.items?.[0]?.meta).toMatchObject({ reason: "no-method", action: "(no action)" });
    expect(w.items?.[0]?.label).toContain("method=\"post\" removes the risk");
    expect(w.items?.[0]?.label).toContain("if its script has not loaded or fails");
  });

  test("a React form action (a javascript: action, no method) warns", () => {
    const checks = run(
      '<form action="javascript:throw new Error(\'React form unexpectedly submitted.\')"><input type="password"><button>Go</button></form>',
    );
    expect(failOf(checks)).toBeUndefined();
    expect(warnOf(checks)?.status).toBe("warn");
  });

  test("an empty action and no method warns", () => {
    expect(warnOf(run('<form action=""><input type="password"></form>'))?.status).toBe("warn");
  });

  test("an inline handler with no method and no action is not determined, as before", () => {
    const checks = run('<form onsubmit="send(this)"><input type="password"></form>');
    expect(checks.map((c) => c.name)).toEqual(["password-form-get-undetermined"]);
  });

  test("an explicit method=get fails; so does a GET formmethod on a submit control", () => {
    expect(failOf(run('<form method="get"><input type="password"><button>Go</button></form>'))).toBeDefined();
    expect(failOf(run('<form><input type="password"><button formmethod="get">Go</button></form>'))).toBeDefined();
    expect(failOf(run('<form method="garbage"><input type="password"></form>'))).toBeDefined();
  });

  test("a real action with no method is a plain HTML form: GET without a script, a failure", () => {
    const checks = run('<form action="/login"><input type="password"><button>Go</button></form>');
    expect(failOf(checks)).toBeDefined();
    expect(warnOf(checks)).toBeUndefined();
  });

  test("a form that names post passes, with no warning", () => {
    expect(isPass(run('<form method="post"><input type="password"><button>Go</button></form>'))).toBe(true);
  });

  test("a warning and a failure are reported side by side", () => {
    const checks = run(
      '<form><input type="password"></form><form method="get"><input type="password"></form>',
    );
    expect(checks.map((c) => c.name).sort()).toEqual(["password-form-get", "password-form-get-no-method"]);
  });

  test("submissions says whether the method was explicit", () => {
    const doc = parsePage(
      '<!doctype html><body><form id="a"><input type="password"><button>Go</button></form><form id="b" method="get"><button>Go</button></form><form id="c"><button formmethod="get">Go</button></form></body>',
      "https://example.com/",
    ).document!;
    const of = (id: string) => {
      const form = doc.getElementById(id)!;
      return submissions(form, [...form.querySelectorAll("button, input")]);
    };
    expect(of("a")).toEqual([{ method: "get", explicit: false }]);
    expect(of("b")).toEqual([{ method: "get", explicit: true }]);
    expect(of("c")).toEqual([{ method: "get", explicit: true }]);
  });
});

describe("the action shown never carries a token (#1698 review)", () => {
  function actionOf(action: string): string {
    const doc = parsePage(
      `<!doctype html><body><form action="${action}"><input type="password"></form></body>`,
      "https://example.com/",
    ).document!;
    return describeAction(doc.querySelector("form")!);
  }

  test("query and fragment are dropped", () => {
    expect(actionOf("/login?token=abc123&next=/a#frag")).toBe("/login");
    expect(actionOf("/login#frag")).toBe("/login");
  });

  test("credentials in an absolute action are dropped", () => {
    expect(actionOf("https://user:secret@auth.example.com/login?x=1")).toBe("https://auth.example.com/login");
  });

  test("a query-only action reads as this page; none reads as no action", () => {
    expect(actionOf("?token=abc")).toBe("(this page)");
    expect(actionOf("")).toBe("(no action)");
  });

  test("the label and meta of a finding carry the bare action", () => {
    const f = failOf(
      run('<form action="/login?token=SECRETVALUE#x" method="get"><input type="password"></form>'),
    );
    const item = f?.items?.[0];
    expect(item?.label).toContain("(/login)");
    expect(JSON.stringify(item)).not.toContain("SECRETVALUE");
  });
});

