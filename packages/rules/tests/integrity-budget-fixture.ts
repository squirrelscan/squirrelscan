import { parsePage } from "@squirrelscan/parser";
import { RuleRunner } from "../src/runner";

// Shared fixtures of the integrity budget tests (#784, #1424): hostile pages through the rule runner. The
// work bounds are the subject, not elapsed time, so the runner's wall-clock rule budget is off (`ruleTimeBudgetMs: 0`).
// The tests are split over three files so each stays well under a lane's test watchdog (150 s, 1.2 GB) and prints
// its summary on a loaded machine (#1465).

export const url = "https://example.com/";
export const OFF = "https://credential-fixture.invalid/signin";
export const REAL = `<a href="${OFF}">Sign in with Google</a>`;
export const OVERLAY = '<iframe id="google-auth" srcdoc="" style="position:fixed;inset:0;z-index:9999"></iframe>';
export const RULES = ["integrity/brand-impersonation", "integrity/fake-auth-overlay"];

export type Check = { name?: string; status?: string; details?: Record<string, unknown> };

export async function run(body: string, head = ""): Promise<{ ms: number; checks: Check[] }> {
  const html = `<!doctype html><html><head><title>Fixture</title>${head}</head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
  const parsed = parsePage(html, url);
  const runner = new RuleRunner({ config: { rule_options: {}, rules: { enable: RULES } } as never, ruleTimeBudgetMs: 0 });
  const started = performance.now();
  const result = await runner.runPageRules({ url, html, statusCode: 200, loadTime: 0, headers: {}, parsed } as never);
  return { ms: performance.now() - started, checks: (result.checks ?? []) as Check[] };
}
export const finished = (checks: Check[]): boolean => !checks.some((c) => /-error$|timeout/.test(c.name ?? "") || c.status === "skipped");
export const fired = (checks: Check[], name: string): boolean =>
  checks.some((c) => c.name === name && c.status !== "skipped" && c.details?.scanTruncated !== true);


export const noted = (checks: Check[]): boolean => checks.some((c) => c.details?.scanTruncated === true);
export const foundOrNoted = (checks: Check[], name: string): boolean => fired(checks, name) || noted(checks);
export const label16k = (i: number): string => Array.from({ length: 1_600 }, (_, j) => `sign in ${i}x${j}`).join(" ").slice(0, 16_000);
export const padded = (before: number): string => `${"a".repeat(before)} Sign in with Google ${"b".repeat(50)}`;
