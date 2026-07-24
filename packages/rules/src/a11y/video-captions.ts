// a11y/video-captions - Videos have captions/transcripts

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const videoCaptionsRule: Rule = {
  meta: {
    id: "a11y/video-captions",
    name: "Video Captions",
    description: "Checks that videos have captions or transcripts",
    solution:
      "All video content needs captions for deaf/hard-of-hearing users (WCAG 1.2.2). Add <track kind='captions' src='captions.vtt' srclang='en'> to video elements. For embedded videos (YouTube, Vimeo), enable captions in the embed settings. Also provide a text transcript for complex content. Auto-generated captions should be reviewed for accuracy.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Check native video elements
    const videos = doc.querySelectorAll("video");
    const videosWithoutCaptions: string[] = [];

    for (const video of videos) {
      const tracks = video.querySelectorAll(
        "track[kind='captions'], track[kind='subtitles']"
      );
      const src =
        video.getAttribute("src") ||
        video.querySelector("source")?.getAttribute("src") ||
        "";

      if (tracks.length === 0) {
        videosWithoutCaptions.push(src.substring(0, 50) || "inline video");
      }
    }

    // Check for embedded videos (iframes)
    const videoEmbeds = doc.querySelectorAll(
      'iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="wistia"]'
    );

    if (videos.length > 0) {
      if (videosWithoutCaptions.length > 0) {
        checks.push({
          name: "video-captions",
          status: "warn",
          message: `${videosWithoutCaptions.length} video(s) without caption tracks`,
          items: videosWithoutCaptions.map((src) => ({ id: src })),
        });
      } else {
        checks.push({
          name: "video-captions",
          status: "pass",
          message: "All videos have caption tracks",
          details: { videosChecked: videos.length },
        });
      }
    }

    if (videoEmbeds.length > 0) {
      checks.push({
        name: "video-embeds",
        status: "info",
        message: `${videoEmbeds.length} embedded video(s) detected`,
        value: "Verify captions are enabled in embed settings",
      });
    }

    if (videos.length === 0 && videoEmbeds.length === 0) {
      checks.push({
        name: "video-captions",
        status: "info",
        message: "No videos detected",
      });
    }

    return { checks };
  },
};
