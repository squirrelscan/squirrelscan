// video/video-accessible - Video accessibility check

import { hasCaptionTrack, partitionDecorativeVideos } from "../shared/decorative-video";
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
    verdictScope: "page",
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

    // Decorative videos (muted, no controls, autoplay/loop, or aria-hidden) have
    // no audio to caption and are not counted (#486).
    const { checked, decorativeSkipped } = partitionDecorativeVideos(videos);
    const details = { videosChecked: checked.length, decorativeSkipped };

    if (checked.length === 0) {
      checks.push({
        name: "video-accessible",
        status: "pass",
        message: `No videos need captions (${decorativeSkipped} decorative skipped)`,
        details,
      });
      return { checks };
    }

    const videosWithCaptions = checked.filter(hasCaptionTrack).length;

    if (videosWithCaptions === checked.length) {
      checks.push({
        name: "video-accessible",
        status: "pass",
        message: `All ${checked.length} video(s) have caption tracks`,
        details,
      });
    } else if (videosWithCaptions > 0) {
      checks.push({
        name: "video-accessible",
        status: "info",
        message: `${videosWithCaptions}/${checked.length} video(s) have caption tracks`,
        details,
      });
    } else {
      checks.push({
        name: "video-accessible",
        status: "warn",
        message: `No videos have caption tracks`,
        value: "Add <track> elements for accessibility",
        details,
      });
    }

    return { checks };
  },
};
