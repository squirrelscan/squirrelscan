// Re-export all storage types from core-contracts (canonical source)
export * from "@squirrelscan/core-contracts/storage";

/**
 * How long an unfinished crawl must have shown no activity before it counts as
 * abandoned (#941). `stopped` and `paused` are what `--resume` continues, and a
 * Ctrl-C leaves one, so they get the longer grace.
 */
export const ABANDONED_IDLE_MS = 30 * 60 * 1000;
export const ABANDONED_RESUMABLE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
