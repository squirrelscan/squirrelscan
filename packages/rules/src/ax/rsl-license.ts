// ax/rsl-license - detect a robots.txt License: directive pointing to a valid RSL document

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const rslLicenseRule: Rule = {
  meta: {
    id: "ax/rsl-license",
    name: "RSL License",
    description:
      "Checks for a robots.txt License: directive (or Link: rel=license header) pointing to a valid Really Simple Licensing (RSL) document",
    solution:
      "Publish an RSL (rslstandard.org) document describing your usage terms — including AI-training permissions and any pay-per-crawl pricing — and reference it with a `License:` directive in robots.txt. This is a recommendation only — it never affects your score, except when a declared License: reference is broken (unfetchable or not valid RSL), which is flagged so you can fix the reference.",
    category: "ax",
    scope: "site",
    // warning so a broken License: reference carries a warning badge; absence
    // produces only info checks, which never enter the issues list.
    severity: "warning",
    weight: 1,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const rsl = ctx.site?.rsl;

    if (!rsl) {
      checks.push({ name: "rsl-license", status: "info", message: "RSL licensing data not available" });
      return { checks };
    }

    const hasSignal = rsl.robotsHasLicense || rsl.linkHeaderPresent || rsl.licenseUrls.length > 0;
    if (!hasSignal) {
      checks.push({
        name: "rsl-license-present",
        status: "info",
        message: "No machine-readable licensing declared (no robots.txt License: directive or Link: rel=license)",
        value: "absent",
      });
      return { checks };
    }

    checks.push({
      name: "rsl-license-present",
      status: "info",
      message: `License reference declared${rsl.robotsHasLicense ? " via robots.txt License:" : ""}${
        rsl.linkHeaderPresent ? " via Link: rel=license" : ""
      } (${rsl.licenseUrls.length} URL${rsl.licenseUrls.length === 1 ? "" : "s"})`,
      value: "present",
      details: {
        robotsHasLicense: rsl.robotsHasLicense,
        linkHeaderPresent: rsl.linkHeaderPresent,
        licenseUrls: rsl.licenseUrls,
      },
    });

    const validDocs = rsl.documents.filter((d) => d.status === 200 && d.xmlValid && d.looksRsl);
    const brokenDocs = rsl.documents.filter((d) => !(d.status === 200 && d.xmlValid && d.looksRsl));

    if (validDocs.length > 0) {
      checks.push({
        name: "rsl-license-valid",
        status: "info",
        message: `Valid RSL document found at ${validDocs[0]!.url}${
          validDocs.length > 1 ? ` (+${validDocs.length - 1} more)` : ""
        }`,
        value: "valid",
        details: { validUrls: validDocs.map((d) => d.url) },
      });
      return { checks };
    }

    // A License: reference exists but nothing it points to resolves as valid RSL —
    // an actionable defect (broken reference), not just an absent-but-optional signal.
    checks.push({
      name: "rsl-license-valid",
      status: "warn",
      message: `License declared but the referenced document didn't resolve as valid RSL (${brokenDocs
        .map((d) => `${d.url}: ${d.error ?? `status ${d.status}`}`)
        .join("; ")})`,
      value: "broken",
      items: brokenDocs.map((d) => ({
        id: d.url,
        label: `${d.url} — ${d.error ?? `HTTP ${d.status}${d.status === 200 ? ", not valid RSL XML" : ""}`}`,
      })),
      details: { brokenUrls: brokenDocs.map((d) => d.url) },
    });

    return { checks };
  },
};
