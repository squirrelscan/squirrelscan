// @squirrelscan/crawler — crawler types, storage, and utilities

export * from "./core";
export * from "./storage";
export * from "./types";

// URL prioritization and pattern matching for crawl ordering
export * from "./priority";
export * from "./pattern";
export * from "./prefix";

// Incremental crawl change detection
export * from "./incremental";

// Sticky per-project user-agent resolution (#875)
export * from "./user-agent";

// Browser-like request header construction (reused by audit-time re-fetches).
export { applyBrowserHeaders } from "./fetcher";

// Browser-like cache-store abstraction (local SQLite + cloud parity)
export * from "./cache-store";
