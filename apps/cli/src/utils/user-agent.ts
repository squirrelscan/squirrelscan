// Re-export from @squirrelscan/utils
export * from "@squirrelscan/utils/user-agent";

// Sticky per-project user-agent resolution (#875) — lives in the crawler
// package beside the project store it persists to.
export {
  resolveStickyUserAgent,
  USER_AGENT_META_KEY,
  type StickyUserAgentResolution,
} from "@squirrelscan/crawler";
