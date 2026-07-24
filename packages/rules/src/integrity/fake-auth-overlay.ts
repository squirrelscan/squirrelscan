// integrity/fake-auth-overlay — full-viewport fixed high-z-index iframe overlay
// (the injected `#google-auth` pattern) or a "Sign in with <brand>" control that
// targets an off-brand host. Correlation-gated: lone signal → `info`.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import {
  detectFakeAuthOverlay,
  detectPageSignals,
  shouldEscalate,
} from "./signals";

export const fakeAuthOverlayRule: Rule = {
  meta: {
    id: "integrity/fake-auth-overlay",
    name: "Fake Authentication Overlay",
    description:
      "Detects full-viewport fixed high-z-index iframe overlays or sign-in controls that send credentials to an off-brand host — a credential-harvesting overlay pattern",
    solution:
      "A full-viewport, fixed, high-z-index iframe that covers the page, or a 'Sign in with Google/Microsoft' control whose target is not the brand's real domain, is a credential-harvesting overlay. If you did not build it, your site is likely compromised: remove the overlay markup/script, audit recently modified files, and rotate credentials. Legitimate sign-in always targets the provider's own host (accounts.google.com, login.microsoftonline.com).",
    category: "integrity",
    scope: "page",
    severity: "warning",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    if (!ctx.parsed.document) return { checks };

    const hit = detectFakeAuthOverlay(ctx);
    if (!hit) {
      return { checks };
    }

    const signals = detectPageSignals(ctx);
    const escalate = shouldEscalate(signals, "fake-auth-overlay");
    const corroborating = [...signals].filter(
      (s) => s !== "fake-auth-overlay"
    );

    checks.push({
      name: "fake-auth-overlay",
      status: escalate ? "fail" : "info",
      message: escalate
        ? `Likely credential-harvesting overlay (${signals.size} corroborating integrity signals)`
        : `Suspicious authentication overlay (single signal — review)`,
      pageUrl: ctx.page.url,
      value: hit.reason,
      details: {
        signals: [...signals],
        corroborating,
        escalated: escalate,
      },
    });

    return { checks };
  },
};
