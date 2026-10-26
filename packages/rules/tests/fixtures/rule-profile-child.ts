// Child process for rule-profile-274.test.ts. `profileRules` is read once, at
// module load, from SQUIRREL_RULE_PROFILE, so each setting needs its own
// process. Runs one page rule and one site rule; the profile lines, if any, go
// to stderr. A probe rule returns checks that count `filter` calls on them, so
// stdout says whether the runner built the profile payload.

import type { CheckResult } from "@squirrelscan/core-contracts";

import { RuleRunner } from "../../src/runner";
import type { Rule } from "../../src/types";

let filters = 0;
class CountingChecks extends Array<CheckResult> {
  static override get [Symbol.species]() {
    return Array;
  }
  override filter(...args: Parameters<Array<CheckResult>["filter"]>): CheckResult[] {
    filters++;
    return super.filter(...args);
  }
}

const probeRule: Rule = {
  meta: {
    id: "probe/count",
    name: "Probe",
    description: "Counts filter calls on its checks.",
    category: "core",
    scope: "page",
    severity: "info",
    weight: 1,
  },
  run: () => {
    const checks = new CountingChecks();
    checks.push({ name: "probe", status: "pass", message: "ok" });
    return { checks };
  },
};

const html =
  '<!doctype html><html lang="en"><head><title>Short</title></head><body><h1>Hi</h1><p>text</p></body></html>';
const page = { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} };
const runner = new RuleRunner({
  config: {
    rule_options: {},
    rules: { enable: ["core/meta-title", "core/title-unique", "probe/count"] },
  },
  additionalNamespaces: [{ name: "probe", rules: [probeRule] }],
});
const site = { baseUrl: "https://example.com", pages: [page], robotsTxt: null, sitemaps: null };

await runner.runPageRules(page, site);
await runner.runSiteRules(site);
console.log(`filters=${filters}`);
