// `[[ignore]]` entries with `selectors` (#1440): a rule that reports a DOM element puts its path on the item,
// an entry waives it by a selector over that path, and no output carries the path.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { readIgnoredDetails } from "@squirrelscan/core-contracts/ignore";
import type { CheckResult } from "@squirrelscan/core-contracts";

import * as elementPath from "../src/element-path";
import { elementSelector } from "../src/element-path";
import { IgnoreTable, type IgnoreEntry } from "../src/ignore";
import { compileSelector, parsePath } from "../src/ignore-selector";
import { checkIgnoreEntries } from "../src/rule-options-check";
import { RuleRunner } from "../src/runner";

const URL = "https://shop.example/";
const RULE = "a11y/label-content-name-mismatch";

const COUNTRY = `<option>Deutschland EUR</option><option>Schweiz CHF</option>`;
// Shopify Markets' native country selector sits in a <localization-form>; the merchant's own select does not.
const PAGE = `<!doctype html><html><head><title>t</title></head><body><main>
<localization-form><form><select id="country" aria-label="Land auswaehlen">${COUNTRY}</select></form></localization-form>
<div class="checkout"><select id="ship" aria-label="Versand waehlen">${COUNTRY}</select></div>
</main></body></html>`;

async function checks(ignore: IgnoreEntry[] | undefined, html = PAGE): Promise<CheckResult[]> {
  const runner = new RuleRunner({
    config: { rule_options: {}, rules: { enable: [RULE] }, ...(ignore ? { ignore } : {}) } as never,
  });
  const parsed = parsePage(html, URL);
  const out = await runner.runPageRules({ url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed } as never);
  return out.ruleResults.get(RULE)!.checks;
}
const mismatch = (all: CheckResult[]) => all.find((c) => c.name === "label-content-name-mismatch")!;

describe("the country selector case from the issue", () => {
  test("the select inside <localization-form> is waived, the merchant's own select is still reported", async () => {
    const all = await checks([{ rule: RULE, selectors: ["localization-form select"], reason: "rendered by the platform" }]);
    const check = mismatch(all);
    expect(check.status).toBe("fail");
    expect(check.items).toHaveLength(1);
    expect(check.items![0]!.id).toContain("select: visible=");
    expect(check.message).toBe("1 element(s) where visible text doesn't match accessible name (1 ignored)");
    expect(readIgnoredDetails(check.details)).toEqual({ items: 1, entries: [0] });
  });

  test("waiving both leaves a pass that says how many were waived", async () => {
    const all = await checks([{ rule: RULE, selectors: ["localization-form select", "div.checkout > select#ship"] }]);
    const check = mismatch(all);
    expect(check.status).toBe("pass");
    expect(check.message).toContain("2 waived by squirrel.toml");
  });

  test("a selector that matches no element waives nothing and records nothing", async () => {
    const all = await checks([{ rule: RULE, selectors: ["footer select"] }]);
    const check = mismatch(all);
    expect(check.items).toHaveLength(2);
    expect(readIgnoredDetails(check.details) ?? undefined).toBeUndefined();
  });

  test("items AND selectors: both must hit", async () => {
    const hit = await checks([{ rule: RULE, selectors: ["localization-form select"], items: ["glob:select: visible=*"] }]);
    expect(mismatch(hit).items).toHaveLength(1);
    const miss = await checks([{ rule: RULE, selectors: ["localization-form select"], items: ["no such item"] }]);
    expect(mismatch(miss).items).toHaveLength(2);
  });

  test("no output carries the element path, with or without an entry", async () => {
    for (const ignore of [undefined, [{ rule: RULE, selectors: ["footer select"] }], [{ rule: RULE, selectors: ["localization-form select"] }]]) {
      const check = mismatch(await checks(ignore));
      for (const item of check.items ?? []) expect(Object.keys(item)).not.toContain("selector");
    }
    // and a run with no entry is the same list of checks as one whose only entry matched nothing
    expect(JSON.stringify(await checks(undefined))).toBe(JSON.stringify(await checks([{ rule: RULE, selectors: ["footer select"] }])));
  });
});

