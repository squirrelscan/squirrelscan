// a11y/frame-title - Frames/iframes have titles

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const frameTitleRule: Rule = {
  meta: {
    id: "a11y/frame-title",
    name: "Frame Title",
    description: "Checks that iframes and frames have title attributes",
    solution:
      "All iframes must have a title attribute describing their content. This helps screen reader users understand what the iframe contains. Example: <iframe src='video.html' title='Product demo video'>",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const frames = doc.querySelectorAll("iframe, frame");
    const missingTitles: string[] = [];

    for (const frame of frames) {
      const title = frame.getAttribute("title");
      const ariaLabel = frame.getAttribute("aria-label");
      const ariaLabelledby = frame.getAttribute("aria-labelledby");
      const ariaHidden = frame.getAttribute("aria-hidden");

      // Skip hidden frames
      if (ariaHidden === "true") continue;

      // Skip frames with role=presentation or role=none
      const role = frame.getAttribute("role");
      if (role === "presentation" || role === "none") continue;

      if (!title?.trim() && !ariaLabel?.trim() && !ariaLabelledby) {
        const src = frame.getAttribute("src") || "";
        const name = frame.getAttribute("name") || "";
        const id = frame.getAttribute("id") || "";

        let identifier = "iframe";
        if (name) identifier = `iframe[name="${name}"]`;
        else if (id) identifier = `iframe#${id}`;
        else if (src) {
          const hostname = src.includes("//")
            ? src.split("/")[2]?.split("?")[0] || src
            : src.split("/")[0]?.split("?")[0] || src;
          identifier = `iframe (${hostname})`;
        }

        missingTitles.push(identifier);
      }
    }

    if (missingTitles.length > 0) {
      checks.push({
        name: "frame-title",
        status: "fail",
        message: `${missingTitles.length} iframe(s) without title attribute`,
        items: missingTitles.slice(0, 10).map((id) => ({ id })),
        details:
          missingTitles.length > 10
            ? { additional: missingTitles.length - 10 }
            : undefined,
      });
    } else if (frames.length > 0) {
      checks.push({
        name: "frame-title",
        status: "pass",
        message: `${frames.length} iframe(s) have title attributes`,
      });
    } else {
      checks.push({
        name: "frame-title",
        status: "info",
        message: "No iframes found",
      });
    }

    return { checks };
  },
};
