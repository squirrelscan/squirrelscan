// Which pre-crawl discovery probes an audit sends (#409). A probe exists only to
// feed the rules that declare it (`RuleMeta.discoveryProbes`), so an audit that
// runs none of its readers has no reason to send it, and a user whose firewall
// bans the requests can turn them all off.

import { DISCOVERY_PROBES } from "@squirrelscan/core-contracts/storage";

import type { DiscoveryProbe } from "@squirrelscan/core-contracts";

import { filterRules } from "./filter";
import { loadAllRules } from "./loader";

export interface DiscoveryProbeSelectionInput {
  /** `[crawler] discovery_probes`, after `--[no-]discovery-probes`. */
  enabled: boolean;
  /** The run's resolved rule selection (config merged with --rule-include/--rule-exclude). */
  rules: { enable?: string[]; disable?: string[] };
  /** Per-rule config; only its `enabled` key matters here. */
  ruleOptions?: Record<string, { enabled?: boolean }>;
}

/**
 * The discovery probes at least one enabled rule reads, in preamble order.
 * Empty when probes are turned off.
 */
export function selectDiscoveryProbes(input: DiscoveryProbeSelectionInput): DiscoveryProbe[] {
  if (!input.enabled) return [];
  const rules = loadAllRules();
  const wanted = new Set<DiscoveryProbe>();
  for (const id of filterRules(
    [...rules.keys()],
    input.rules.enable,
    input.rules.disable,
    input.ruleOptions ?? {},
  )) {
    for (const probe of rules.get(id)?.meta.discoveryProbes ?? []) wanted.add(probe);
  }
  return DISCOVERY_PROBES.filter((probe) => wanted.has(probe));
}