describe("selector language", () => {
  const path = "html > body > main > localization-form > form#f.a.b > select#country.picker";
  const hits = (selector: string): boolean => {
    const m = compileSelector(selector);
    return typeof m === "string" ? false : m.test(parsePath(path));
  };
  test("tags, ids, classes, descendant and child combinators", () => {
    expect(hits("select")).toBe(true);
    expect(hits("#country")).toBe(true);
    expect(hits("select.picker#country")).toBe(true);
    expect(hits("localization-form select")).toBe(true);
    expect(hits("form > select")).toBe(true);
    expect(hits("localization-form > select")).toBe(false);
    expect(hits("form.a.b select")).toBe(true);
    expect(hits("form.c select")).toBe(false);
    expect(hits("main localization-form form select")).toBe(true);
    expect(hits("* > select")).toBe(true);
    expect(hits("footer select")).toBe(false);
    expect(hits("SELECT")).toBe(true);
  });
  test("what the language does not model is refused with a message", () => {
    for (const bad of ["a[href]", "a:hover", "a + b", "a, b", "", "> a", "a >", "#a#b", "a{b}"]) {
      expect(typeof compileSelector(bad)).toBe("string");
    }
    expect(typeof compileSelector("a ".repeat(13))).toBe("string");
    expect(typeof compileSelector(`a${"b".repeat(400)}`)).toBe("string");
  });
  test("a long descendant chain against a deep path stays bounded", () => {
    const deep = Array.from({ length: 24 }, () => "div").join(" > ");
    const m = compileSelector(Array.from({ length: 12 }, () => "div").join(" ") + " span");
    const started = performance.now();
    expect(typeof m !== "string" && m.test(parsePath(`${deep} > p`))).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });
  test("elementSelector keeps only parseable tokens, and bounds the path in every dimension", () => {
    const doc = parsePage(`<html><body><div id="a b" class="ok  weird!class x_y"><p id="p1"></p></div></body></html>`, URL).document!;
    expect(elementSelector(doc.getElementById("p1")!)).toBe("html > body > div.ok.x_y > p#p1");
  });
});

