// video/video-accessible - Video accessibility check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const videoAccessibleRule: Rule = {
  meta: {
    id: "video/video-accessible",
    name: "Video Accessibility",
    description: "Checks for video captions and transcripts",
    solution:
      "Videos need captions for deaf/hard-of-hearing users and transcripts for SEO. Use <track> elements for captions. Provide text transcripts on the page. Auto-generated captions should be reviewed for accuracy. Captions also help when audio can't be played. Required by WCAG 2.1 Level A.",
    category: "video",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const videos = doc.querySelectorAll("video");

    if (videos.length === 0) {
      checks.push({
        name: "video-accessible",
        status: "info",
        message: "No HTML5 video elements found",
      });
      return { checks };
    }

    let videosWithCaptions = 0;

    for (const video of videos) {
      const tracks = video.querySelectorAll(
        'track[kind="captions"], track[kind="subtitles"]'
      );
      if (tracks.length > 0) {
        videosWithCaptions++;
      }
    }

    if (videosWithCaptions === videos.length) {
      checks.push({
        name: "video-accessible",
        status: "pass",
        message: `All ${videos.length} video(s) have caption tracks`,
      });
    } else if (videosWithCaptions > 0) {
      checks.push({
        name: "video-accessible",
        status: "info",
        message: `${videosWithCaptions}/${videos.length} video(s) have caption tracks`,
      });
    } else {
      checks.push({
        name: "video-accessible",
        status: "warn",
        message: `No videos have caption tracks`,
        value: "Add <track> elements for accessibility",
      });
    }

    return { checks };
  },
};
