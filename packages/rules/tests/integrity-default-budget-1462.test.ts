// #1462: the hostile shapes of the integrity rules' attribute budget, through RuleRunner. Each shape has two tests: with the budget
// off, the real control is found or `controlsUnread` is reported; and a run at the DEFAULT rule budget (2 s wall-clock), which is
// only a fair test on a machine that is not busy and is skipped otherwise: the rules are not abandoned.
// Synthetic pages.

import { cpus, loadavg } from "node:os";

import { parsePage } from "@squirrelscan/parser";

import { RuleRunner } from "../src/runner";

const url = "https://example.com/";
const MB = 1_048_576;
const OFF = "https://credential-fixture.invalid/signin";
const O = "https://o.invalid/x";
const REAL = `<a href="${OFF}">Sign in with Google</a>`;
const page = (body: string) => `<!doctype html><html><head><title>Fixture</title></head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
const rep = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length));

type Check = { name?: string; status?: string; details?: Record<string, unknown> };

/** A full-size shape is built and parsed once and shared by its budget-off and default-budget tests (parsing a multi-MB page dominates the run). */
const fullPages = new Map<string, { html: string; parsed: ReturnType<typeof parsePage> }>();
const fullPage = (label: string, build: (scale: number) => string) => {
  let entry = fullPages.get(label);
  if (!entry) {
    const html = build(1);
    entry = { html, parsed: parsePage(html, url) };
    fullPages.set(label, entry);
  }
  return entry;
};

async function run(input: string | { html: string; parsed: ReturnType<typeof parsePage> }, ruleTimeBudgetMs?: number): Promise<{ ms: number; checks: Check[] }> {
  const { html, parsed } = typeof input === "string" ? { html: input, parsed: parsePage(input, url) } : input;
  const runner = new RuleRunner({
    config: { rule_options: {}, rules: { enable: ["integrity/brand-impersonation", "integrity/fake-auth-overlay"] } } as never,
    ...(ruleTimeBudgetMs === undefined ? {} : { ruleTimeBudgetMs }),
  });
  const started = performance.now();
  const result = await runner.runPageRules({ url, html, statusCode: 200, loadTime: 0, headers: {}, parsed } as never);
  return { ms: performance.now() - started, checks: (result.checks ?? []) as Check[] };
}

const attrs40 = Array.from({ length: 40 }, (_, i) => `d${i}="v"`).join(" ");
/** Each shape at full size (skipped on a busy machine) and at about a quarter of it (always run, at the default budget). */
const SHAPES: Array<[string, (scale: number) => string]> = [
  ["off-site links with 5 extra attributes (4.9 MB, about 76,000 controls)", (k) => page(rep(`<a href="${O}" a="1" b="2" c="3" d="4" e="5">x</a>`, 4.9 * MB * k) + REAL)],
  ["off-site links with 40 extra attributes (7 MB)", (k) => page(rep(`<a href="${O}" ${attrs40}>x</a>`, 7 * MB * k) + REAL)],
  ["links naming 5 aria-labelledby ids (7 MB)", (k) => page(rep(`<a href="${O}" aria-labelledby="a b c d e">x</a>`, 7 * MB * k) + `<span id="a">x</span>${REAL}`)],
  ["links naming 2 aria-labelledby ids (135,000)", (k) => page(Array.from({ length: Math.round(135_000 * k) }, (_, i) => `<a href=/x${i % 7} aria-labelledby="a b">x</a>`).join("") + REAL)],
  ["links each naming 4 distinct ids of nested targets (100,000 targets, 25,000 links)", (k) => {
    const targets = Math.round(100_000 * k);
    const links = Math.round(25_000 * k);
    return page(`${Array.from({ length: targets }, (_, i) => `<span id="t${i}">`).join("")}x${"</span>".repeat(targets)}${Array.from({ length: links }, (_, i) => `<a href="${O}" aria-labelledby="t${4 * i} t${4 * i + 1} t${4 * i + 2} t${4 * i + 3}">x</a>`).join("")}${REAL}`);
  }],
  ["img inside one control (330,000)", (k) => page(`<a href="${OFF}">${"<img>".repeat(Math.round(330_000 * k))}Sign in with Google</a>`)],
];

const abandonedChecks = (checks: Check[]): Check[] => checks.filter((c) => c.status === "skipped" || /-error$|timeout/.test(c.name ?? ""));
const foundOrReported = (checks: Check[]): boolean => {
  const brand = checks.find((c) => c.name === "brand-impersonation");
  return brand?.details?.brand === "Google" || Number(brand?.details?.controlsUnread ?? 0) > 0;
};
/** The 2 s wall-clock budget is only a fair test on a machine that is not busy with other work. */
const quiet = loadavg()[0]! < cpus().length / 2;

for (const [label, build] of SHAPES) {
  test(`${label}: the real control is found or the controls not read are counted (budget off)`, async () => {
    const { checks } = await run(fullPage(label, build), 0);
    expect([label, "found or reported", foundOrReported(checks)]).toEqual([label, "found or reported", true]);
  }, 120_000);

  test(`${label}, a quarter of the size: not abandoned at the default 2 s budget`, async () => {
    const { checks } = await run(build(0.25));
    expect([label, "abandoned", abandonedChecks(checks).length]).toEqual([label, "abandoned", 0]);
    expect([label, "found or reported", foundOrReported(checks)]).toEqual([label, "found or reported", true]);
  }, 120_000);

  test(`${label}: not abandoned at the default 2 s budget${quiet ? "" : " (skipped: the machine is busy)"}`, async () => {
    if (!quiet) {
      fullPages.delete(label);
      return;
    }
    const { checks } = await run(fullPage(label, build));
    fullPages.delete(label);
    expect([label, "abandoned", abandonedChecks(checks).length]).toEqual([label, "abandoned", 0]);
    expect([label, "found or reported", foundOrReported(checks)]).toEqual([label, "found or reported", true]);
  }, 120_000);
}
