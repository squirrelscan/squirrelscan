// Re-export all storage types from core-contracts (canonical source)
export * from "@squirrelscan/core-contracts/storage";

/**
 * How long an unfinished crawl must have shown no activity before it counts as
 * abandoned (#941). `stopped` and `paused` are what `--resume` continues, and a
 * Ctrl-C leaves one, so they get the longer grace.
 */
export const ABANDONED_IDLE_MS = 30 * 60 * 1000;
export const ABANDONED_RESUMABLE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Crawl lease (#946): the process driving a crawl beats every
 * CRAWL_LEASE_HEARTBEAT_MS; a lease older than CRAWL_LEASE_STALE_MS is stale.
 * The beat is a 1-row write on its own connection that waits at most
 * CRAWL_LEASE_BUSY_TIMEOUT_MS and then skips, so it never queues behind the
 * crawl writer's 15 s busy timeout.
 */
export const CRAWL_LEASE_HEARTBEAT_MS = 15 * 1000;
export const CRAWL_LEASE_STALE_MS = 5 * 60 * 1000;
export const CRAWL_LEASE_BUSY_TIMEOUT_MS = 1000;
/** A same-host owner pid is trusted as live for at most this long (pid reuse). */
export const CRAWL_LEASE_PID_TRUST_MS = 24 * 60 * 60 * 1000;
