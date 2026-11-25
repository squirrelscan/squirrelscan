// security/get-state-change: a form that changes state must not submit by GET (#2337).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import { findVerb, getStateChangeRule } from "../src/security/get-state-change";

function run(body: string): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
    wantsItemSelectors: false,
  } as unknown as RuleContext;
  const result = getStateChangeRule.run(ctx);
  if (result instanceof Promise) throw new Error("get-state-change is sync");
  return result.checks;
}

const PASS = [expect.objectContaining({ status: "pass" })];
const named = (checks: CheckResult[], name: string) =>
  checks.find((c) => c.name === name && c.status !== "pass");
const isPass = (checks: CheckResult[]) =>
  checks.length === 1 && checks[0]?.status === "pass";

describe("findVerb", () => {
  test("matches whole tokens and camelCase only", () => {
    expect(findVerb(["account", "delete"])).toBe("delete");
    expect(findVerb(["paypal"])).toBeNull();
    expect(findVerb(["sign", "out"])).toBe("sign out");
    expect(findVerb(["updates"])).toBeNull();
  });
});

describe("state-changing verbs", () => {
  test("flags a GET action path verb, naming the form and reason", () => {
    const checks = run(
      `<form action="/account/delete" method="get"><button>Go</button></form>`
    );
    const fail = named(checks, "get-state-change");
    expect(fail?.status).toBe("fail");
    expect(fail?.items?.[0]?.label).toContain("/account/delete");
    expect(fail?.items?.[0]?.label).toContain('"delete"');
    expect(fail?.items?.[0]?.meta?.reason).toBe("action-verb");
  });

  test("flags a form with no method and a real action", () => {
    expect(
      named(
        run(`<form action="/logout"><button>Out</button></form>`),
        "get-state-change"
      )
    ).toBeDefined();
  });

  test("flags submit text, from a button or an input", () => {
    const a = run(`<form action="/x"><button>Confirm order</button></form>`);
    expect(named(a, "get-state-change")?.items?.[0]?.meta?.reason).toBe(
      "submit-text-verb"
    );
    expect(
      named(
        run(`<form action="/x"><input type="submit" value="Sign out"></form>`),
        "get-state-change"
      )
    ).toBeDefined();
  });

  test("flags a formmethod GET button on a POST form", () => {
    expect(
      named(
        run(
          `<form action="/x" method="post"><button formmethod="get">Cancel</button></form>`
        ),
        "get-state-change"
      )
    ).toBeDefined();
  });

  test("a POST form passes", () => {
    expect(
      run(`<form action="/delete" method="post"><button>Delete</button></form>`)
    ).toEqual(PASS);
  });

  test("the query string is not the action path", () => {
    const checks = run(
      `<form action="/results?mode=delete" method="get"><input name="q"><button>Go</button></form>`
    );
    expect(named(checks, "get-state-change")).toBeUndefined();
  });
});

describe("read-only forms", () => {
  test("search and filter forms are not flagged", () => {
    const search = run(
      `<form action="/search" method="get"><input type="search" name="q"><button>Update results</button></form>`
    );
    expect(isPass(search)).toBe(true);
    const roleSearch = run(
      `<form role="search" action="/find"><input name="x"><button>Save search</button></form>`
    );
    expect(roleSearch.every((c) => c.status === "pass")).toBe(true);
    const filter = run(
      `<form action="/shop"><select name="sort"></select><input name="category"><button>Update</button></form>`
    );
    expect(isPass(filter)).toBe(true);
  });

  test("a script-driven form (no method, no action) is skipped", () => {
    expect(
      run(
        `<form onsubmit="go()"><input type="email" name="email"><button>Save</button></form>`
      )
    ).toEqual(PASS);
    expect(
      run(`<form><input type="email" name="email"><button>Save</button></form>`)
    ).toEqual(PASS);
  });
});

describe("credential forms", () => {
  test("flags an email field submitted by GET", () => {
    const checks = run(
      `<form action="/join" method="get"><input type="email" name="addr"><button>Go</button></form>`
    );
    const warn = named(checks, "get-credential-form");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.[0]?.meta?.reason).toBe("credential-field");
  });

  test("flags a username field", () => {
    expect(
      named(
        run(
          `<form action="/signin" method="get"><input name="username"><button>Go</button></form>`
        ),
        "get-credential-form"
      )
    ).toBeDefined();
  });

  test("leaves password forms to password-form-get", () => {
    expect(
      run(
        `<form action="/login" method="get"><input name="email"><input type="password" name="p"><button>Log out</button></form>`
      )
    ).toEqual(PASS);
  });

  test("POST credential forms are fine", () => {
    expect(
      run(
        `<form action="/login" method="post"><input type="email" name="e"></form>`
      )
    ).toEqual(PASS);
  });
});

describe("hostile input", () => {
  test("a long action and many controls still return", () => {
    const body = `<form action="/${"delete".repeat(5000)}">${"<input name=a>".repeat(2000)}</form>`;
    expect(Array.isArray(run(body))).toBe(true);
  });
});
