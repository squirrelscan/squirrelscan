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

async function run(html: string, ruleTimeBudgetMs?: number): Promise<{ ms: number; checks: Check[] }> {
  const parsed = parsePage(html, url);
  const runner = new RuleRunner({
    config: { rule_options: {}, rules: { enable: ["integrity/brand-impersonation", "integrity/fake-auth-overlay"] } } as never,
    ...(ruleTimeBudgetMs === undefined ? {} : { ruleTimeBudgetMs }),
  });
  const started = performance.now();
  const result = await runner.runPageRules({ url, html, statusCode: 200, loadTime: 0, headers: {}, parsed } as never);
  return { ms: performance.now() - started, checks: (result.checks ?? []) as Check[] };
}

const attrs40 = Array.from({ length: 40 }, (_, i) => `d${i}="v"`).join(" ");
const SHAPES: Array<[string, () => string]> = [
  ["4.9 MB of off-site links with 5 extra attributes (about 76,000 controls)", () => page(rep(`<a href="${O}" a="1" b="2" c="3" d="4" e="5">x</a>`, 4.9 * MB) + REAL)],
  ["7 MB of off-site links with 40 extra attributes", () => page(rep(`<a href="${O}" ${attrs40}>x</a>`, 7 * MB) + REAL)],
  ["7 MB of links naming 5 aria-labelledby ids", () => page(rep(`<a href="${O}" aria-labelledby="a b c d e">x</a>`, 7 * MB) + `<span id="a">x</span>${REAL}`)],
  ["135,000 links naming 2 aria-labelledby ids", () => page(Array.from({ length: 135_000 }, (_, i) => `<a href=/x${i % 7} aria-labelledby="a b">x</a>`).join("") + REAL)],
  ["330,000 img inside one control", () => page(`<a href="${OFF}">${"<img>".repeat(330_000)}Sign in with Google</a>`)],
];

const abandonedChecks = (checks: Check[]): Check[] => checks.filter((c) => c.status === "skipped" || /-error$|timeout/.test(c.name ?? ""));
const foundOrReported = (checks: Check[]): boolean => {
  const brand = checks.find((c) => c.name === "brand-impersonation");
  return brand?.details?.brand === "Google" || Number(brand?.details?.controlsUnread ?? 0) > 0;
};
/** The 2 s wall-clock budget is only a fair test on a machine that is not busy with other work. */
const quiet = loadavg()[0]! < cpus().length / 2;

for (const [label, build] of SHAPES) {
  test(`${label}: the real control is found or the controls not read are counted`, async () => {
    const { checks } = await run(build(), 0);
    expect([label, "found or reported", foundOrReported(checks)]).toEqual([label, "found or reported", true]);
  }, 120_000);

  test(`${label}: not abandoned at the default 2 s budget${quiet ? "" : " (skipped: the machine is busy)"}`, async () => {
    if (!quiet) return;
    const { checks } = await run(build());
    expect([label, "abandoned", abandonedChecks(checks).length]).toEqual([label, "abandoned", 0]);
    expect([label, "found or reported", foundOrReported(checks)]).toEqual([label, "found or reported", true]);
  }, 120_000);
}
