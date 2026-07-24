// a11y/object-alt - Object elements have alternative text

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const objectAltRule: Rule = {
  meta: {
    id: "a11y/object-alt",
    name: "Object Alt Text",
    description: "Checks that object elements have alternative content",
    solution:
      "Object elements need alternative content for when the embedded content can't be displayed or for assistive technology. Add content between <object> tags as fallback, or use aria-label/aria-labelledby.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const objects = doc.querySelectorAll("object");
    const missingAlt: string[] = [];

    for (const obj of objects) {
      const ariaLabel = obj.getAttribute("aria-label");
      const ariaLabelledby = obj.getAttribute("aria-labelledby");
      const ariaHidden = obj.getAttribute("aria-hidden");
      const role = obj.getAttribute("role");

      // Skip hidden objects or presentational
      if (ariaHidden === "true") continue;
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

        missingAlt.push(identifier);
      }
    }

    if (missingAlt.length > 0) {
      checks.push({
        name: "object-alt",
        status: "warn",
        message: `${missingAlt.length} object element(s) without alternative content`,
        items: missingAlt.map((id) => ({ id })),
      });
    } else if (objects.length > 0) {
      checks.push({
        name: "object-alt",
        status: "pass",
        message: `${objects.length} object element(s) have alternative content`,
      });
    } else {
      checks.push({
        name: "object-alt",
        status: "info",
        message: "No object elements found",
      });
    }

    return { checks };
  },
};
