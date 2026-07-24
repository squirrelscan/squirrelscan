// mobile/interstitials - Intrusive interstitial detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const interstitialsRule: Rule = {
  meta: {
    id: "mobile/interstitials",
    name: "Interstitials",
    description: "Detects potentially intrusive mobile interstitials",
    solution:
      "Google penalizes intrusive interstitials that cover main content on mobile. Avoid: popups that cover the content immediately on page load, standalone interstitials before the main content, above-the-fold layouts that look like interstitials. Allowed: age verification, cookie consent (small), login walls for paywalled content.",
    category: "mobile",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const html = ctx.page.html.toLowerCase();

    // Check for popup-related classes/IDs
    const potentialPopups: string[] = [];

    const divs = doc.querySelectorAll("div[class], div[id]");
    for (const div of divs) {
      const className = div.getAttribute("class") || "";
      const id = div.getAttribute("id") || "";

      if (
        /popup|modal|overlay|interstitial/i.test(className) ||
        /popup|modal|overlay|interstitial/i.test(id)
      ) {
        potentialPopups.push(className || id);
      }
    }

    // Check for popup libraries
    const popupLibraries = [
      "popup.js",
      "modal.js",
      "mailchimp",
      "sumo",
      "optinmonster",
      "hello-bar",
      "leadpages",
    ];

    const hasPopupLibrary = popupLibraries.some((lib) => html.includes(lib));

    if (potentialPopups.length > 0 || hasPopupLibrary) {
      checks.push({
        name: "interstitials",
        status: "info",
        message: "Popup/modal elements detected",
        value: "Ensure popups don't block content on mobile page load",
      });
    } else {
      checks.push({
        name: "interstitials",
        status: "pass",
        message: "No intrusive interstitial patterns detected",
      });
    }

    return { checks };
  },
};
