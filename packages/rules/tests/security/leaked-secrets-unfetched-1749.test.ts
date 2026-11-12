// #1749: each way a script can fail to be read, and the ones that are not a gap.
import { describe, expect, test } from "bun:test";

import type { ScriptContentData } from "@squirrelscan/core-contracts";

import { leakedSecretsRule } from "../../src/security/leaked-secrets";
import type { RuleContext } from "../../src/types";
import { expectDeclaredChecks } from "../helpers/declared-checks";

const script = (over: Partial<ScriptContentData>): ScriptContentData => ({
  url: "https://example.com/a.js",
  status: 200,
  error: null,
  contentType: "text/javascript",
  sizeBytes: null,
  content: null,
  sourcePages: ["https://example.com/"],
  ...over,
});

function run(scripts: ScriptContentData[], assetCapDropped?: { scripts?: number }) {
  const out = leakedSecretsRule.run({
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, scripts, assetCapDropped },
    options: {},
  } as unknown as RuleContext).checks;
  expectDeclaredChecks(leakedSecretsRule, out);
  return out;
}
const unfetched = (checks: ReturnType<typeof run>) => checks.find((c) => c.name === "leaked-secrets-unfetched");

describe("security/leaked-secrets-unfetched (#1749)", () => {
  test("a timeout, a refusal, a throttle, a skip and a 4xx other than 404/410 are listed with a reason", () => {
    const checks = run([
      script({ url: "https://example.com/timeout.js", status: null, error: "timeout" }),
      script({ url: "https://example.com/limited.js", status: 429, rateLimited: true }),
      script({ url: "https://example.com/skipped.js", status: null, fetchSkipReason: "time-budget" }),
      script({ url: "https://example.com/forbidden.js", status: 403 }),
      script({ url: "https://example.com/err.js", status: 502 }),
    ]);
    const labels = Object.fromEntries((unfetched(checks)?.items ?? []).map((i) => [i.id.split("/").pop(), i.label]));
    expect(labels).toEqual({
      "timeout.js": "request failed (timeout)",
      "limited.js": "rate limited",
      "skipped.js": "not fetched (time budget)",
      "forbidden.js": "refused (403)",
      "err.js": "server error (502)",
    });
    expect(unfetched(checks)?.details).toMatchObject({ unfetched: 5, capDropped: 0 });
    // No clean verdict next to a script nobody read.
    expect(checks.some((c) => c.name === "leaked-secrets")).toBe(false);
  });

  test("a 404, a 410 and a script that was read empty are not gaps", () => {
    const checks = run([
      script({ url: "https://example.com/a.js", status: 404 }),
      script({ url: "https://example.com/b.js", status: 410 }),
      script({ url: "https://example.com/c.js", status: 200, content: "" }),
    ]);
    expect(unfetched(checks)).toBeUndefined();
    expect(checks.find((c) => c.name === "leaked-secrets")?.status).toBe("pass");
  });

  test("scripts dropped by the asset cap are counted even when every fetched script was read", () => {
    const checks = run([script({ status: 200, content: "var a = 1;" })], { scripts: 7 });
    expect(unfetched(checks)?.details).toMatchObject({ unfetched: 0, capDropped: 7 });
    expect(unfetched(checks)?.message).toContain("7 script(s) were not scanned");
    expect(checks.some((c) => c.name === "leaked-secrets")).toBe(false);
  });
});
