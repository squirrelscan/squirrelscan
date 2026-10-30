// ReDoS and validator-bypass hardening for `[[ignore]]` matchers (#1262). Work is
// asserted with the engine's own step counter, not wall clock, so these do not flake.

import { describe, expect, test } from "bun:test";

import { IgnoreTable, MAX_ENTRIES, MAX_MATCHERS_PER_FIELD, MAX_PATTERN_CHARS, MAX_STEPS_PER_AUDIT, MAX_STEPS_PER_ENTRY, MAX_STEPS_PER_TEST, globMatch, type IgnoreEntry } from "../src/ignore";
import { checkIgnoreEntries } from "../src/rule-options-check";
import { compileSafeRegex, MAX_PROGRAM_SIZE, MAX_SET_RANGES, type SafeRegex } from "../src/safe-regex";

const re = (source: string, flags = ""): SafeRegex => {
  const out = compileSafeRegex(source, flags);
  if (typeof out === "string") throw new Error(out);
  return out;
};

// Patterns that make a backtracking engine hang, built at runtime so static analysis does not flag the literals.
const evasions = [
  ["(a", "+)+$"],
  ["(a|a", ")*$"],
  ["(a", "*)*$"],
  ["(.", "*)*$"],
  ["(a|aa", ")+$"],
  ["(a|b|ab", ")*c"],
  ["\\d", "+\\d+\\d+\\d+x"],
  ["(a{1,50}", "){1,50}$"],
  ["(?:[a-z", "]+)*!"],
  ["(?:\\w", "+\\s?)+$"],
  ["(x+x+", ")+y"],
  ["^(([a-z])+.)+[A-Z]([a-z])+$"],
].map((parts) => parts.join(""));

