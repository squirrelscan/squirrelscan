// AX rules - Agent Experience (agent-readiness) checks

import type { Rule } from "../types";

import { agentBlockingRule } from "./agent-blocking";
import { agentsMdRule } from "./agents-md";
import { aiCrawlersRule } from "./ai-crawlers";
import { apiDiscoveryRule } from "./api-discovery";
import { archiveIndexingRule } from "./archive-indexing";
import { contentSignalsRule } from "./content-signals";
import { contentWithoutJsRule } from "./content-without-js";
import { llmsTxtRule } from "./llms-txt";
import { markdownResponseRule } from "./markdown-response";
import { noaiSignalsRule } from "./noai-signals";
import { payPerCrawlRule } from "./pay-per-crawl";
import { rslLicenseRule } from "./rsl-license";
import { tokenWeightRule } from "./token-weight";
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
];

export {
  agentBlockingRule,
  agentsMdRule,
  archiveIndexingRule,
  aiCrawlersRule,
  apiDiscoveryRule,
  contentSignalsRule,
  contentWithoutJsRule,
  llmsTxtRule,
  markdownResponseRule,
  noaiSignalsRule,
  payPerCrawlRule,
  rslLicenseRule,
  tokenWeightRule,
  wellKnownAgentRule,
};