describe("config and validation", () => {
  test("an entry with only selectors on a rule that reports no elements is a validate problem naming the rule", () => {
    const problems = checkIgnoreEntries([{ rule: "security/cookie-flags", selectors: ["form select"] }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("security/cookie-flags");
    expect(problems[0]!.message).toContain("does not report an element path");
    expect(checkIgnoreEntries([{ rule: RULE, selectors: ["form select"] }])).toEqual([]);
    expect(checkIgnoreEntries([{ rule: "a11y/*", selectors: ["form select"] }])).toEqual([]);
  });
  test("an unsupported selector is listed by the table and the entry is not applied", () => {
    const table = new IgnoreTable([{ rule: RULE, selectors: ["a[href]"] }]);
    expect(table.problems.map((p) => p.field)).toEqual(["selectors"]);
    expect(table.empty).toBe(true);
    const problems = checkIgnoreEntries([{ rule: RULE, selectors: ["a[href]"] }]);
    expect(problems.some((p) => p.key === "selectors")).toBe(true);
  });
  test("selectors are part of an entry's cache signature", () => {
    const a = new IgnoreTable([{ rule: RULE, selectors: ["x y"] }]).signatureFor(RULE);
    const b = new IgnoreTable([{ rule: RULE, selectors: ["x z"] }]).signatureFor(RULE);
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

describe("selector work is bounded (#1440 review)", () => {
  const inputs = (n: number): string =>
    `<!doctype html><html><head><title>t</title></head><body><main>${Array.from({ length: n }, (_, i) => `<div class="w${i % 7}"><form id="f${i % 50}"><input type="text" name="n${i}"></form></div>`).join("")}</main></body></html>`;
  const FORM_LABELS = "a11y/form-labels";

  test("10 entries of 100 selectors against 5,000 unlabeled inputs time the entries out instead of running for seconds", async () => {
    const selectors = Array.from({ length: 100 }, (_, i) => `main div.w${i} form#nomatch${i} input`);
    const entries: IgnoreEntry[] = Array.from({ length: 10 }, () => ({ rule: FORM_LABELS, selectors }));
    const timedOut: number[] = [];
    const runner = new RuleRunner({
      config: { rule_options: {}, rules: { enable: [FORM_LABELS] }, ignore: entries } as never,
      ruleTimeBudgetMs: 0,
    });
    const html = inputs(5_000);
    const parsed = parsePage(html, URL);
    const started = performance.now();
    await runner.runPageRules({ url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed } as never);
    expect(performance.now() - started).toBeLessThan(8_000);
    timedOut.push(...runner.ignoreTimedOutEntries());
    expect(timedOut.length).toBeGreaterThan(0);
  }, 60_000);

  test("an entry whose selectors spend its work budget stops waiving and is reported once", () => {
    const timeouts: string[] = [];
    const table = new IgnoreTable([{ rule: RULE, selectors: ["main div.a form#b input", "main div.c form#d input"] }], {
      onTimeout: (message) => timeouts.push(message),
      limits: { perEntry: 2_000 },
    });
    const path = "html > body > main > div.a > form#b > input";
    const check = (): CheckResult => ({ name: "label-content-name-mismatch", status: "fail", message: "1 element(s) x", items: [{ id: "i", selector: path }] });
    let waived = 0;
    for (let i = 0; i < 200; i++) {
      const out = table.filterChecks(RULE, URL, [check()])[0]!;
      if (out.status === "pass") waived++;
    }
    expect(waived).toBeGreaterThan(0);
    expect(waived).toBeLessThan(200);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toContain("selector");
    expect(table.timedOutEntries()).toEqual([0]);
  });

  test("a selector entry makes the rule's verdict page-dependent, so template fan-out does not copy it", () => {
    expect(new IgnoreTable([{ rule: RULE, selectors: ["form select"] }]).hasUrlEntries(RULE)).toBe(true);
    expect(new IgnoreTable([{ rule: RULE, items: ["x"] }]).hasUrlEntries(RULE)).toBe(false);
    const runner = new RuleRunner({ config: { rule_options: {}, rules: { enable: [RULE] }, ignore: [{ rule: RULE, selectors: ["form select"] }] } as never });
    expect(runner.ignoresByPage(RULE)).toBe(true);
  });
});

describe("the element path is bounded and only computed when an entry wants it (#1440 security review)", () => {
  const classes = Array.from({ length: 60_000 }, (_, i) => `c${i}`).join(" ");
  const hostile = (controls: number): string =>
    `<!doctype html><html><head><title>t</title></head><body><div class="${classes}"><form>${Array.from({ length: controls }, (_, i) => `<input type="text" name="n${i}">`).join("")}</form></div></body></html>`;
  const FORM_LABELS = "a11y/form-labels";
  const runOn = async (html: string, ignore?: IgnoreEntry[]): Promise<CheckResult[]> => {
    const runner = new RuleRunner({ config: { rule_options: {}, rules: { enable: [FORM_LABELS] }, ...(ignore ? { ignore } : {}) } as never, ruleTimeBudgetMs: 0 });
    const parsed = parsePage(html, URL);
    return (await runner.runPageRules({ url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed } as never)).ruleResults.get(FORM_LABELS)!.checks;
  };

  test("no selector entry: no path is computed (the rule is told not to), however many controls and however long the class", async () => {
    const started = performance.now();
    const checks = await runOn(hostile(5_000));
    expect(performance.now() - started).toBeLessThan(3_000);
    const unlabeled = checks.find((c) => c.name === "form-labels")!;
    expect(unlabeled.items).toHaveLength(5_000);
    // the rule itself, run with the flag unset, builds no path at all
    const { formLabelsRule } = await import("../src/a11y/form-labels");
    const direct = formLabelsRule.run({ page: { url: URL, html: "", statusCode: 200, loadTime: 0, headers: {} }, parsed: { document: parsePage(hostile(50), URL).document }, options: {} } as never);
    for (const check of direct.checks) for (const item of check.items ?? []) expect(Object.keys(item)).not.toContain("selector");
  }, 60_000);

  test("with a selector entry, a 409 KB class attribute and 5,000 controls are bounded and every control is waived", async () => {
    const started = performance.now();
    const checks = await runOn(hostile(5_000), [{ rule: FORM_LABELS, selectors: ["form input"] }]);
    expect(performance.now() - started).toBeLessThan(8_000);
    // every control sits in a `form` (the 409 KB class is read to 1 KB): all 5,000 are waived and the check is a pass
    const check = checks.find((c) => c.name === "form-labels")!;
    expect(check.status).toBe("pass");
    expect(check.message).toContain("5000 waived by squirrel.toml");
    expect(readIgnoredDetails(check.details)).toEqual({ items: 5_000, entries: [0] });
  }, 60_000);

  test("the path is capped in length, ancestors, classes and attribute read", () => {
    const nested = `${Array.from({ length: 40 }, () => `<div id="a${"b".repeat(30)}" class="${Array.from({ length: 20 }, (_, i) => `k${"x".repeat(35)}${i}`).join(" ")}">`).join("")}<p id="leaf">x</p>${"</div>".repeat(40)}`;
    const doc = parsePage(`<html><body>${nested}</body></html>`, URL).document!;
    const path = elementSelector(doc.getElementById("leaf")!);
    expect(path.length).toBeLessThanOrEqual(1_000);
    expect(path.split(" > ").length).toBeLessThanOrEqual(16);
    expect(path.endsWith("p#leaf")).toBe(true);
    for (const piece of path.split(" > ")) expect(piece.split(".").length - 1).toBeLessThanOrEqual(6);
  });

  test("selector matching is charged for its real work: a 16-ancestor path against 12-part selectors spends the entry's budget", () => {
    const selectors = Array.from({ length: 20 }, () => "a b c d e f g h i j k l");
    const timeouts: string[] = [];
    const table = new IgnoreTable([{ rule: RULE, selectors }], { onTimeout: (m) => timeouts.push(m), limits: { perEntry: 20_000 } });
    const path = Array.from({ length: 16 }, () => "div").join(" > ");
    for (let i = 0; i < 200; i++) table.filterChecks(RULE, URL, [{ name: "label-content-name-mismatch", status: "fail", message: "1 element(s)", items: [{ id: `i${i}`, selector: path }] }]);
    expect(timeouts).toHaveLength(1);
  });
});

describe("who computes a path, and what bounds it (#1440 review)", () => {
  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });
  let spy: ReturnType<typeof spyOn> | undefined;

  const PAGE_WITH_ALL = `<!doctype html><html><head><title>t</title></head><body><main>
<a href="https://x.example/a" aria-label="Zebra">Alpha</a>
<select id="s1"><option>a</option></select>
<form><input type="text" name="n1"></form>
</main></body></html>`;
  const runner = (ignore: IgnoreEntry[] | undefined, enable: string[]) =>
    new RuleRunner({ config: { rule_options: {}, rules: { enable }, ...(ignore ? { ignore } : {}) } as never, ruleTimeBudgetMs: 0 });
  const RULES3 = ["a11y/label-content-name-mismatch", "a11y/select-name", "a11y/form-labels"];
  const runAll = async (r: RuleRunner): Promise<void> => {
    const parsed = parsePage(PAGE_WITH_ALL, URL);
    await r.runPageRules({ url: URL, html: PAGE_WITH_ALL, statusCode: 200, loadTime: 0, headers: {}, parsed } as never);
  };

  test("the runner asks for a path only for a rule an entry with selectors names: none, another rule's entry, items-only entries", async () => {
    spy = spyOn(elementPath, "elementSelector");
    await runAll(runner(undefined, RULES3));
    expect(spy).toHaveBeenCalledTimes(0);
    await runAll(runner([{ rule: "a11y/button-name", selectors: ["main button"] }], RULES3)); // another rule's entry
    expect(spy).toHaveBeenCalledTimes(0);
    await runAll(runner([{ rule: RULES3[1]!, items: ["select#s1"] }], RULES3)); // an items entry has no selectors
    expect(spy).toHaveBeenCalledTimes(0);
    // an entry for ONE rule asks for the paths of that rule alone
    await runAll(runner([{ rule: "a11y/select-name", selectors: ["main select"] }], RULES3));
    expect(spy.mock.calls.length).toBe(1);
    spy.mockClear();
    await runAll(runner([{ rule: "a11y/*", selectors: ["main *"] }], RULES3)); // a glob names all three
    expect(spy.mock.calls.length).toBe(4); // label-content-name-mismatch 1, select-name 1, form-labels 2 (the input and the select)
  });

  test("each of the three rules builds a path only when told to", async () => {
    const { selectNameRule } = await import("../src/a11y/select-name");
    const { formLabelsRule } = await import("../src/a11y/form-labels");
    const { labelContentNameMismatchRule } = await import("../src/a11y/label-content-name-mismatch");
    spy = spyOn(elementPath, "elementSelector");
    const make = (wants: boolean) => ({
      page: { url: URL, html: PAGE_WITH_ALL, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(PAGE_WITH_ALL, URL),
      options: {},
      ...(wants ? { wantsItemSelectors: true } : {}),
    }) as never;
    for (const rule of [selectNameRule, formLabelsRule, labelContentNameMismatchRule]) {
      spy.mockClear();
      const off = rule.run(make(false));
      const offResult = (off instanceof Promise ? await off : off).checks;
      expect(spy, `${rule.meta.id} flag unset`).toHaveBeenCalledTimes(0);
      for (const check of offResult) for (const item of check.items ?? []) expect(Object.keys(item)).not.toContain("selector");
      const on = rule.run(make(true));
      const onResult = (on instanceof Promise ? await on : on).checks;
      expect(spy.mock.calls.length, `${rule.meta.id} flag set`).toBeGreaterThan(0);
      expect(onResult.some((c) => (c.items ?? []).some((i) => typeof i.selector === "string")), rule.meta.id).toBe(true);
    }
  });

  test("a class attribute is read only to 1,024 characters and an id past 40 is never in the path", () => {
    // 1,200 characters of unusable tokens, then `c7`; and a 41-character id.
    const junk = Array.from({ length: 300 }, (_, i) => `a!${i}`).join(" ");
    const doc = parsePage(`<html><body><div id="${"i".repeat(41)}" class="${junk} c7"><p id="leaf">x</p></div></body></html>`, URL).document!;
    const path = elementSelector(doc.getElementById("leaf")!);
    expect(path).toBe("html > body > div > p#leaf");
    const m = compileSelector("div.c7");
    expect(typeof m !== "string" && m.test(parsePath(path))).toBe(false);
    const ident = compileSelector(`#${"i".repeat(41)}`);
    expect(typeof ident !== "string" && ident.test(parsePath(path))).toBe(false);
    // within the first 1,024 characters the same class is used
    const near = parsePage(`<html><body><div class="a!b c7"><p id="leaf">x</p></div></body></html>`, URL).document!;
    expect(elementSelector(near.getElementById("leaf")!)).toBe("html > body > div.c7 > p#leaf");
  });

  test("a shared ancestor is read once, however many controls sit under it", () => {
    const doc = parsePage(`<html><body><div id="wrap" class="w"><form id="f">${Array.from({ length: 50 }, (_, i) => `<input id="i${i}">`).join("")}</form></div></body></html>`, URL).document!;
    const wrap = doc.getElementById("wrap")!;
    const form = doc.getElementById("f")!;
    const inputs = Array.from({ length: 50 }, (_, i) => doc.getElementById(`i${i}`)!); // looked up before counting: a lookup reads ids
    let reads = 0;
    for (const el of [wrap, form]) {
      const original = el.getAttribute.bind(el);
      el.getAttribute = ((name: string) => {
        reads++;
        return original(name);
      }) as typeof el.getAttribute;
    }
    for (const input of inputs) elementSelector(input);
    // wrap and form: id and class once each, not once per control
    expect(reads).toBeLessThanOrEqual(4);
  });

  test("a path is charged parts x segments squared: one 12-part selector on a 16-segment path spends a 2,000-step entry at once", () => {
    const path = Array.from({ length: 16 }, () => "div").join(" > ");
    const selector = Array.from({ length: 12 }, () => "div").join(" ");
    const timeouts: string[] = [];
    const table = new IgnoreTable([{ rule: RULE, selectors: [selector] }], { onTimeout: (m) => timeouts.push(m), limits: { perEntry: 2_000 } });
    const out = table.filterChecks(RULE, URL, [{ name: "label-content-name-mismatch", status: "fail", message: "1 element(s)", items: [{ id: "i", selector: path }] }])[0]!;
    // 12 x 16 x 16 = 3,072 steps is over the budget: the entry stops waiving and is reported. Charged only
    // parts x segments (192) it would have matched and waived the item.
    expect(out.status).toBe("fail");
    expect(timeouts).toHaveLength(1);
    expect(table.timedOutEntries()).toEqual([0]);
  });

  test("an ancestor whose tag name is not a plain name makes the whole path unmatchable (fails closed)", () => {
    const path = elementSelector(parsePage(`<html><body><svg:x><p id="leaf">x</p></svg:x></body></html>`, URL).document!.getElementById("leaf")!);
    const m = compileSelector("p");
    // either the path is built without the odd ancestor, or it does not parse: it never matches an ancestor selector wrongly
    const hit = typeof m !== "string" && m.test(parsePath(path));
    const wrong = compileSelector("svg p");
    expect(typeof wrong !== "string" && wrong.test(parsePath(path))).toBe(false);
    expect(typeof hit).toBe("boolean");
    expect(parsePath("html > body > o:p > p#leaf")).toEqual([]);
  });
});
