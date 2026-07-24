// schema/video - VideoObject schema validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const REQUIRED_PROPS = ["name", "description", "thumbnailUrl", "uploadDate"];
const RECOMMENDED_PROPS = ["duration", "contentUrl", "embedUrl"];

export const videoSchemaRule: Rule = {
  meta: {
    id: "schema/video",
    name: "Video Schema",
    description: "Validates VideoObject schema for video content",
    solution:
      "VideoObject schema enables video rich results and carousels. Required: name, description, thumbnailUrl, uploadDate. Recommended: duration (ISO 8601), contentUrl, embedUrl. For video courses, use Course with hasCourseInstance. Ensure thumbnailUrl is high quality (min 160x90, max 1920x1080).",
    category: "schema",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Check if page has video content
    const hasVideoElement = doc.querySelector(
      "video, iframe[src*='youtube'], iframe[src*='vimeo']"
    );

    const schemaScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    let videoSchema: Record<string, unknown> | null = null;

    for (const script of schemaScripts) {
      try {
        const data = JSON.parse(script.textContent || "");
        const schemas = Array.isArray(data) ? data : [data];

        for (const schema of schemas) {
          const type = schema["@type"];
          if (
            type === "VideoObject" ||
            (Array.isArray(type) && type.includes("VideoObject"))
          ) {
            videoSchema = schema;
            break;
          }
        }
      } catch {
        // Invalid JSON
      }
    }

    if (!videoSchema) {
      if (hasVideoElement) {
        checks.push({
          name: "video-schema",
          status: "warn",
          message: "Page has video but no VideoObject schema",
          value: "Add schema for video rich results",
        });
      } else {
        checks.push({
          name: "video-schema",
          status: "info",
          message: "No VideoObject schema found",
        });
      }
      return { checks };
    }

    // Check required properties
    const missing: string[] = [];
    for (const prop of REQUIRED_PROPS) {
      if (!videoSchema[prop]) {
        missing.push(prop);
      }
    }

    if (missing.length > 0) {
      checks.push({
        name: "video-required",
        status: "warn",
        message: `VideoObject missing required properties`,
        items: missing.map((prop) => ({ id: prop })),
      });
    } else {
      checks.push({
        name: "video-required",
        status: "pass",
        message: "VideoObject has required properties",
      });
    }

    // Check recommended
    const missingRec = RECOMMENDED_PROPS.filter((p) => !videoSchema![p]);
    if (missingRec.length > 0) {
      checks.push({
        name: "video-recommended",
        status: "info",
        message: `VideoObject could include recommended properties`,
        items: missingRec.map((prop) => ({ id: prop })),
      });
    }

    // Check duration format
    const duration = videoSchema["duration"];
    if (
      duration &&
      typeof duration === "string" &&
      !duration.startsWith("PT")
    ) {
      checks.push({
        name: "video-duration",
        status: "warn",
        message: "Duration should use ISO 8601 format",
        value: `Got: ${duration}, expected: PT1H30M`,
      });
    }

    return { checks };
  },
};
