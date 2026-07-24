// Rule loader - loads rules from namespaces

import type { Rule } from "./types";

import { rules as a11yRules } from "./a11y";
import { rules as adblockRules } from "./adblock";
import { rules as aiRules } from "./ai";
import { rules as analyticsRules } from "./analytics";
import { rules as axRules } from "./ax";
import { rules as contentRules } from "./content";
// Import rule modules (will be populated as rules are migrated)
import { rules as coreRules } from "./core";
import { rules as crawlRules } from "./crawl";
import { rules as eeatRules } from "./eeat";
import { rules as gapsRules } from "./gaps";
import { rules as i18nRules } from "./i18n";
import { rules as imagesRules } from "./images";
import { rules as integrityRules } from "./integrity";
import { rules as legalRules } from "./legal";
import { rules as linksRules } from "./links";
import { rules as localRules } from "./local";
import { rules as mobileRules } from "./mobile";
import { rules as perfRules } from "./performance";
import { rules as schemaRules } from "./schema";
import { rules as securityRules } from "./security";
import { rules as socialRules } from "./social";
import { rules as urlRules } from "./url";
import { rules as videoRules } from "./video";

export interface RuleNamespace {
  name: string; // "core", "a11y", or "github-org/repo"
  rules: Rule[];
}

// Built-in namespaces
const builtInNamespaces: RuleNamespace[] = [
  { name: "core", rules: coreRules },
  { name: "content", rules: contentRules },
  { name: "links", rules: linksRules },
  { name: "images", rules: imagesRules },
  { name: "schema", rules: schemaRules },
  { name: "security", rules: securityRules },
  { name: "integrity", rules: integrityRules },
  { name: "a11y", rules: a11yRules },
  { name: "i18n", rules: i18nRules },
  { name: "ai", rules: aiRules },
  { name: "ax", rules: axRules },
  { name: "perf", rules: perfRules },
  { name: "social", rules: socialRules },
  { name: "crawl", rules: crawlRules },
  { name: "url", rules: urlRules },
  { name: "mobile", rules: mobileRules },
  { name: "legal", rules: legalRules },
  { name: "local", rules: localRules },
  { name: "video", rules: videoRules },
  { name: "analytics", rules: analyticsRules },
  { name: "eeat", rules: eeatRules },
  { name: "adblock", rules: adblockRules },
  { name: "gaps", rules: gapsRules },
];

interface LoaderOptions {
  additionalNamespaces?: RuleNamespace[];
}

function getRuleNamespaces(options: LoaderOptions = {}): RuleNamespace[] {
  return [...builtInNamespaces, ...(options.additionalNamespaces ?? [])];
}

// Load all rules into a Map by ID
export function loadAllRules(options: LoaderOptions = {}): Map<string, Rule> {
  const rules = new Map<string, Rule>();
  const namespaces = getRuleNamespaces(options);

  for (const ns of namespaces) {
    for (const rule of ns.rules) {
      if (rule.meta.disabled) continue;
      if (rules.has(rule.meta.id)) {
        console.warn(`Duplicate rule ID: ${rule.meta.id}`);
      }
      rules.set(rule.meta.id, rule);
    }
  }

  return rules;
}

// Get all rule IDs
export function getAllRuleIds(options: LoaderOptions = {}): string[] {
  const ids: string[] = [];
  const namespaces = getRuleNamespaces(options);
  for (const ns of namespaces) {
    for (const rule of ns.rules) {
      if (rule.meta.disabled) continue;
      ids.push(rule.meta.id);
    }
  }
  return ids;
}

// Get rules by domain
export function getRulesByDomain(
  domain: string,
  options: LoaderOptions = {}
): Rule[] {
  const namespaces = getRuleNamespaces(options);
  const ns = namespaces.find((n) => n.name === domain);
  return ns?.rules.filter((r) => !r.meta.disabled) ?? [];
}

// Get all namespaces
export function getNamespaces(options: LoaderOptions = {}): RuleNamespace[] {
  const namespaces = getRuleNamespaces(options);
  return namespaces.map((ns) => ({
    ...ns,
    rules: ns.rules.filter((r) => !r.meta.disabled),
  }));
}
