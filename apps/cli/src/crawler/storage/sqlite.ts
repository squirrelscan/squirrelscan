// Re-export SQLiteStorage from @squirrelscan/crawler (canonical source).
// CLI-specific factory in ./index.ts injects the content store.
export { SQLiteStorage, type ContentStoreAdapter } from "@squirrelscan/crawler";
