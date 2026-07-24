// @squirrelscan/threat-intel — opt-in, API-keyed threat-intel engine (#117).
// Daily-pull blocklist feeds + memoized on-demand lookups + a YARA-style kit
// signature engine, surfaced to rules as a synchronous `IntelContext`.

// Public consumer contracts live in core-contracts; re-export for convenience.
export type {
  IntelContext,
  IntelProviderId,
  IntelSource,
  IntelMatchKind,
  IntelUrlVerdict,
  SignatureMatch,
  SignatureMatchInput,
  SignatureSeverity,
  SignatureTarget,
} from "@squirrelscan/core-contracts";

export {
  buildIntelContext,
  prefetchIntel,
  defaultTransport,
  type BuildIntelOptions,
  type PrefetchIntelInput,
} from "./intel";

export { loadSignatures, matchSignatures, parseSignature, type Signature } from "./signatures";

export { refreshFeeds, lookupInSnapshot } from "./feeds";
export { runLookups } from "./lookups";
export { FEED_PROVIDERS, LOOKUP_PROVIDERS, isProviderEnabled } from "./providers";
export { getOrRefresh, MemoryKvStore, type KvStore } from "./cache";
export { normalizeUrl, hostOf, registrableDomain } from "./url";
export type {
  FeedEntry,
  FeedProvider,
  FeedSnapshot,
  IntelConfig,
  IntelTransport,
  LookupProvider,
  ProviderConfig,
  ResolvedIntel,
} from "./types";
