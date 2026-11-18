// AX rules - Agent Experience (agent-readiness) checks

import type { Rule } from "../types";

import { agentBlockingRule } from "./agent-blocking";
import { agentsMdRule } from "./agents-md";
import { aiCrawlersRule } from "./ai-crawlers";
import { answerBlocksRule } from "./answer-blocks";
import { apiDiscoveryRule } from "./api-discovery";
import { archiveIndexingRule } from "./archive-indexing";
import { commerceReadinessRule } from "./commerce-readiness";
import { contentSignalsRule } from "./content-signals";
import { contentWithoutJsRule } from "./content-without-js";
import { llmsTxtRule } from "./llms-txt";
import { markdownResponseRule } from "./markdown-response";
import { noaiSignalsRule } from "./noai-signals";
import { payPerCrawlRule } from "./pay-per-crawl";
import { rslLicenseRule } from "./rsl-license";
import { tokenWeightRule } from "./token-weight";
import { webmcpRule } from "./webmcp";
import { wellKnownAgentRule } from "./well-known-agent";

export const rules: Rule[] = [
  aiCrawlersRule,
  agentBlockingRule,
  contentSignalsRule,
  noaiSignalsRule,
  llmsTxtRule,
  markdownResponseRule,
  contentWithoutJsRule,
  tokenWeightRule,
  agentsMdRule,
  wellKnownAgentRule,
  apiDiscoveryRule,
  archiveIndexingRule,
  rslLicenseRule,
  payPerCrawlRule,
  webmcpRule,
  answerBlocksRule,
  commerceReadinessRule,
];

export {
  answerBlocksRule,
  agentBlockingRule,
  agentsMdRule,
  archiveIndexingRule,
  aiCrawlersRule,
  commerceReadinessRule,
  apiDiscoveryRule,
  contentSignalsRule,
  contentWithoutJsRule,
  llmsTxtRule,
  markdownResponseRule,
  noaiSignalsRule,
  payPerCrawlRule,
  rslLicenseRule,
  tokenWeightRule,
  webmcpRule,
  wellKnownAgentRule,
};
