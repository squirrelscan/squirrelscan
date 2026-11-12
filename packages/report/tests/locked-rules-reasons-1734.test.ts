// #1734: a locked or not-checked rule carries a machine-readable reason (plan,
// provider_error, unsupported_environment), and every format says what that
// reason means. A rule with no reason (an older publisher) keeps today's wording.

import { describe, expect, test } from "bun:test";

import type { LockedRule } from "@squirrelscan/core-contracts";
import { isLockedRuleReason, LOCKED_RULE_REASONS } from "@squirrelscan/core-contracts";

import { lockedRulesMessage } from "../src/locked-rules";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import { notCheckedRules } from "../src/not-checked";
import type { AuditReport } from "../src/types";

const PLAN: LockedRule = { id: "ai/llm-parsability", name: "LLM Parsability", reason: "plan" };
const PROVIDER: LockedRule = {
  id: "ax/archive-indexing",
  name: "Archive Indexing",
  reason: "provider_error",
  detail: "The archive provider timed out",
};
const ENV: LockedRule = {
  id: "security/tls-certificate",
  name: "TLS Certificate",
  reason: "unsupported_environment",
  detail: "Run it from the squirrel CLI on a machine that can open a TLS connection.",
};
const NO_REASON: LockedRule = { id: "ai/site-metadata", name: "Site Metadata" };

function report(lockedRules: LockedRule[], over: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-11T00:00:00.000Z",
    totalPages: 5,
    passed: 10,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    lockedRules,
    ...over,
  } as AuditReport;
}

describe("the closed set", () => {
  test("is exactly plan, credits, provider_error and unsupported_environment (credits: #1792)", () => {
    expect([...LOCKED_RULE_REASONS]).toEqual(["plan", "credits", "provider_error", "unsupported_environment"]);
    expect(isLockedRuleReason("plan")).toBe(true);
    expect(isLockedRuleReason("outage")).toBe(false);
    expect(isLockedRuleReason(undefined)).toBe(false);
  });
});

describe("lockedRulesMessage by reason", () => {
  test("a plan reason names the plan and keeps the upsell link", () => {
    const msg = lockedRulesMessage(report([PLAN], { cloudPlan: "free" }))!;
    expect(msg.action).toContain("not included in the Free plan");
    expect(msg.groups?.map((g) => g.reason)).toEqual(["plan"]);
    expect(msg.cta?.url).toBe("https://app.squirrelscan.com");
    expect(lockedRulesMessage(report([PLAN], { cloudPlan: "paid" }))!.action).toContain("your plan");
  });

  test("a provider error says a re-run may help, not that the plan excludes it", () => {
    const msg = lockedRulesMessage(report([PROVIDER], { cloudPlan: "paid" }))!;
    expect(msg.action).toContain("Re-running the audit may include it");
    expect(msg.action).toContain("The archive provider timed out.");
    expect(msg.action).not.toContain("plan");
    expect(msg.cta).toBeUndefined();
  });

  test("an unsupported environment says where the check can run", () => {
    const msg = lockedRulesMessage(report([ENV], { cloudPlan: "paid" }))!;
    expect(msg.action).toContain("can't run in the environment this audit ran in");
    expect(msg.action).toContain("machine that can open a TLS connection");
    const bare = lockedRulesMessage(report([{ ...ENV, detail: undefined }], { cloudPlan: "paid" }))!;
    expect(bare.action).toContain("direct network access");
  });

  test("mixed reasons give one sentence per cause, in a fixed order", () => {
    const msg = lockedRulesMessage(report([ENV, NO_REASON, PROVIDER, PLAN], { cloudPlan: "free" }))!;
    expect(msg.groups?.map((g) => g.reason)).toEqual([
      "plan",
      "provider_error",
      "unsupported_environment",
      undefined,
    ]);
    expect(msg.count).toBe(4);
  });

  test("an unknown reason reads as none, and detail is cut to one short line", () => {
    const odd = { ...PLAN, reason: "outage" } as unknown as LockedRule;
    const before = lockedRulesMessage(report([{ id: PLAN.id, name: PLAN.name }], { cloudPlan: "paid" }));
    expect(lockedRulesMessage(report([odd], { cloudPlan: "paid" }))).toEqual({
      ...before!,
      rules: [odd],
    });
    const long = lockedRulesMessage(
      report([{ ...PROVIDER, detail: `a\n${"x".repeat(400)}` }], { cloudPlan: "paid" }),
    )!;
    expect(long.action).not.toContain("\n");
    expect(long.action.length).toBeLessThan(600);
  });

  test("a failed audit keeps its own message whatever the reasons say", () => {
    const msg = lockedRulesMessage(report([PLAN], { status: "failed", cloudPlan: "paid" }))!;
    expect(msg.audience).toBe("audit-failed");
    expect(msg.groups).toBeUndefined();
  });
});

