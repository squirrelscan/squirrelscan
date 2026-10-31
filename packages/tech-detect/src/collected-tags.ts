/** Tags whose attributes `tag-attr` detectors can read: the page pass (`pageMarkup` in detect.ts) keeps these, nothing else. */
export const COLLECTED_TAGS: ReadonlySet<string> = new Set(["script", "link", "img", "source", "iframe", "video", "audio", "embed", "object", "input"]);

/** A `tag-attr` detector for tags the page pass does not keep would never match: refuse it where it is built. */
export function assertCollectedTags(tags: readonly string[]): void {
  for (const tag of tags) {
    if (!COLLECTED_TAGS.has(tag)) throw new Error(`tag-attr detector on <${tag}>, which the page pass does not collect`);
  }
}
