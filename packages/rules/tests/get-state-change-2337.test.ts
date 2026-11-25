// security/get-state-change: a form that changes state must not submit by GET (#2337).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import {
  findVerb,
  getStateChangeRule,
  MAX_FIELDS,
  MAX_TEXT,
} from "../src/security/get-state-change";

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

  test("button text skips an ambiguous verb alone or before a read-only noun", () => {
    expect(findVerb(["update"], true)).toBeNull();
    expect(findVerb(["confirm"], true)).toBeNull();
    expect(findVerb(["check", "out"], true)).toBeNull();
    expect(findVerb(["update", "results"], true)).toBeNull();
    expect(findVerb(["save", "search"], true)).toBeNull();
    expect(findVerb(["remove", "filter"], true)).toBeNull();
    expect(findVerb(["delete"], true)).toBe("delete");
    expect(findVerb(["remove"], true)).toBe("remove");
    expect(findVerb(["save", "changes"], true)).toBe("save");
    expect(findVerb(["check", "out", "now"], true)).toBe("check out");
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
    const a = run(`<form action="/x"><button>Delete account</button></form>`);
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
          `<form action="/x" method="post"><button formmethod="get">Unsubscribe</button></form>`
        ),
        "get-state-change"
      )
    ).toBeDefined();
  });

  test("flags an ambiguous verb in button text that names what it changes", () => {
    for (const [label, verb] of [
      ["Save changes", "save"],
      ["Confirm order", "confirm"],
      ["Cancel subscription", "cancel"],
    ]) {
      const fail = named(
        run(
          `<form action="/account" method="get"><input name="plan"><button>${label}</button></form>`
        ),
        "get-state-change"
      );
      expect(fail?.items?.[0]?.meta?.reason).toBe("submit-text-verb");
      expect(fail?.items?.[0]?.meta?.detail).toBe(verb);
    }
  });

  test("a GET button's formaction path counts", () => {
    const fail = named(
      run(
        `<form action="/x" method="post"><button formmethod="get" formaction="/account/delete">Go</button></form>`
      ),
      "get-state-change"
    );
    expect(fail?.items?.[0]?.meta?.reason).toBe("action-verb");
  });

  test("ambiguous verbs still count in the action path", () => {
    expect(
      named(
        run(`<form action="/cart/checkout"><button>Go</button></form>`),
        "get-state-change"
      )?.items?.[0]?.meta?.detail
    ).toBe("checkout");
  });

  test("a POST form is not assessed", () => {
    expect(
      run(`<form action="/delete" method="post"><button>Delete</button></form>`)
    ).toEqual([]);
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

  test("a GET filter form with an Update or Confirm button passes", () => {
    for (const label of ["Update", "Confirm", "Save", "Apply and update"]) {
      expect(
        run(
          `<form action="/products" method="get"><select name="color"></select><input name="size"><button>${label}</button></form>`
        )
      ).toEqual(PASS);
    }
  });

  test("a Remove filter button on a GET facet form passes", () => {
    expect(
      run(
        `<form action="/products" method="get"><input type="checkbox" name="color" value="red" checked><button>Remove filter</button></form>`
      )
    ).toEqual(PASS);
  });

  test("a GET form whose Delete button posts passes", () => {
    expect(
      run(
        `<form action="/items" method="get"><input name="name"><button>Show</button><button formmethod="post" formaction="/items/delete">Delete</button></form>`
      )
    ).toEqual(PASS);
    expect(
      run(
        `<form action="/items"><input type="submit" formmethod="post" value="Delete"></form>`
      )
    ).toEqual([]);
  });

  test("a script-driven form (no method, no action) is skipped", () => {
    expect(
      run(
        `<form onsubmit="go()"><input type="email" name="email"><button>Save</button></form>`
      )
    ).toEqual([]);
    expect(
      run(`<form><input type="email" name="email"><button>Save</button></form>`)
    ).toEqual([]);
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
    expect(warn?.items?.[0]?.label).toContain("submits an email field by GET");
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
    ).toEqual([]);
  });

  test("POST credential forms are not assessed", () => {
    expect(
      run(
        `<form action="/login" method="post"><input type="email" name="e"></form>`
      )
    ).toEqual([]);
  });
});

describe("no assessed form", () => {
  test("a page with no form, or only POST forms, emits nothing", () => {
    expect(run(`<p>hi</p>`)).toEqual([]);
    expect(
      run(`<form action="/x" method="post"><button>Go</button></form>`)
    ).toEqual([]);
  });
});

describe("hostile input", () => {
  test("only the first MAX_TEXT characters of an action path are read", () => {
    const action = `/${"a".repeat(MAX_TEXT)}/delete`;
    expect(run(`<form action="${action}"><button>Go</button></form>`)).toEqual(
      PASS
    );
    expect(
      named(
        run(
          `<form action="/delete/${"a".repeat(MAX_TEXT * 50)}"><button>Go</button></form>`
        ),
        "get-state-change"
      )
    ).toBeDefined();
  });

  test("only the first MAX_TEXT characters of a button text are read", () => {
    expect(
      run(
        `<form action="/x"><button>${"a".repeat(MAX_TEXT)} delete</button></form>`
      )
    ).toEqual(PASS);
  });

  test("only the first MAX_FIELDS controls of a form are read", () => {
    const filler = "<input name=a>".repeat(MAX_FIELDS);
    expect(
      run(`<form action="/x">${filler}<button>Delete</button></form>`)
    ).toEqual(PASS);
    expect(
      named(
        run(`<form action="/x"><button>Delete</button>${filler}</form>`),
        "get-state-change"
      )
    ).toBeDefined();
  });
});
