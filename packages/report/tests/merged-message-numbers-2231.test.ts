// #2231 — a check merged across pages whose messages disagreed on a number used
// to render the literal `N` in place of every number in the message. On a
// 196-site corpus that was 75 distinct rules and 163 of the sites.
//
// The rule now: only a COUNT may widen, and it widens to a range. Everything
// else a digit run can be — a date, a decimal, a digit inside a word, an
// identifier, a negative, a zero-padded code — is part of a statement, and
// widening it invents a fact. `The URL says 2019 but the schema dates are from
// 2018` would become `The URL says 2019 to 2024 …`, which reads as true and is
// not. Pages that disagree about such a token are not merged at all; each keeps
// its own message. See isCountToken in src/grouping.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReportRuleResult } from "@squirrelscan/core-contracts";

import { affectedPages } from "../src/affected-pages";
import { groupIssuesByCategory } from "../src/grouping";

function grouped(messages: string[], name = "c") {
  const results: Record<string, ReportRuleResult> = {
    "core/x": {
      meta: {
        id: "core/x",
        name: "core/x",
        description: "",
        category: "core",
        scope: "page",
        severity: "warning",
        weight: 5,
      },
      checks: messages.map((message, i) => ({
        name,
        status: "warn" as const,
        message,
        pageUrl: `https://acme.test/p${i}`,
      })),
    },
  };
  return groupIssuesByCategory(results)[0]!.rules[0]!.checks;
}

/** The single merged message; fails loudly if the pages did not merge. */
function merged(messages: string[]): string {
  const checks = grouped(messages);
  expect(checks).toHaveLength(1);
  return checks[0]!.message;
}

/** Every message the pages produced, sorted, when they are NOT expected to merge. */
function split(messages: string[]): string[] {
  return grouped(messages)
    .map((c) => c.message)
    .sort();
}

/** A bare `N` where a number belongs: the placeholder this issue is about. */
const BARE_N = /(?<![A-Za-z0-9])N(?![A-Za-z0-9])/;

describe("#2231 counts widen into a range", () => {
  test("pages that disagree on a count render the range they cover", () => {
    // The first page carries neither end of the range, so a merge that only
    // ever widens upward (or only downward) cannot produce this.
    const message = merged([
      "7 image(s) missing width/height (causes CLS)",
      "12 image(s) missing width/height (causes CLS)",
      "3 image(s) missing width/height (causes CLS)",
    ]);
    expect(message).toBe("3 to 12 image(s) missing width/height (causes CLS)");
    expect(message).not.toMatch(BARE_N);
  });

  test("a count alone in parentheses widens", () => {
    expect(merged(["Multiple H1 tags found (3)", "Multiple H1 tags found (6)"])).toBe(
      "Multiple H1 tags found (3 to 6)"
    );
  });

  test("a threshold every page agrees on keeps its own value", () => {
    expect(merged(["Thin content: 143 words (min 300)", "Thin content: 87 words (min 300)"])).toBe(
      "Thin content: 87 to 143 words (min 300)"
    );
  });

  test("a configured threshold glued to a unit survives", () => {
    expect(
      merged(["2 large inline SVG(s) (>4KB each)", "7 large inline SVG(s) (>4KB each)"])
    ).toBe("2 to 7 large inline SVG(s) (>4KB each)");
  });

  test("one page is left exactly as the rule wrote it", () => {
    expect(merged(["9 image(s) missing width/height (causes CLS)"])).toBe(
      "9 image(s) missing width/height (causes CLS)"
    );
  });

  test("pages that agree on every count are left exactly as written", () => {
    expect(merged(["Element with 7 children found", "Element with 7 children found"])).toBe(
      "Element with 7 children found"
    );
  });

  test("a message with no numbers merges unchanged", () => {
    expect(merged(["No Content-Security-Policy header", "No Content-Security-Policy header"])).toBe(
      "No Content-Security-Policy header"
    );
  });

  test("messages that differ in more than their counts stay separate checks", () => {
    expect(split(["3 image(s) missing alt", "3 link(s) missing text"])).toEqual([
      "3 image(s) missing alt",
      "3 link(s) missing text",
    ]);
  });
});

// The cases from the pub#374 acceptance review. Each one is a digit run that is
// NOT a count, and each produced a plausible falsehood when everything widened.
describe("#2231 a token that is not a count never widens", () => {
  test("differing years are not a date range", () => {
    expect(
      split([
        "The URL says 2019 but the Article schema dates are from 2018",
        "The URL says 2024 but the Article schema dates are from 2023",
      ])
    ).toEqual([
      "The URL says 2019 but the Article schema dates are from 2018",
      "The URL says 2024 but the Article schema dates are from 2023",
    ]);
  });

  test("a year in front of a word is still not a count", () => {
    // The year is the ONLY thing that differs, and it sits exactly where a
    // count sits: a standalone integer in front of a word. Nothing else in the
    // sentence can split these two apart.
    expect(
      split([
        "The URL says 2019 but the schema disagrees",
        "The URL says 2024 but the schema disagrees",
      ])
    ).toEqual([
      "The URL says 2019 but the schema disagrees",
      "The URL says 2024 but the schema disagrees",
    ]);
  });

  test("a full date is not widened, part by part", () => {
    const messages = [
      "This Article states datePublished 2022-01-07T05:19 in its schema",
      "This Article states datePublished 2024-11-30T21:04 in its schema",
    ];
    expect(split(messages)).toEqual([...messages].sort());
  });

  test("a decimal size is not a range", () => {
    expect(
      split([
        "HTML is 4.3MB, which exceeds the Googlebot 2MB limit",
        "HTML is 7.1MB, which exceeds the Googlebot 2MB limit",
      ])
    ).toEqual([
      "HTML is 4.3MB, which exceeds the Googlebot 2MB limit",
      "HTML is 7.1MB, which exceeds the Googlebot 2MB limit",
    ]);
  });

  test("a digit inside a word keeps its own group", () => {
    // `Multiple H1 tags found (3)` and `Multiple H2 tags found (6)` used to
    // share a merge key and render `Multiple H1-2 tags found (3-6)`.
    expect(split(["Multiple H1 tags found (3)", "Multiple H2 tags found (6)"])).toEqual([
      "Multiple H1 tags found (3)",
      "Multiple H2 tags found (6)",
    ]);
  });

  test("a negative number is not widened by magnitude", () => {
    expect(split(["Offset -5 px", "Offset -12 px"])).toEqual(["Offset -12 px", "Offset -5 px"]);
  });

  test("a zero-padded code keeps its padding", () => {
    expect(split(["Code 007 returned", "Code 500 returned"])).toEqual([
      "Code 007 returned",
      "Code 500 returned",
    ]);
  });

  test("a ratio is not widened", () => {
    expect(split(["4/10 pages lack a validator", "9/10 pages lack a validator"])).toEqual([
      "4/10 pages lack a validator",
      "9/10 pages lack a validator",
    ]);
  });

  test("a number too long to survive a round trip through Number is not a count", () => {
    const a = `Cache key ${"9".repeat(20)} repeated`;
    const b = `Cache key ${"8".repeat(20)} repeated`;
    expect(split([a, b])).toEqual([b, a]);
  });
});