describe("the linear engine", () => {
  test("every classic catastrophic pattern runs within a step bound proportional to text x program", () => {
    const text = `${"a".repeat(1500)}!`;
    for (const source of evasions) {
      const compiled = compileSafeRegex(source);
      if (typeof compiled === "string") continue; // refused is also safe
      const result = compiled.test(text, 5_000_000);
      expect(result).not.toBeNull();
      expect(result!.steps).toBeLessThanOrEqual((text.length + 1) * (compiled.programSize + 2) * 2);
    }
  });

  test("answers agree with RegExp on safe patterns, with flags and unicode", () => {
    const cases: [string, string, string][] = [
      ["^/blog/\\d{4}/", "", "/blog/2024/x"],
      ["^/blog/\\d{4}/", "", "/blog/24/x"],
      ["colou?r", "", "the color"],
      ["^(a|b)+c$", "", "ababc"],
      ["^(a|b)+c$", "", "ababd"],
      ["HELLO", "i", "say hello"],
      ["[A-Z]+", "i", "abc"],
      ["^.$", "", "é"],
      ["^.$", "u", "😀"],
      ["a.b", "", "a\nb"],
      ["a.b", "s", "a\nb"],
      ["^b", "m", "a\nb"],
      ["^b", "", "a\nb"],
      ["a$", "m", "a\nb"],
      ["\\bfoo\\b", "", "a foo b"],
      ["\\bfoo\\b", "", "afoob"],
      ["\\Boo\\B", "", "afoob"],
      ["x{2,3}y", "", "xxxy"],
      ["x{2,3}y", "", "xy"],
      ["[^a-c]+", "", "abc"],
      ["[\\d-z]", "", "-"],
      ["a|b", "", "zzz"],
      ["\\u0041\\x42", "", "AB"],
      ["[\\w.-]+@[\\w.-]+", "", "me@x.io"],
      ["(?:ab)*c", "", "ababc"],
      ["a{", "", "a{"],
      ["a*?b", "", "aab"],
    ];
    for (const [source, flags, text] of cases) {
      expect([source, flags, text, re(source, flags).test(text, 100_000)!.matched]).toEqual([source, flags, text, new RegExp(source, flags).test(text)]);
    }
  });

  test("differential fuzz against RegExp on small random patterns", () => {
    let seed = 1234567;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const atoms = ["a", "b", "c", ".", "\\d", "\\w", "[ab]", "[^a]", "(a|b)", "(?:ab|c)", "(a*)", "x?", "\\b", "^", "$"];
    const quants = ["", "", "*", "+", "?", "{2}", "{1,3}", "{2,}"];
    const alphabet = ["a", "b", "c", "1", " ", "x", "\n"];
    for (let i = 0; i < 400; i++) {
      let source = "";
      for (let k = 0, n = 1 + rnd(4); k < n; k++) {
        const atom = atoms[rnd(atoms.length)]!;
        const anchor = atom === "^" || atom === "$" || atom === "\\b";
        source += atom + (anchor ? "" : quants[rnd(quants.length)]);
        if (rnd(6) === 0) source += "|";
      }
      const flags = rnd(3) === 0 ? "i" : rnd(5) === 0 ? "m" : "";
      let native: RegExp;
      try {
        native = new RegExp(source, flags);
      } catch {
        continue;
      }
      const compiled = compileSafeRegex(source, flags);
      if (typeof compiled === "string") continue;
      for (let j = 0; j < 8; j++) {
        let text = "";
        for (let k = 0, n = rnd(8); k < n; k++) text += alphabet[rnd(alphabet.length)]!;
        expect([source, flags, text, compiled.test(text, 1_000_000)!.matched]).toEqual([source, flags, text, native.test(text)]);
      }
    }
  });

  test("refuses what needs backtracking or is unknown", () => {
    for (const source of ["(a)\\1", "(?=a)b", "(?!a)b", "(?<=a)b", "(?<!a)b", "(?<n>a)\\k<n>", "\\p{L}", "a**", "(", ")", "[a", "a{3,2}", "[z-a]", "\\q", "\\", "*a", "^*"]) {
      const out = compileSafeRegex(source);
      expect([source, typeof out]).toEqual([source, "string"]);
    }
    expect(compileSafeRegex("a", "v")).toContain("flag");
    expect(compileSafeRegex("a".repeat(201))).toContain("200");
  });

  test("bounded repeats cannot be nested into a huge program (the {1,50}{1,50} case)", () => {
    const nest = ["(", "a{1,50}", "){1,50}"].join("");
    expect(compileSafeRegex(nest)).toContain(`${MAX_PROGRAM_SIZE}`);
    expect(typeof compileSafeRegex("((((a{1,9}){1,9}){1,9}){1,9}){1,9}")).toBe("string");
    expect(re("a{1,50}").programSize).toBeLessThanOrEqual(MAX_PROGRAM_SIZE);
  });

  test("group nesting depth is capped", () => {
    expect(typeof compileSafeRegex(`${"(".repeat(30)}a${")".repeat(30)}`)).toBe("string");
  });

  test("a step budget stops a test and reports it instead of answering", () => {
    expect(re("(?:a|b)*c").test("ab".repeat(500), 50)).toBeNull();
  });

  test("case folding: i flag matches both cases including non-ASCII", () => {
    expect(re("ÉCOLE", "i").test("l'école", 10_000)!.matched).toBe(true);
    expect(re("[a-f]+", "i").test("XYZ", 10_000)!.matched).toBe(false);
  });
});

