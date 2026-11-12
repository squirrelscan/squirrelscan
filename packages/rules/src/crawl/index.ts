// Crawl rules - crawlability & indexing checks
// robots.txt, sitemap, canonical chains

import type { Rule } from "../types";

import { allNoindexPages } from "./all-noindex-pages";
import { conflictingIndexSignalsRule } from "./conflicting-index-signals";
import { canonicalChainRule } from "./canonical-chain";
import { htmlSizeRule } from "./html-size";
import { indexabilityCheck } from "./indexability";
import { indexabilityConflicts } from "./indexability-conflicts";
import { indexableSearchResults } from "./indexable-search-results";
import { noindexInSitemapRule } from "./noindex-in-sitemap";
import { paginationRule } from "./pagination";
import { pdfSizeRule } from "./pdf-size";
import { redirectChainRule } from "./redirect-chain";
import { renderedSignalMismatchRule } from "./rendered-signal-mismatch";
import { robotsMetaConflictRule } from "./robots-meta-conflict";
import { robotsTxtRule } from "./robots-txt";
import { schemaNoindexConflict } from "./schema-noindex-conflict";
import { sitemap4xxRule } from "./sitemap-4xx";
import { sitemapCoverageRule } from "./sitemap-coverage";
import { sitemapDomainRule } from "./sitemap-domain";
import { sitemapExistsRule } from "./sitemap-exists";
import { sitemapLastmodChurnRule } from "./sitemap-lastmod-churn";
import { sitemapLastmodDriftRule } from "./sitemap-lastmod-drift";
import { sitemapValidRule } from "./sitemap-valid";
import { singlePageSiteRule } from "./single-page-site";
import { soft404Rule } from "./soft-404";

export const rules: Rule[] = [
  robotsTxtRule,
  sitemapExistsRule,
  sitemapValidRule,
  sitemap4xxRule,
  sitemapDomainRule,
  sitemapCoverageRule,
  sitemapLastmodChurnRule,
  sitemapLastmodDriftRule,
  robotsMetaConflictRule,
  noindexInSitemapRule,
  conflictingIndexSignalsRule,
  indexabilityCheck,
  allNoindexPages,
  indexabilityConflicts,
  indexableSearchResults,
  schemaNoindexConflict,
  canonicalChainRule,
  paginationRule,
  redirectChainRule,
  htmlSizeRule,
  pdfSizeRule,
  soft404Rule,
  singlePageSiteRule,
  renderedSignalMismatchRule,
];

export {
  allNoindexPages,
  canonicalChainRule,
  conflictingIndexSignalsRule,
  htmlSizeRule,
  indexabilityCheck,
  indexabilityConflicts,
  indexableSearchResults,
  noindexInSitemapRule,
  paginationRule,
  pdfSizeRule,
  redirectChainRule,
  renderedSignalMismatchRule,
  robotsMetaConflictRule,
  robotsTxtRule,
  schemaNoindexConflict,
  sitemapCoverageRule,
  sitemapDomainRule,
  sitemapExistsRule,
  sitemap4xxRule,
  sitemapLastmodChurnRule,
  sitemapLastmodDriftRule,
  sitemapValidRule,
  singlePageSiteRule,
  soft404Rule,
};