describe("no reason: today's wording is unchanged", () => {
  test("every audience keeps its sentence and has no groups", () => {
    const rules = [{ id: NO_REASON.id, name: NO_REASON.name }];
    for (const [over, copy] of [
      [{ cloudPlan: "paid" as const }, "temporarily unavailable"],
      [{ cloudPlan: "free" as const }, "out of credits"],
      [{}, "free squirrelscan account"],
      [{ cloudPlan: "paid" as const, coverageMode: "quick" as const }, "the quick level skips"],
    ] as const) {
      const msg = lockedRulesMessage(report(rules, over))!;
      expect(msg.action).toContain(copy);
      expect(msg.groups).toBeUndefined();
    }
    const llm = renderLlm(report(rules, { cloudPlan: "paid" }));
    expect(llm).toContain('<rule id="ai/site-metadata" name="Site Metadata"/>');
    expect(llm).not.toContain("reason=");
  });
});

describe("every format renders the reason", () => {
  const rules = [PLAN, PROVIDER, ENV];
  const r = report(rules, { cloudPlan: "paid" });

  test("llm: the sentence per cause and reason attributes on each rule", () => {
    const out = renderLlm(r);
    expect(out).toContain("not included in your plan");
    expect(out).toContain("Re-running the audit may include it");
    // The xml-ish llm format escapes the apostrophe.
    expect(out).toContain("can&apos;t run in the environment this audit ran in");
    expect(out).toContain('<rule id="ai/llm-parsability" name="LLM Parsability" reason="plan"/>');
    expect(out).toContain('reason="provider_error" detail="The archive provider timed out"');
    expect(out).toContain('reason="unsupported_environment"');
  });

  test("html: the sentence per cause and a labelled badge for each rule", () => {
    const out = renderHtml(r);
    expect(out).toContain("not included in your plan");
    expect(out).toContain("Re-running the audit may include it");
    expect(out).toContain('data-locked-reason="plan"');
    expect(out).toContain('data-locked-reason="provider_error"');
    expect(out).toContain('data-locked-reason="unsupported_environment"');
    expect(out).toContain("a service failed, a re-run may help");
  });

  test("markdown and text: sentence and a label beside each rule", () => {
    for (const out of [renderMarkdown(r), renderText(r)]) {
      expect(out).toContain("not included in your plan");
      expect(out).toContain("(not in your plan)");
      expect(out).toContain("(a service failed, a re-run may help)");
      expect(out).toContain("(cannot run in this environment)");
    }
  });

  test("json: lockedRules carries the message and each rule's reason and detail", () => {
    const json = JSON.parse(renderJson(r));
    expect(json.lockedRules.count).toBe(3);
    expect(json.lockedRules.message).toContain("not included in your plan");
    expect(json.lockedRules.rules).toEqual([
      { id: PLAN.id, name: PLAN.name, reason: "plan" },
      { id: PROVIDER.id, name: PROVIDER.name, reason: "provider_error", detail: PROVIDER.detail },
      { id: ENV.id, name: ENV.name, reason: "unsupported_environment", detail: ENV.detail },
    ]);
    expect(JSON.parse(renderJson(report([]))).lockedRules).toBeUndefined();
  });

  test("xml: a locked-rules block with the message and reason attributes", () => {
    const out = renderXml(r);
    expect(out).toContain('<locked-rules count="3"');
    expect(out).toContain("<message>");
    expect(out).toContain('id="ai/llm-parsability" name="LLM Parsability" reason="plan"');
    expect(out).toContain('reason="provider_error" detail="The archive provider timed out"');
  });
});

