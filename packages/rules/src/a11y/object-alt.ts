// a11y/object-alt - Object elements have alternative text

import { sortUnnamedControls, unconfirmedRow } from "../shared/static-hidden";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const objectAltRule: Rule = {
  meta: {
    id: "a11y/object-alt",
    name: "Object Alt Text",
    description: "Checks that object elements have alternative content",
    solution:
      "Object elements need alternative content for when the embedded content can't be displayed or for assistive technology. Add content between <object> tags as fallback, or use aria-label/aria-labelledby. An element hidden by the hidden attribute, aria-hidden, a closed dialog or an inline style='display:none' is out of the accessibility tree and is not reported, but it needs a name before it is shown. A <style> rule squirrel can decide counts too. An object element carrying a no-js class (itself or an ancestor other than <html>) on a page with an external stylesheet or @import is reported as unconfirmed, because the theme may hide it when JavaScript runs. One a style may hide but squirrel cannot settle (a pseudo-class, a media query, a page that also loads an external stylesheet) is reported as unconfirmed. External stylesheets are not read, so an element hidden only by one is still reported.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const objects = doc.querySelectorAll("object");
    // pub#1002: out of the accessibility tree is skipped, a style that may hide
    // it is unconfirmed, like button-name.
    const unnamed = sortUnnamedControls<string>();

    for (const obj of objects) {
      const ariaLabel = obj.getAttribute("aria-label");
      const ariaLabelledby = obj.getAttribute("aria-labelledby");
      const role = obj.getAttribute("role");

      // Skip presentational objects
      if (role === "presentation" || role === "none") continue;

      // Check for inner content (fallback text)
      const hasInnerContent = obj.textContent?.trim();

      if (!ariaLabel?.trim() && !ariaLabelledby && !hasInnerContent) {
        const type = obj.getAttribute("type") || "";
        const data = obj.getAttribute("data") || "";
        const name = obj.getAttribute("name") || "";

        let identifier = "object";
        if (name) identifier = `object[name="${name}"]`;
        else if (type) identifier = `object[type="${type.split("/").pop()}"]`;
        else if (data)
          identifier = `object (${data.split("/").pop()?.split("?")[0]})`;

        unnamed.add(obj, identifier);
      }
    }

    const missingAlt = unnamed.failures;

    if (missingAlt.length > 0) {
      checks.push({
        name: "object-alt",
        status: "warn",
        message: `${missingAlt.length} object element(s) without alternative content`,
        items: missingAlt.map((id) => ({ id })),
      });
    }
    if (unnamed.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow("object-alt", "object element(s) without alternative content", unnamed.unconfirmed),
      );
    }
    if (missingAlt.length === 0 && unnamed.unconfirmed.length === 0) {
      if (objects.length > 0) {
        checks.push({
          name: "object-alt",
          status: "pass",
          message:
            unnamed.hidden > 0
              ? "All object elements in the accessibility tree have alternative content"
              : `${objects.length} object element(s) have alternative content`,
          ...(unnamed.hidden > 0 ? { details: { hiddenWithoutName: unnamed.hidden } } : {}),
        });
      } else {
        checks.push({
          name: "object-alt",
          status: "info",
          message: "No object elements found",
        });
      }
    }

    return { checks };
  },
};
