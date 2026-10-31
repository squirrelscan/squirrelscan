// Which pre-crawl discovery probes an audit sends (#409). A probe exists only to
// feed the rules that declare it (`RuleMeta.discoveryProbes`), so an audit that
// runs none of its readers has no reason to send it, and a user whose firewall
// bans the requests can turn them all off.

import { DISCOVERY_PROBES } from "@squirrelscan/core-contracts/storage";

import type { DiscoveryProbe } from "@squirrelscan/core-contracts";

import { filterRules } from "./filter";
import { loadAllRules, type RuleNamespace } from "./loader";

export interface DiscoveryProbeSelectionInput {
  /** False when `[crawler] disable_discovery_probes` or `--disable-discovery-probes` says so. */
  enabled: boolean;
  /** The run's resolved rule selection (config merged with --rule-include/--rule-exclude). */
  rules: { enable?: string[]; disable?: string[] };
  /** Per-rule config; only its `enabled` key matters here. */
  ruleOptions?: Record<string, { enabled?: boolean }>;
  /**
   * Rule namespaces beyond the built-ins (plugins), the same ones the runner
   * gets. A plugin rule that reads a probe must declare it in its own
   * `meta.discoveryProbes` for the probe to be sent.
   */
  additionalNamespaces?: RuleNamespace[];
}

/**
 * The discovery probes at least one enabled rule reads, in preamble order.
 * Empty when probes are turned off.
 */
export function selectDiscoveryProbes(input: DiscoveryProbeSelectionInput): DiscoveryProbe[] {
  if (!input.enabled) return [];
  const rules = loadAllRules({
    additionalNamespaces: input.additionalNamespaces,
    includeOptIn: true,
  });
  const wanted = new Set<DiscoveryProbe>();
  for (const id of filterRules(
    [...rules.keys()],
    input.rules.enable,
    input.rules.disable,
    input.ruleOptions ?? {},
    rules,
  )) {
    for (const probe of rules.get(id)?.meta.discoveryProbes ?? []) wanted.add(probe);
  }
  return DISCOVERY_PROBES.filter((probe) => wanted.has(probe));
}

/** The rules whose configured `paths` the `configured-pages` probe asks for (#1428). */
const CONFIGURED_PAGE_RULES = ["eeat/about-page", "eeat/privacy-policy"] as const;

/**
 * The concrete page paths the E-E-A-T rules are configured with, for the `configured-pages` probe (#1428).
 * Only a pattern that names one path can be requested: it starts with `/`, is not a `regex:` pattern and has
 * no whitespace, query or fragment. A substring such as `agentur` or a regular expression has no path to
 * ask for and is matched against crawled pages only, as before.
 */
export function configuredPagePaths(ruleOptions: Record<string, unknown> | undefined): string[] {
  const out = new Set<string>();
  for (const id of CONFIGURED_PAGE_RULES) {
    const options = ruleOptions?.[id];
    const paths = (options as { paths?: unknown } | undefined)?.paths;
    if (!Array.isArray(paths)) continue;
    for (const path of paths) {
      if (typeof path !== "string" || path.length > 512) continue;
      if (!path.startsWith("/") || path.startsWith("//")) continue;
      if (/[\s?#\\]/.test(path)) continue;
      out.add(path);
    }
  }
  return [...out];
}
