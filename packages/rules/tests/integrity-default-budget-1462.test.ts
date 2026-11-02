// #1462: at a rule budget of 10 s (five times the 2 s default, so a loaded machine cannot abandon a rule that takes about a second alone), a page of at most 5 MB of tiny multi-attribute controls, of controls
// naming many `aria-labelledby` targets, or of many `<img>` inside one control is never abandoned ("Not checked"): the real
// control after them is found, or the rule reports the controls it did not read (`controlsUnread`). Synthetic pages.

import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { RuleRunner } from "../src/runner";

const url = "https://example.com/";
const MB = 1_048_576;
const RULES = ["integrity/brand-impersonation", "integrity/fake-auth-overlay"];
const OFF = "https://credential-fixture.invalid/signin";
const REAL = `<a href="${OFF}">Sign in with Google</a>`;
const page = (body: string) => `<!doctype html><html><head><title>Fixture</title></head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
const rep = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length));

type Check = { name?: string; status?: string; details?: Record<string, unknown> };

/** Five times the default `RULE_TIME_BUDGET_MS` (2 s): a rule that is still running at 10 s is abandoned ("Not checked"). */
const BUDGET_MS = 10_000;
async function runDefault(html: string): Promise<{ ms: number; checks: Check[] }> {
  const parsed = parsePage(html, url);
  const runner = new RuleRunner({ config: { rule_options: {}, rules: { enable: RULES } } as never, ruleTimeBudgetMs: BUDGET_MS });
  const started = performance.now();
  const result = await runner.runPageRules({ url, html, statusCode: 200, loadTime: 0, headers: {}, parsed } as never);
  return { ms: performance.now() - started, checks: (result.checks ?? []) as Check[] };
}

/** Not abandoned, and the real control is found or the controls not read are counted. */
function expectReadOrReported(checks: Check[], label: string): void {
  const abandoned = checks.filter((c) => c.status === "skipped" || /-error$|timeout/.test(c.name ?? ""));
  expect([label, "abandoned", abandoned.length]).toEqual([label, "abandoned", 0]);
  const brand = checks.find((c) => c.name === "brand-impersonation");
  const found = brand?.details?.brand === "Google";
  const reported = Number(brand?.details?.controlsUnread ?? 0) > 0 && brand?.details?.scanTruncated !== undefined;
  expect([label, "found or reported", found || reported]).toEqual([label, "found or reported", true]);
}

const SHAPES: Array<[string, () => string]> = [
  ["5 MB of inputs with several attributes", () => page(rep('<input type="text" name="a" id="b" class="c" value="d">', 5 * MB) + REAL)],
  ["5 MB of submit inputs with 11 attributes", () => page(rep('<input type="submit" class="c" id="i" data-a="1" data-b="2" data-c="3" aria-label="x" title="t" name="n" value="v" form="f">', 5 * MB) + REAL)],
  ["5 MB of local links with 5 attributes", () => page(rep('<a href="/x" title="t" class="c" data-x="1" id="i">x</a>', 5 * MB) + REAL)],
  ["5 MB of off-site links with 12 attributes", () => page(rep('<a href="https://o.invalid/x" title="t" class="c" id="i" data-a="1" data-b="2" data-c="3" data-d="4" data-e="5" data-f="6" rel="n" target="_b">x</a>', 5 * MB) + REAL)],
  ["5 MB of buttons with 8 attributes", () => page(rep('<button type="button" class="c" id="i" data-a="1" data-b="2" data-c="3" data-d="4" aria-label="x" title="t">x</button>', 5 * MB) + REAL)],
  ["5 MB of buttons naming 8 aria-labelledby targets", () => page(rep('<button aria-labelledby="a b c d e f g h">x</button>', 5 * MB) + `<span id="a">x</span>${REAL}`)],
  ["135,000 links naming 2 aria-labelledby targets", () => page(Array.from({ length: 135_000 }, (_, i) => `<a href=/x${i % 7} aria-labelledby="a${i % 50} b${i % 50}">x</a>`).join("") + REAL)],
  ["100,000 links naming one 2,000-node target four times", () => page(`<div id="t">${"<b>x</b>".repeat(2_000)}</div>${'<a href=/x aria-labelledby="t t t t">x</a>'.repeat(100_000)}${REAL}`)],
  ["330,000 img inside one control", () => page(`<a href="${OFF}">${"<img>".repeat(330_000)}Sign in with Google</a>`)],
  ["5 MB of img with alt and src inside one control", () => page(`<a href="${OFF}">${rep('<img alt="a" src="/i.png">', 5 * MB)}Sign in with Google</a>`)],
];

for (const [label, build] of SHAPES) {
  test(`${label}: not abandoned at five times the default budget; the real control is found or the controls not read are counted`, async () => {
    const html = build();
    expect(html.length).toBeLessThanOrEqual(5.5 * MB);
    const { ms, checks } = await runDefault(html);
    expectReadOrReported(checks, label);
    expect(ms).toBeLessThan(BUDGET_MS * 1.5);
  }, 120_000);
}
