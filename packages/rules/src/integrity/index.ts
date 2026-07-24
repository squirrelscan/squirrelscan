// Integrity rules — Phase A compromise heuristics (issue #116) + Phase B
// threat-intel rules (issue #117).
//
// Phase A: six heuristics over data already in RuleContext (no new context,
// infra, or external calls). False-positive discipline is enforced by a shared
// correlation pass (see ./signals): high-severity findings require >=2 distinct
// corroborating integrity signals; a lone signal emits `info`.
//
// Phase B: two rules read the opt-in threat-intel handle `ctx.intel` (feeds +
// memoized lookups + kit signatures, resolved by audit-engine before rules run).
// Both are no-ops when intel is off.
//
// Phase 3: the cloaking rule reads `ctx.site.cloakingProbes` — the opt-in
// differential-probe results (#118). No-op when the probe is off.

import type { Rule } from "../types";

import { brandImpersonationRule } from "./brand-impersonation";
import { cloakingRule } from "./cloaking";
import { fakeAuthOverlayRule } from "./fake-auth-overlay";
import { kitSignatureRule } from "./kit-signature";
import { knownMaliciousUrlRule } from "./known-malicious-url";
import { obfuscatedScriptRule } from "./obfuscated-script";
import { orphanPageRule } from "./orphan-page";
import { seoDoorwayRule } from "./seo-doorway";
import { templateDiscontinuityRule } from "./template-discontinuity";

export const rules: Rule[] = [
  templateDiscontinuityRule,
  orphanPageRule,
  brandImpersonationRule,
  obfuscatedScriptRule,
  fakeAuthOverlayRule,
  seoDoorwayRule,
  // Phase B threat-intel rules (#117) — read `ctx.intel`, no-op when intel off.
  knownMaliciousUrlRule,
  kitSignatureRule,
  // Phase 3 cloaking rule (#118) — reads `ctx.site.cloakingProbes`, no-op when
  // the opt-in differential probe is off.
  cloakingRule,
];

export {
  brandImpersonationRule,
  cloakingRule,
  fakeAuthOverlayRule,
  kitSignatureRule,
  knownMaliciousUrlRule,
  obfuscatedScriptRule,
  orphanPageRule,
  seoDoorwayRule,
  templateDiscontinuityRule,
};

// Shared signal detectors + correlation helpers (exported for tests / reuse).
export * from "./signals";
export * from "./fingerprint";
