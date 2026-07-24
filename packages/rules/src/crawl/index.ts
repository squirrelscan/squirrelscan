// Crawl rules - crawlability & indexing checks
// robots.txt, sitemap, canonical chains

import type { Rule } from "../types";

import { allNoindexPages } from "./all-noindex-pages";
import { canonicalChainRule } from "./canonical-chain";
import { htmlSizeRule } from "./html-size";
import { indexabilityCheck } from "./indexability";
import { indexabilityConflicts } from "./indexability-conflicts";
import { noindexInSitemapRule } from "./noindex-in-sitemap";
import { paginationRule } from "./pagination";
import { pdfSizeRule } from "./pdf-size";
import { redirectChainRule } from "./redirect-chain";
import { robotsMetaConflictRule } from "./robots-meta-conflict";
import { robotsTxtRule } from "./robots-txt";
import { schemaNoindexConflict } from "./schema-noindex-conflict";
import { sitemap4xxRule } from "./sitemap-4xx";
import { sitemapCoverageRule } from "./sitemap-coverage";
import { sitemapDomainRule } from "./sitemap-domain";
import { sitemapExistsRule } from "./sitemap-exists";
import { sitemapValidRule } from "./sitemap-valid";
import { soft404Rule } from "./soft-404";

export const rules: Rule[] = [
  robotsTxtRule,
  sitemapExistsRule,
  sitemapValidRule,
  sitemap4xxRule,
  sitemapDomainRule,
  sitemapCoverageRule,
  robotsMetaConflictRule,
  noindexInSitemapRule,
  indexabilityCheck,
  allNoindexPages,
  indexabilityConflicts,
  schemaNoindexConflict,
  canonicalChainRule,
  paginationRule,
  redirectChainRule,
  htmlSizeRule,
  pdfSizeRule,
  soft404Rule,
];

export {
  allNoindexPages,
  canonicalChainRule,
  htmlSizeRule,
  indexabilityCheck,
  indexabilityConflicts,
  noindexInSitemapRule,
  paginationRule,
  pdfSizeRule,
  redirectChainRule,
  robotsMetaConflictRule,
  robotsTxtRule,
  schemaNoindexConflict,
  sitemapCoverageRule,
  sitemapDomainRule,
  sitemapExistsRule,
  sitemap4xxRule,
  sitemapValidRule,
  soft404Rule,
};
