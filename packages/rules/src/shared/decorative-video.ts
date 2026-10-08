// Decorative video exemption shared by a11y/video-captions and
// video/video-accessible (#486), so the two rules cannot disagree.
//
// A muted video with no controls that plays by itself (autoplay or loop) is a
// background or hero loop: the viewer has no way to turn sound on, so there is
// nothing to caption (WCAG 1.2.2 covers synchronized media with audio).
// `aria-hidden="true"` marks a video as removed from the accessibility tree, so
// it is decorative by the author's own statement. This is a heuristic: a muted
// video with no autoplay, no loop and no controls is played by script, so it
// stays flagged.

const CAPTION_TRACK_SELECTOR = 'track[kind="captions"], track[kind="subtitles"]';

interface VideoElement {
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

export function isDecorativeVideo(video: VideoElement): boolean {
  if (video.getAttribute("aria-hidden")?.trim().toLowerCase() === "true") {
    return true;
  }
  return (
    video.hasAttribute("muted") &&
    !video.hasAttribute("controls") &&
    (video.hasAttribute("autoplay") || video.hasAttribute("loop"))
  );
}

export function hasCaptionTrack(video: VideoElement): boolean {
  return video.querySelectorAll(CAPTION_TRACK_SELECTOR).length > 0;
}

export interface VideoPartition<T extends VideoElement> {
  /** Videos that need a caption track (not decorative). */
  checked: T[];
  /** Number of decorative videos skipped. */
  decorativeSkipped: number;
}

export function partitionDecorativeVideos<T extends VideoElement>(
  videos: Iterable<T>,
): VideoPartition<T> {
  const checked: T[] = [];
  let decorativeSkipped = 0;
  for (const video of videos) {
    if (isDecorativeVideo(video)) decorativeSkipped++;
    else checked.push(video);
  }
  return { checked, decorativeSkipped };
}
