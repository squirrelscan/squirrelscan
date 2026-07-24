// a11y/paste-inputs - Detect paste-blocking inputs

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const pasteInputsRule: Rule = {
  meta: {
    id: "a11y/paste-inputs",
    name: "Paste Inputs",
    description: "Detects form inputs that prevent pasting",
    solution:
      "Remove any JavaScript that prevents pasting in form inputs. Blocking paste forces users to manually type passwords, email addresses, or other data, which increases errors and frustrates users with password managers. Users with motor impairments may rely on paste functionality. Remove onpaste='return false', event.preventDefault() on paste events, and similar anti-paste code.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const inputs = doc.querySelectorAll(
      'input[type="text"], input[type="password"], input[type="email"], input[type="tel"], input[type="url"], input[type="search"], input:not([type]), textarea'
    );

    const pasteBlockingInputs: string[] = [];

    for (const input of inputs) {
      const onpaste = input.getAttribute("onpaste");
      const oncopy = input.getAttribute("oncopy");
      const oncut = input.getAttribute("oncut");

      // Check for common paste-blocking patterns
      const blockingPatterns = [
        "return false",
        "return!1",
        "preventDefault",
        "event.returnValue=false",
        "event.returnValue=!1",
      ];

      const hasBlockingOnpaste =
        onpaste &&
        blockingPatterns.some((pattern) =>
          onpaste.toLowerCase().includes(pattern.toLowerCase())
        );

      const hasBlockingOncopy =
        oncopy &&
        blockingPatterns.some((pattern) =>
          oncopy.toLowerCase().includes(pattern.toLowerCase())
        );

      const hasBlockingOncut =
        oncut &&
        blockingPatterns.some((pattern) =>
          oncut.toLowerCase().includes(pattern.toLowerCase())
        );

      if (hasBlockingOnpaste || hasBlockingOncopy || hasBlockingOncut) {
        const type = input.getAttribute("type") || "text";
        const name =
          input.getAttribute("name") ||
          input.getAttribute("id") ||
          input.getAttribute("placeholder") ||
          type;
        const blocked: string[] = [];
        if (hasBlockingOnpaste) blocked.push("paste");
        if (hasBlockingOncopy) blocked.push("copy");
        if (hasBlockingOncut) blocked.push("cut");
        pasteBlockingInputs.push(`${name} (blocks: ${blocked.join(", ")})`);
      }
    }

    if (pasteBlockingInputs.length > 0) {
      checks.push({
        name: "paste-inputs",
        status: "fail",
        message: `${pasteBlockingInputs.length} input(s) prevent paste`,
        items: pasteBlockingInputs.map((id) => ({ id })),
      });
    } else if (inputs.length > 0) {
      checks.push({
        name: "paste-inputs",
        status: "pass",
        message: "No paste-blocking inputs detected",
        details: { inputsChecked: inputs.length },
      });
    } else {
      checks.push({
        name: "paste-inputs",
        status: "info",
        message: "No text inputs found",
      });
    }

    return { checks };
  },
};