describe("#2231 the merged message is accompanied by its page count", () => {
  test("a merged check reports how many pages contributed", () => {
    const checks = grouped([
      "3 image(s) missing width/height (causes CLS)",
      "11 image(s) missing width/height (causes CLS)",
      "5 image(s) missing width/height (causes CLS)",
    ]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.message).toBe("3 to 11 image(s) missing width/height (causes CLS)");
    // The count a renderer shows beside the message: the range says what each
    // page reported, this says how many pages there were.
    expect(affectedPages(checks[0]!).count).toBe(3);
    expect(checks[0]!.pages).toHaveLength(3);
  });

  test("a check carrying its own items keeps every one of them", () => {
    const results: Record<string, ReportRuleResult> = {
      "images/x": {
        meta: {
          id: "images/x",
          name: "images/x",
          description: "",
          category: "images",
          scope: "page",
          severity: "warning",
          weight: 5,
        },
        checks: [
          {
            name: "c",
            status: "warn",
            message: "2 image(s) missing width/height",
            pageUrl: "https://acme.test/a",
            items: [{ id: "https://acme.test/img/a1.png" }, { id: "https://acme.test/img/a2.png" }],
          },
          {
            name: "c",
            status: "warn",
            message: "1 image(s) missing width/height",
            pageUrl: "https://acme.test/b",
            items: [{ id: "https://acme.test/img/b1.png" }],
          },
        ],
      },
    };
    const check = groupIssuesByCategory(results)[0]!.rules[0]!.checks[0]!;
    expect(check.message).toBe("1 to 2 image(s) missing width/height");
    expect((check.items ?? []).map((i) => i.id)).toEqual([
      "https://acme.test/img/a1.png",
      "https://acme.test/img/a2.png",
      "https://acme.test/img/b1.png",
    ]);
  });
});

// ── Guard over every rule's own message templates ──────────────────────────
//
// Not a hand-typed list: the templates are read from the rules package's source
// at test time, so a rule added tomorrow is covered without touching this file.
// Each template is turned into two messages that differ in every numeric
// position, merged, and checked for the two ways this can go wrong.

const RULES_SRC = join(import.meta.dir, "..", "..", "rules", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Every `message:` template literal in the rules package, with its ${…} holes. */
function messageTemplates(): { file: string; template: string }[] {
  const out: { file: string; template: string }[] = [];
  for (const file of sourceFiles(RULES_SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/message:\s*`([^`]{4,200})`/g)) {
      out.push({ file, template: match[1]! });
    }
    for (const match of text.matchAll(/message:\s*"([^"\\]{4,200})"/g)) {
      out.push({ file, template: match[1]! });
    }
  }
  return out;
}

/** Fill a template's `${…}` holes and its literal digit runs with `value`. */
function fill(template: string, value: number): string {
  return template
    .replace(/\$\{[^}]*\}/g, String(value))
    .replace(/\d+/g, (run) => (run.length > 4 ? run : String(value)));
}

describe("#2231 guard: every rule's message templates survive a merge", () => {
  const templates = messageTemplates();

  test("the rules package yields a usable corpus of templates", () => {
    expect(templates.length).toBeGreaterThan(100);
  });

  test("no merged message carries a bare N", () => {
    const offenders: string[] = [];
    for (const { file, template } of templates) {
      for (const message of grouped([fill(template, 3), fill(template, 17)]).map((c) => c.message)) {
        if (BARE_N.test(message)) offenders.push(`${file}: ${message}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no merged message invents a range in a token that is not a count", () => {
    // Every token of the output must be either a token one of the inputs
    // actually wrote, or a `<int> to <int>` range standing where a bare integer
    // stood. `HTML is 2-4.3-7MB` is neither, which is what the first version of
    // this guard failed to notice.
    const offenders: string[] = [];
    for (const { file, template } of templates) {
      const a = fill(template, 3);
      const b = fill(template, 17);
      for (const message of grouped([a, b]).map((c) => c.message)) {
        if (message === a || message === b) continue;
        const rebuilt = message.replace(/(?<![A-Za-z0-9._:/,-])(\d+) to (\d+)(?![A-Za-z0-9._:/,-])/g, "3");
        if (rebuilt !== a) offenders.push(`${file}\n  in : ${a}\n  out: ${message}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
