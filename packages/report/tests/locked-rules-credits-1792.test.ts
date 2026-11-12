// #1792: an audit that ran out of credits has its own locked-rule reason, `credits`. Every renderer groups and
// words it on its own, never as a plan exclusion or an environment limit, and a reader that does not know the
// code reads it as no reason and keeps the audience wording.

import { describe, expect, test } from "bun:test";

import type { LockedRule } from "@squirrelscan/core-contracts";
import { isLockedRuleReason } from "@squirrelscan/core-contracts";

import { lockedRulesMessage } from "../src/locked-rules";
import { notCheckedRules } from "../src/not-checked";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import type { AuditReport } from "../src/types";

const CREDITS: LockedRule = {
  id: "ax/content-without-js",
  name: "Content without JavaScript",
  reason: "credits",
  detail: "The audit stopped at 40 of 120 pages.",
};
const PROVIDER: LockedRule = { id: "ax/archive-indexing", name: "Archive Indexing", reason: "provider_error" };
const PLAN: LockedRule = { id: "ai/llm-parsability", name: "LLM Parsability", reason: "plan" };

function report(lockedRules: LockedRule[], over: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-12T00:00:00.000Z",
    totalPages: 5,
    passed: 10,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    lockedRules,
    ...over,
  } as AuditReport;
}

describe("the code", () => {
  test("is in the closed set", () => {
    expect(isLockedRuleReason("credits")).toBe(true);
  });
});

describe("lockedRulesMessage words credits on its own", () => {
  test("a paid org: out of credits, add credits and re-run; never the plan, an environment or an outage", () => {
    const msg = lockedRulesMessage(report([CREDITS], { cloudPlan: "paid" }))!;
    expect(msg.groups?.map((g) => g.reason)).toEqual(["credits"]);
    expect(msg.action).toContain("ran out of credits");
    expect(msg.action).toContain("Add credits, then re-run the audit");
    expect(msg.action).toContain("The audit stopped at 40 of 120 pages.");
    for (const not of ["not included in", "your plan", "environment", "temporarily", "may include it"]) {
      expect(msg.action, not).not.toContain(not);
    }
    // The paid audience has no upsell link of its own.
    expect(msg.cta).toBeUndefined();
  });

  test("a free org keeps the add-credits link", () => {
    const msg = lockedRulesMessage(report([CREDITS], { cloudPlan: "free" }))!;
    expect(msg.action).not.toContain("not included in");
    expect(msg.cta?.label).toBe("Add credits in your dashboard");
  });

  test("one rule or several, singular and plural", () => {
    expect(lockedRulesMessage(report([CREDITS], { cloudPlan: "paid" }))!.action).toContain("This check did not run");
    const two = lockedRulesMessage(report([CREDITS, { ...CREDITS, id: "x/y", name: "Y" }], { cloudPlan: "paid" }))!;
    expect(two.action).toContain("These 2 checks did not run");
    expect(two.action).toContain("include them");
  });

  test("the order is plan, credits, provider_error, unsupported_environment, then no reason", () => {
    const msg = lockedRulesMessage(
      report([{ id: "a/b", name: "A" }, PROVIDER, CREDITS, PLAN], { cloudPlan: "free" }),
    )!;
    expect(msg.groups?.map((g) => g.reason)).toEqual(["plan", "credits", "provider_error", undefined]);
  });

  test("a failed audit keeps its own message whatever the reasons say", () => {
    expect(lockedRulesMessage(report([CREDITS], { status: "failed", cloudPlan: "paid" }))!.audience).toBe(
      "audit-failed",
    );
  });
});

describe("a reader that does not know the code falls back without failing", () => {
  // A reader from before #1792 has a closed set without `credits`: it treats the value like any unknown one
  // (`isLockedRuleReason` is false) and keeps the audience wording. The same path, exercised with a value
  // the set has never held, is what such a reader runs.
  test("an unknown reason reads as none and the audience wording stays", () => {
    const unknown = { ...CREDITS, reason: "some-future-code" } as unknown as LockedRule;
    const none = lockedRulesMessage(report([{ id: CREDITS.id, name: CREDITS.name }], { cloudPlan: "paid" }))!;
    const msg = lockedRulesMessage(report([unknown], { cloudPlan: "paid" }))!;
    expect(msg.groups).toBeUndefined();
    expect(msg.action).toBe(none.action);
    for (const render of [renderText, renderMarkdown, renderLlm, renderXml, renderJson, (r: AuditReport) => renderHtml(r)]) {
      expect(() => render(report([unknown], { cloudPlan: "paid" }))).not.toThrow();
    }
  });
});

describe("every renderer carries credits", () => {
  const r = report([CREDITS, PROVIDER], { cloudPlan: "paid" });

  test("llm and xml: the sentence and the reason attribute", () => {
    for (const out of [renderLlm(r), renderXml(r)]) {
      expect(out).toContain("ran out of credits");
      expect(out).toContain('reason="credits"');
      expect(out).toContain("The audit stopped at 40 of 120 pages");
    }
  });

  test("html: the sentence, the badge and its label", () => {
    const out = renderHtml(r);
    expect(out).toContain("ran out of credits");
    expect(out).toContain('data-locked-reason="credits"');
    expect(out).toContain("out of credits, add credits and re-run");
  });

  test("markdown and text: the sentence and a label beside the rule", () => {
    for (const out of [renderMarkdown(r), renderText(r)]) {
      expect(out).toContain("ran out of credits");
      expect(out).toContain("(out of credits, add credits and re-run)");
    }
  });

  test("json: the message and the rule's reason and detail", () => {
    const json = JSON.parse(renderJson(r));
    expect(json.lockedRules.message).toContain("ran out of credits");
    expect(json.lockedRules.rules[0]).toEqual({
      id: CREDITS.id,
      name: CREDITS.name,
      reason: "credits",
      detail: CREDITS.detail,
    });
  });
});

describe("a not-checked entry can carry credits as its cause", () => {
  const rep = report([], {
    ruleResults: {
      "security/tls-certificate": {
        meta: { id: "security/tls-certificate", name: "TLS Certificate", category: "security", severity: "error" },
        checks: [
          {
            name: "tls-certificate",
            status: "skipped",
            message: "TLS certificate not checked.",
            skipReason: "tls-certificate-not-checked",
            details: { cause: "credits", causeDetail: "Stopped at 40 of 120 pages." },
          },
        ],
      },
    } as unknown as AuditReport["ruleResults"],
  });

  test("the cause and its hint say credits, in the entry and in json and xml", () => {
    const [rule] = notCheckedRules(rep);
    expect(rule?.cause).toBe("credits");
    expect(rule?.hint).toContain("ran out of credits");
    expect(rule?.hint).toContain("Add credits");
    expect(rule?.hint).toContain("Stopped at 40 of 120 pages.");
    expect(JSON.parse(renderJson(rep)).notChecked[0].cause).toBe("credits");
    expect(renderXml(rep)).toContain('cause="credits"');
  });
});
