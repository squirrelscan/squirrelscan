// performance/animated-content - GIF to video suggestion

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  gif_size_threshold_kb: z
    .number()
    .default(100)
    .describe(
      "GIF size threshold in KB above which to suggest video conversion"
    ),
});

export const animatedContentRule: Rule = {
  meta: {
    id: "perf/animated-content",
    name: "Animated Content",
    description: "Checks for large GIFs that could be converted to video",
    solution:
      "Convert large animated GIFs to video formats (MP4, WebM) for 50-90% smaller files. Use <video autoplay loop muted playsinline> for GIF-like behavior. Tools: ffmpeg, gif2webm, or Cloudinary can automate conversion. Modern video codecs are far more efficient than GIF for animation.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 4,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];
    const gifImages: string[] = [];

    // Check for GIF images
    const images = doc.querySelectorAll("img");

    for (const img of images) {
      const src = img.getAttribute("src") || "";
      const srcLower = src.toLowerCase();

      // Check for GIF extension or animated GIF indicators
      if (srcLower.endsWith(".gif") || srcLower.includes(".gif?")) {
        const filename = src.split("/").pop()?.split("?")[0] || src;
        gifImages.push(filename);
      }
    }

    // Check for animated WebP (also can be large)
    // These are harder to detect without fetching the file

    // Check picture elements for GIF sources
    const pictureElements = doc.querySelectorAll("picture source");
    for (const source of pictureElements) {
      const srcset = source.getAttribute("srcset") || "";
      const type = source.getAttribute("type") || "";

      if (srcset.toLowerCase().includes(".gif") || type === "image/gif") {
        const filename =
          srcset.split("/").pop()?.split("?")[0]?.split(" ")[0] || srcset;
        if (!gifImages.includes(filename)) {
          gifImages.push(filename);
        }
      }
    }

    // Report findings
    if (gifImages.length > 0) {
      checks.push({
        name: "animated-gifs",
        status: "warn",
        message: `${gifImages.length} GIF image(s) found - consider video format`,
        items: gifImages.slice(0, 10).map((id) => ({ id })),
        details: {
          suggestion: "Convert to MP4/WebM with <video autoplay loop muted>",
          estimatedSavings: "50-90% smaller file sizes",
        },
      });
    } else {
      checks.push({
        name: "animated-content",
        status: "pass",
        message: "No GIF animations found",
      });
    }

    // Also check for video elements that might be too large or missing modern codecs
    const videos = doc.querySelectorAll("video");
    const videosWithoutModernCodec: string[] = [];

    for (const video of videos) {
      const sources = video.querySelectorAll("source");
      let hasModernCodec = false;

      for (const source of sources) {
        const type = source.getAttribute("type") || "";
        if (
          type.includes("webm") ||
          type.includes("av1") ||
          type.includes("hevc")
        ) {
          hasModernCodec = true;
          break;
        }
      }

      // Check video src directly
      const videoSrc = video.getAttribute("src") || "";
      if (videoSrc.includes(".webm") || videoSrc.includes(".av1")) {
        hasModernCodec = true;
      }

      if (sources.length > 0 && !hasModernCodec) {
        const src = sources[0]?.getAttribute("src") || videoSrc;
        const filename = src.split("/").pop()?.split("?")[0] || "video";
        videosWithoutModernCodec.push(filename);
      }
    }

    if (videosWithoutModernCodec.length > 0) {
      checks.push({
        name: "video-codecs",
        status: "info",
        message: `${videosWithoutModernCodec.length} video(s) could use modern codecs`,
        items: videosWithoutModernCodec.slice(0, 5).map((id) => ({ id })),
        details: {
          suggestion: "Add WebM/AV1 sources for better compression",
        },
      });
    }

    return { checks };
  },
};
