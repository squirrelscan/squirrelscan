// video/video-schema - VideoObject schema presence

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const videoSchemaPresenceRule: Rule = {
  meta: {
    id: "video/video-schema",
    name: "Video Schema",
    description: "Checks for VideoObject schema on pages with video",
    solution:
      "Add VideoObject schema to pages with video content for rich results. Required: name, description, thumbnailUrl, uploadDate. Recommended: duration, contentUrl, embedUrl. Schema enables video carousels and previews in search results. Test with Google's Rich Results Test.",
    category: "video",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Check for video elements
    const videos = doc.querySelectorAll("video");
    const youtubeEmbeds = doc.querySelectorAll('iframe[src*="youtube"]');
    const vimeoEmbeds = doc.querySelectorAll('iframe[src*="vimeo"]');

    const hasVideo =
      videos.length > 0 || youtubeEmbeds.length > 0 || vimeoEmbeds.length > 0;

    if (!hasVideo) {
      checks.push({
        name: "video-schema",
        status: "info",
        message: "No video content detected",
      });
      return { checks };
    }

    // Check for VideoObject schema
    const hasVideoSchema = ctx.parsed.schema.types.includes("VideoObject");

    if (hasVideoSchema) {
      checks.push({
        name: "video-schema",
        status: "pass",
        message: "VideoObject schema present for video content",
      });
    } else {
      checks.push({
        name: "video-schema",
        status: "warn",
        message: "Video content without VideoObject schema",
        value: "Add schema for video rich results",
      });
    }

    return { checks };
  },
};
