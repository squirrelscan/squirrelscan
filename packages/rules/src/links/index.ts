// Links rules - link analysis

import type { Rule } from "../types";

import { anchorTextRule } from "./anchor-text";
import { brokenExternalLinksRule } from "./broken-external-links";
import { brokenLinksRule } from "./broken-links";
import { deadEndPages } from "./dead-end-pages";
import { deadLinksRule } from "./dead-links";
import { externalLinksRule } from "./external-links";
import { httpsDowngradeRule } from "./https-downgrade";
import { internalLinksRule } from "./internal-links";
import { invalidLinksRule } from "./invalid-links";
import { nofollowInternalRule } from "./nofollow-internal";
import { orphanPagesRule } from "./orphan-pages";
import { redirectChainsRule } from "./redirect-chains";
import { telMailtoRule } from "./tel-mailto";
import { weakInternalLinksRule } from "./weak-internal-links";

export * from "./redirects";

export const rules: Rule[] = [
  internalLinksRule,
  externalLinksRule,
  invalidLinksRule,
  brokenLinksRule,
  brokenExternalLinksRule,
  deadLinksRule,
  redirectChainsRule,
  nofollowInternalRule,
  orphanPagesRule,
  weakInternalLinksRule,
  deadEndPages,
  anchorTextRule,
  httpsDowngradeRule,
  telMailtoRule,
];

export {
  anchorTextRule,
  brokenExternalLinksRule,
  brokenLinksRule,
  deadEndPages,
  deadLinksRule,
  externalLinksRule,
  httpsDowngradeRule,
  internalLinksRule,
  invalidLinksRule,
  nofollowInternalRule,
  orphanPagesRule,
  redirectChainsRule,
  telMailtoRule,
  weakInternalLinksRule,
};