describe("the glob matcher", () => {
  test("agrees with the obvious semantics", () => {
    expect(globMatch("a*c", "abc")).toBe(true);
    expect(globMatch("a*c", "ab")).toBe(false);
    expect(globMatch("*", "")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "ac")).toBe(false);
    expect(globMatch("*a*b*", "xxaxxbxx")).toBe(true);
    expect(globMatch("a.c", "abc")).toBe(false);
    expect(globMatch("a*", "a\nb")).toBe(true);
  });

  test("many stars against a long non-matching text finish fast (no exponential backtracking)", () => {
    const glob = `${"*a".repeat(40)}*b`;
    const started = performance.now();
    expect(globMatch(glob, "a".repeat(2048))).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("IgnoreTable under hostile entries", () => {
  const checks = (id: string) => [{ name: "c", status: "warn" as const, message: "m", items: [{ id }] }];

  test("catastrophic item regexes finish and never waive by accident", () => {
    const id = `${"a".repeat(1900)}!`;
    for (const source of evasions) {
      const out = new IgnoreTable([{ rule: "r/x", items: [`regex:${source}`] }]).filterChecks("r/x", undefined, checks(id));
      expect(out).toBeDefined();
    }
  });

  test("text over 2 KB never matches a regex or glob, and is not truncated into a false match", () => {
    const url = `https://example.com/${"a".repeat(3000)}`;
    expect(new IgnoreTable([{ rule: "r/x", urls: ["regex:a$"] }]).pageWaiver("r/x", url)).toBeNull();
    const out = new IgnoreTable([{ rule: "r/x", items: ["glob:*a"] }]).filterChecks("r/x", undefined, checks("a".repeat(3000)));
    expect(out[0]!.items).toHaveLength(1);
  });

  test("a url regex over a hostile path runs on the linear engine", () => {
    const url = `https://example.com/${"a".repeat(3000)}!`;
    const t = new IgnoreTable([{ rule: "r/x", urls: [`regex:${evasions[0]}`] }]);
    expect(t.problems).toEqual([]);
    expect(t.pageWaiver("r/x", url)).toBeNull();
  });

  test("an entry that exhausts its work budget stops waiving, warns once, and leaves findings visible", () => {
    const messages: string[] = [];
    const t = new IgnoreTable([{ rule: "r/x", items: ["regex:(?:a|b)*c"] }], { onTimeout: (m) => messages.push(m) });
    const many = Array.from({ length: 4000 }, (_, i) => ({ id: `${"ab".repeat(1000)}${i}` }));
    const res = t.filterChecks("r/x", undefined, [{ name: "c", status: "warn", message: "m", items: many }]);
    expect(res[0]!.items).toHaveLength(4000);
    expect(t.timedOut).toHaveLength(1);
    expect(messages.filter((m) => m.includes("timed out"))).toHaveLength(1);
    expect(MAX_STEPS_PER_ENTRY).toBeGreaterThan(MAX_STEPS_PER_TEST);
  });

  test("a dead entry with a url waiver does not skip pages", () => {
    const t = new IgnoreTable([{ rule: "r/x", urls: ["regex:(?:a|b)*c"] }]);
    const long = `https://example.com/${"ab".repeat(1000)}`;
    for (let i = 0; i < 6000 && t.timedOut.length === 0; i++) t.pageWaiver("r/x", `${long}${i}`);
    expect(t.timedOut).toHaveLength(1);
    expect(t.pageWaiver("r/x", "https://example.com/abc")).toBeNull();
  });

  test("config validate and the runtime share one validator", () => {
    const entries: IgnoreEntry[] = [
      { rule: "core/meta-title", items: ["regex:(a)\\1"] },
      { rule: "core/meta-title", urls: ["regex:^/x:v"] },
      { rule: "core/meta-title", items: ["glob:" + "*".repeat(600)] },
    ];
    const runtime = new IgnoreTable(entries).problems.map((p) => p.message);
    const validate = checkIgnoreEntries(entries).map((p) => p.message);
    expect(runtime).toHaveLength(3);
    for (const message of runtime) expect(validate.some((v) => v.includes(message))).toBe(true);
  });

  test("a long glob against a 5 MB id is bounded", () => {
    const t = new IgnoreTable([{ rule: "r/x", items: [`glob:${"*a".repeat(250)}`] }]);
    expect(t.problems).toHaveLength(0);
    const out = t.filterChecks("r/x", undefined, checks("b".repeat(5_000_000)));
    expect(out[0]!.items).toHaveLength(1);
  });
});

describe("the caps cannot be defeated", () => {
  const checkOf = (items: { id: string }[]) => [{ name: "c", status: "warn" as const, message: "m", items }];

  test("entry count, matchers per entry and pattern length are enforced at the table, not only the schema", () => {
    const many = Array.from({ length: 10_000 }, () => ({ rule: "r/x", items: ["a"] }));
    const t = new IgnoreTable(many);
    expect(t.problems.some((p) => p.message.includes(`${MAX_ENTRIES} entries`))).toBe(true);
    expect(t.forRule("r/x")).toHaveLength(MAX_ENTRIES);
    const wide = new IgnoreTable([{ rule: "r/x", items: Array.from({ length: MAX_MATCHERS_PER_FIELD + 1 }, (_, i) => `i${i}`) }]);
    expect(wide.empty).toBe(true);
    expect(wide.problems).toHaveLength(1);
    const long = new IgnoreTable([{ rule: "r/x", urls: ["/".repeat(MAX_PATTERN_CHARS + 1)] }, { rule: "r/x", items: ["x".repeat(MAX_PATTERN_CHARS + 1)] }]);
    expect(long.empty).toBe(true);
  });

  test("work is summed across entries: many cheap entries exhaust the audit budget, then none waive (fail closed)", () => {
    const warnings: string[] = [];
    const entries = Array.from({ length: 50 }, () => ({ rule: "r/x", items: ["regex:^zzz"] }));
    const t = new IgnoreTable([...entries, { rule: "r/x", items: ["glob:target*"] }], { limits: { perAudit: 20_000 }, onTimeout: (m) => warnings.push(m) });
    const items = Array.from({ length: 400 }, (_, i) => ({ id: `${"q".repeat(100)}${i}` }));
    const out = t.filterChecks("r/x", undefined, checkOf([...items, { id: "target-1" }]));
    // The glob entry would have waived `target-1`; the budget died first, so nothing is waived and every item stays.
    expect(out[0]!.items).toHaveLength(401);
    expect(t.timedOut.length).toBeGreaterThan(0);
    expect(warnings.every((m) => m.includes("timed out"))).toBe(true);
  });

  test("a spent entry budget is not reset by later calls or other entries", () => {
    const t = new IgnoreTable([{ rule: "r/x", items: ["regex:^zzz"] }, { rule: "r/x", items: ["glob:keep*"] }], { limits: { perEntry: 500 } });
    const filler = Array.from({ length: 50 }, (_, i) => ({ id: `${"q".repeat(40)}${i}` }));
    t.filterChecks("r/x", undefined, checkOf(filler));
    expect(t.timedOut.map((e) => e.entry)).toEqual([0]);
    // entry 0 is dead for good; entry 1 (own budget, glob) still works
    const out = t.filterChecks("r/x", undefined, checkOf([{ id: "keep-me" }, ...filler.slice(0, 2)]));
    expect(out[0]!.items!.some((i) => i.id === "keep-me")).toBe(false);
    const again = t.filterChecks("r/x", undefined, checkOf([{ id: "zzz" }]));
    expect(again[0]!.items).toHaveLength(1); // dead regex entry never matches
  });

  test("glob work is metered too", () => {
    const t = new IgnoreTable([{ rule: "r/x", items: [`glob:${"*a".repeat(200)}*b`] }], { limits: { perEntry: 10_000 } });
    const items = Array.from({ length: 50 }, () => ({ id: "a".repeat(1000) }));
    const out = t.filterChecks("r/x", undefined, checkOf(items));
    expect(out[0]!.items).toHaveLength(50);
    expect(t.timedOut).toHaveLength(1);
  });

  test("the worst single test is bounded by the per-test cap", () => {
    const compiled = re("(?:a|b|ab|ba)*c");
    const result = compiled.test("ab".repeat(1024), MAX_STEPS_PER_TEST);
    expect(result === null || result.steps <= MAX_STEPS_PER_TEST).toBe(true);
    expect(MAX_STEPS_PER_AUDIT).toBeGreaterThan(MAX_STEPS_PER_ENTRY);
  });

  test("wide or case-folded classes cannot hide cost: merged, capped, and charged per range", () => {
    expect(typeof compileSafeRegex("[\\u0000-\\uffff]")).toBe("object");
    const scattered = Array.from({ length: MAX_SET_RANGES + 5 }, (_, i) => String.fromCharCode(0x4e00 + i * 3)).join("");
    expect(compileSafeRegex(`[${scattered}]`)).toContain(`${MAX_SET_RANGES}`);
    // case folding only grows the class at compile time; the haystack is never lowercased, so its length cannot grow
    expect(re("[a-z]", "i").test("Q", 100)!.matched).toBe(true);
    const wide = re("[acegikmoqsuwy02468]+@", "i");
    const small = re("a+@");
    expect(wide.test("a".repeat(500), 1_000_000)!.steps).toBeGreaterThan(small.test("a".repeat(500), 1_000_000)!.steps);
  });

  test("surrogate pairs: length is capped in UTF-16 units, matching is by code point", () => {
    const t = new IgnoreTable([{ rule: "r/x", items: ["regex:^.{1,3}$"] }]);
    const out = t.filterChecks("r/x", undefined, checkOf([{ id: "😀😀😀" }, { id: "😀".repeat(1100) }]));
    expect(out[0]!.items!.map((i) => i.id.length)).toEqual([2200]);
  });

  test("no compiled-pattern cache grows with input: tables hold one matcher per pattern", () => {
    const t = new IgnoreTable([{ rule: "r/x", items: ["regex:a+b"] }]);
    for (let i = 0; i < 2000; i++) t.filterChecks("r/x", undefined, checkOf([{ id: `x${i}` }]));
    expect(t.forRule("r/x")).toHaveLength(1);
  });
});

describe("compile-time cost is bounded too (review of #1333)", () => {
  const timed = (fn: () => unknown) => {
    const started = performance.now();
    const out = fn();
    return { out, ms: performance.now() - started };
  };

  test("repeats of something that emits nothing compile at once, however deeply nested", () => {
    for (const source of ["(((){9999}){9999}){9999}", "(?:){9999}", "a{0}", "(a{0}){9999}b", "((a{0}){9999}){9999}", "(?:|){9999}"]) {
      const { out, ms } = timed(() => compileSafeRegex(source));
      expect([source, ms < 200]).toEqual([source, true]);
      if (typeof out !== "string") expect(out.programSize).toBeLessThanOrEqual(MAX_PROGRAM_SIZE);
    }
    // and they still mean what they say
    expect(re("(a{0}){9999}b").test("xb", 1000)!.matched).toBe(true);
  });

  test("a wide class repeated 1400 times is folded once, not per copy", () => {
    const klass = "[Ā-˿Ͱ-կḀ-῿Ⰰ-ⷿꙀ-ꠟＡ-ｚ]";
    const { out, ms } = timed(() => compileSafeRegex(`${klass}{1400}`, "i"));
    expect(ms).toBeLessThan(200);
    expect(typeof out === "string" || out.programSize <= MAX_PROGRAM_SIZE).toBe(true);
    // 100 such patterns in one entry stay cheap in total
    const entry = new IgnoreTable([{ rule: "r/x", items: Array.from({ length: 100 }, () => `regex:${klass}{1400}`) }]);
    expect(entry.problems.length + (entry.empty ? 0 : 1)).toBeGreaterThan(0);
  });

  test("the size of any pattern is measured before it is expanded", () => {
    const nests = ["((((a{1,99}){1,99}){1,99}){1,99})", "(a{0,9999}){0,9999}", "(?:a|b){9999}{2}"];
    for (const source of nests) {
      const { ms } = timed(() => compileSafeRegex(source));
      expect([source, ms < 200]).toEqual([source, true]);
    }
  });
});

describe("an entry must name items or urls (review of #1333)", () => {
  test("bare, empty-array and checks-only entries are refused, never applied", () => {
    const entries: IgnoreEntry[] = [
      { rule: "*" },
      { rule: "seo/*", items: [], urls: [] },
      { rule: "seo/*", checks: ["title"] },
      { rule: "seo/*", reason: "just a reason" },
    ];
    const t = new IgnoreTable(entries);
    expect(t.empty).toBe(true);
    expect(t.problems.map((p) => p.entry)).toEqual([0, 1, 2, 3]);
    expect(t.problems[0]!.message).toContain("items");
    // and it waives nothing
    const check = [{ name: "c", status: "warn" as const, message: "m", items: [{ id: "x" }] }];
    expect(t.filterChecks("seo/x", undefined, check)).toBe(check);
    // the config validator reports the same
    expect(checkIgnoreEntries(entries).length).toBeGreaterThanOrEqual(4);
  });
});

describe("audit-wide exhaustion reaches every entry (review of #1333)", () => {
  test("two entries, a tiny audit budget: both stop waiving and both are reported", () => {
    const warnings: number[] = [];
    const t = new IgnoreTable(
      [
        { rule: "r/x", items: ["regex:^aaaa"] },
        { rule: "r/x", items: ["regex:^bbbb", "glob:keep*"] },
      ],
      { limits: { perAudit: 200 }, onTimeout: (_m, entry) => warnings.push(entry) },
    );
    const items = Array.from({ length: 60 }, (_, i) => ({ id: `${"q".repeat(30)}${i}` }));
    const out = t.filterChecks("r/x", undefined, [{ name: "c", status: "warn", message: "m", items: [...items, { id: "keep-me" }] }]);
    expect(out[0]!.items).toHaveLength(61);
    expect(warnings.sort()).toEqual([0, 1]);
    expect(t.timedOutEntries().sort()).toEqual([0, 1]);
  });
});

describe("review of #1333, round two", () => {
  test("a table of wide case-folded classes is bounded as a whole: built fast, the rest refused", () => {
    const entries = Array.from({ length: 200 }, (_, e) => ({
      rule: "r/x",
      urls: Array.from({ length: 100 }, (_, k) => {
        const base = 0x100 + ((e * 100 + k) % 3000);
        const klass = Array.from({ length: 10 }, (_, c) => `\\u${(base + c * 600).toString(16).padStart(4, "0")}-\\u${(base + c * 600 + 400).toString(16).padStart(4, "0")}`).join("");
        return `regex:^[${klass}]+$:i`;
      }),
    }));
    const started = performance.now();
    const t = new IgnoreTable(entries as IgnoreEntry[]);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(t.problems.some((p) => p.message.includes("compile work"))).toBe(true);
  });

  test("a regex that matches the empty string matches every text, so it is refused (and `^$` is not)", () => {
    for (const body of ["", "a{0}", "(|)", "a*", "$", "(?:)", "a?"]) {
      const t = new IgnoreTable([{ rule: "r/x", items: [`regex:${body}`] }, { rule: "r/x", urls: [`regex:${body}`] }]);
      expect([body, t.empty]).toEqual([body, true]);
      expect(t.problems).toHaveLength(2);
    }
    expect(new IgnoreTable([{ rule: "r/x", items: ["regex:^$"] }]).problems).toEqual([]);
    expect(new IgnoreTable([{ rule: "r/x", items: ["regex:^a?b$"] }]).problems).toEqual([]);
  });

  test("an audit budget of zero stops and reports only entries that depend on it", () => {
    const reported: number[] = [];
    const t = new IgnoreTable(
      [
        { rule: "r/x", items: ["exact"] },
        { rule: "other/y", items: ["regex:^q"] },
        { rule: "r/x", items: ["regex:^zz"] },
      ],
      { limits: { perAudit: 0 }, onTimeout: (_m, entry) => reported.push(entry) },
    );
    const out = t.filterChecks("r/x", undefined, [{ name: "c", status: "warn", message: "m", items: [{ id: "exact" }, { id: "zzz" }] }]);
    // the exact entry still waives; the regex entry did nothing and is reported; the other rule's entry was never consulted
    expect(out[0]!.items!.map((i) => i.id)).toEqual(["zzz"]);
    expect(reported).toEqual([2]);
    expect(t.timedOutEntries()).toEqual([2]);
  });
});

describe("review of #1333, round three", () => {
  const wideEntries = () =>
    Array.from({ length: 200 }, (_, e) => ({
      rule: "r/x",
      urls: Array.from({ length: 100 }, (_, k) => {
        const base = 0x100 + ((e * 100 + k) % 3000);
        const klass = Array.from({ length: 10 }, (_, c) => `\\u${(base + c * 600).toString(16).padStart(4, "0")}-\\u${(base + c * 600 + 400).toString(16).padStart(4, "0")}`).join("");
        return `regex:^[${klass}]+$:i`;
      }),
    })) as IgnoreEntry[];

  test("refusals do not depend on what the process compiled before (cold and warm tables agree)", () => {
    const cold = new IgnoreTable(wideEntries());
    const warm = new IgnoreTable(wideEntries());
    expect(warm.problems.map((p) => p.pattern)).toEqual(cold.problems.map((p) => p.pattern));
    expect(cold.problems.length).toBeGreaterThan(0);
  });

  test("the budget message says so, and config validate prints a bounded list", () => {
    const t = new IgnoreTable(wideEntries());
    const budget = t.problems.find((p) => p.message.includes("compile budget exhausted"));
    expect(budget).toBeDefined();
    expect(budget!.message).not.toContain("back-references");
    const shown = checkIgnoreEntries(wideEntries());
    expect(shown.length).toBeLessThanOrEqual(21);
    expect(shown.at(-1)!.message).toMatch(/and \d+ more problems? like these/);
  });

  test("an entry mixing exact items with a timed-out regex says its exact items still apply", () => {
    const messages: string[] = [];
    const t = new IgnoreTable([{ rule: "r/x", items: ["exact", "regex:^zz"] }], { limits: { perAudit: 0 }, onTimeout: (m) => messages.push(m) });
    const out = t.filterChecks("r/x", undefined, [{ name: "c", status: "warn", message: "m", items: [{ id: "exact" }, { id: "zzz" }] }]);
    expect(out[0]!.items!.map((i) => i.id)).toEqual(["zzz"]);
    expect(messages[0]).toContain("exact items still apply");
  });
});