describe("notChecked entries carry a cause (#1734)", () => {
  const withCause = (details?: Record<string, unknown>): AuditReport =>
    report([], {
      ruleResults: {
        "security/tls-certificate": {
          meta: { id: "security/tls-certificate", name: "TLS Certificate", category: "security", severity: "error" },
          checks: [
            {
              name: "tls-certificate",
              status: "skipped",
              message: "TLS certificate not checked.",
              skipReason: "tls-certificate-not-checked",
              ...(details ? { details } : {}),
            },
          ],
        },
      } as unknown as AuditReport["ruleResults"],
    });

  test("a cause and its detail replace the skip-reason hint, in json and xml", () => {
    const rep = withCause({ cause: "unsupported_environment", causeDetail: "No outbound TLS here." });
    const [rule] = notCheckedRules(rep);
    expect(rule?.cause).toBe("unsupported_environment");
    expect(rule?.hint).toContain("can't run in the environment");
    expect(rule?.hint).toContain("No outbound TLS here.");
    const json = JSON.parse(renderJson(rep));
    expect(json.notChecked[0].cause).toBe("unsupported_environment");
    expect(json.notChecked[0].causeDetail).toBe("No outbound TLS here.");
    expect(renderXml(rep)).toContain('cause="unsupported_environment"');
  });

  test("a hostile causeDetail has its control characters removed and is escaped where it is printed", () => {
    const rep = withCause({ cause: "provider_error", causeDetail: "<img src=x onerror=1>\u001b[31m [x](javascript:1)" });
    expect(notCheckedRules(rep)[0]?.causeDetail).not.toContain("\u001b");
    expect(renderMarkdown(rep)).not.toMatch(/(?<!\\)<img/);
    expect(renderMarkdown(rep)).not.toMatch(/(?<!\\)\[x\]\(javascript/);
    for (const out of [renderXml(rep), renderLlm(rep), renderHtml(rep)]) {
      expect(out).not.toContain("<img src=x");
    }
  });

  test("no cause, or one outside the closed set: today's hint and no cause field", () => {
    for (const details of [undefined, { cause: "outage" }]) {
      const rep = withCause(details);
      const [rule] = notCheckedRules(rep);
      expect(rule?.cause).toBeUndefined();
      expect(rule?.hint).toContain("direct TLS connection");
      expect(JSON.parse(renderJson(rep)).notChecked[0]).not.toHaveProperty("cause");
    }
  });
});

describe("publisher-supplied text is inert in every format (#1734 security review)", () => {
  // A published report's `detail`, `name` and `id` are untrusted: they must not become a link,
  // an image, raw HTML, an attribute or a terminal escape in any output.
  const HOSTILE = '[x](javascript:alert(1)) <img src=x onerror=1> "quote \u001b[31mred';
  const evil: LockedRule = {
    id: "ai/evil`](javascript:alert(1))",
    name: "Evil <script>alert(1)</script> [n](javascript:1)",
    reason: "provider_error",
    detail: HOSTILE,
  };
  const r = report([evil], { cloudPlan: "paid" });

  test("markdown escapes link, image and HTML syntax in the sentence, the name and the id", () => {
    const out = renderMarkdown(r);
    expect(out).toContain("\\[x\\](javascript:alert(1)) \\<img src=x onerror=1> \"quote");
    // Every `<` and `[` the publisher sent is backslash-escaped.
    expect(out).not.toMatch(/(?<!\\)<(?:img|script)/);
    expect(out).not.toMatch(/(?<!\\)\[(?:x|n)\]\(javascript/);
    expect(out).not.toContain("\u001b");
  });

  test("html escapes the sentence and the name, and the reason attribute is a closed value", () => {
    const out = renderHtml(r);
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;img");
    expect(out).toContain('data-locked-reason="provider_error"');
    expect(out).not.toContain("\u001b");
  });

  test("llm and xml escape the sentence and every attribute", () => {
    for (const out of [renderLlm(r), renderXml(r)]) {
      expect(out).not.toContain("<img");
      expect(out).not.toContain("<script>");
      expect(out).toContain("&lt;img");
      expect(out).toContain("&quot;quote");
      expect(out).not.toContain("\u001b");
    }
  });

  test("text carries no terminal escape or line break from the publisher", () => {
    const out = renderText(r);
    expect(out).not.toContain("\u001b");
    expect(out).toContain("[x](javascript:alert(1))");
  });

  test("json keeps the string as data with the control characters removed", () => {
    const json = JSON.parse(renderJson(r));
    expect(json.lockedRules.rules[0].detail).toBe('[x](javascript:alert(1)) <img src=x onerror=1> "quote [31mred');
    expect(JSON.stringify(json)).not.toContain("\\u001b");
  });
});
