// video/video-thumbnail - Video thumbnail/poster check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const videoThumbnailRule: Rule = {
  meta: {
    id: "video/video-thumbnail",
    name: "Video Thumbnail",
    description: "Checks that videos have poster/thumbnail images",
    solution:
      "Video poster images improve perceived performance and user experience. For HTML5 video, use the poster attribute. For embedded videos, thumbnailUrl in VideoObject schema. Thumbnails should be high quality, relevant to content, and properly sized (recommend 1280x720 or higher).",
    category: "video",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const videos = doc.querySelectorAll("video");

    if (videos.length === 0) {
      checks.push({
        name: "video-thumbnail",
        status: "info",
        message: "No HTML5 video elements found",
      });
      return { checks };
    }

    let videosWithPoster = 0;
    let videosWithoutPoster = 0;

    for (const video of videos) {
      if (video.hasAttribute("poster")) {
        videosWithPoster++;
      } else {
        videosWithoutPoster++;
      }
    }

    if (videosWithoutPoster > 0) {
      checks.push({
        name: "video-thumbnail",
        status: "warn",
        message: `${videosWithoutPoster} video(s) missing poster attribute`,
        value: "Add poster images for better UX",
      });
    } else {
      checks.push({
        name: "video-thumbnail",
        status: "pass",
        message: `All ${videosWithPoster} video(s) have poster images`,
      });
    }

    return { checks };
  },
};
