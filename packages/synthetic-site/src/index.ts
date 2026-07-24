// Programmatic API — see packages/synthetic-site/README-less summary below,
// or `bun run packages/synthetic-site/src/cli.ts --help` for the CLI.
//
//   generateSiteModel(opts)       deterministic, pure, no I/O — the shared core
//   serveSite(model, opts)        HTTP mode: Bun.serve over the model
//   writeCrawlToStorage(model, path, opts)   direct-storage mode: SQLite crawl DB

export {
  LONG_H1_MIN_LENGTH,
  LONG_URL_MIN_LENGTH,
  OVERSIZE_DESCRIPTION_MIN_LENGTH,
  OVERSIZE_TITLE_MIN_LENGTH,
} from "./constants";
export { buildRobotsTxt, buildSitemapXml, renderPageHtml } from "./html-render";
export { generateSiteModel } from "./page-model";
export { createRng, deriveSeed, type Rng } from "./prng";
export type { LatencyRange, ServedSite, ServeSiteOptions } from "./server";
export { serveSite } from "./server";
export type { WriteCrawlOptions, WriteCrawlResult } from "./storage-writer";
export { writeCrawlToStorage } from "./storage-writer";
export type {
  DuplicateGroupSpec,
  GenerateSiteModelOptions,
  IssueMixOptions,
  IssueSpec,
  IssueTag,
  PageModel,
  PageTemplate,
  RedirectChainSpec,
  ResolvedSiteOptions,
  SiteModel,
} from "./types";
