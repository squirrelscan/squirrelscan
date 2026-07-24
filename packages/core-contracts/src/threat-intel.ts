// Threat-intel contracts — shared between @squirrelscan/threat-intel (the engine
// that builds the data) and @squirrelscan/rules (the integrity rules that read
// it via `ctx.intel`). Kept here, dependency-light, so the rules package never
// has to import the network/feed code in `threat-intel` — only these types.
//
// Phase B of the site-integrity epic (#115/#117). Opt-in, API-keyed: catches
// token-gated / cloaked phishing kits that never render for our crawler by
// cross-referencing crawled URLs against threat feeds, plus a YARA-style
// signature engine over the HTML/JS we DID fetch.

/**
 * Stable id of a threat-intel provider. Each provider sits behind its own config
 * key (an API key or an explicit enable flag); all are optional. Feed providers
 * are daily-pulled into a blocklist cache; lookup providers are queried
 * on-demand and memoized per run (never per-page API spam).
 */
export type IntelProviderId =
  | "safe-browsing" // Google Safe Browsing / Web Risk — on-demand lookup
  | "urlscan" // urlscan.io search — on-demand lookup
  | "virustotal" // VirusTotal — on-demand lookup
  | "urlhaus" // abuse.ch URLhaus — daily-pull feed
  | "threatfox" // abuse.ch ThreatFox — daily-pull feed
  | "openphish" // OpenPhish — daily-pull feed
  | "phishtank"; // PhishTank — daily-pull feed

/** How a provider/feed flagged a URL — by full URL, registrable domain, or host. */
export type IntelMatchKind = "url" | "domain" | "host";

/** A single provider/feed that lists a URL or domain as malicious. */
export interface IntelSource {
  provider: IntelProviderId;
  matched: IntelMatchKind;
  /** Threat classification reported by the provider, if any (e.g. "phishing"). */
  threat?: string;
  /** Provider reference for follow-up (urlscan result id, VT permalink, feed line). */
  reference?: string;
}

/** Verdict for one URL looked up against feeds + on-demand providers. */
export interface IntelUrlVerdict {
  url: string;
  /** True when at least one provider/feed flagged this URL/domain/host. */
  listed: boolean;
  /**
   * False when no provider was configured / consulted for this URL (opt-in not
   * active, or nothing prefetched). A rule treats `checked: false` as "unknown",
   * never as "clean".
   */
  checked: boolean;
  sources: IntelSource[];
}

/** Severity a signature carries when it matches. */
export type SignatureSeverity = "critical" | "high" | "medium" | "low";

/** Corpus a signature string is matched against. */
export type SignatureTarget =
  | "title"
  | "html"
  | "text"
  | "url"
  | "scripts" // external script bodies fetched for the page
  | "any"; // title + html + text + url + scripts concatenated

/** Page corpus a page-scope rule hands to the signature engine. */
export interface SignatureMatchInput {
  url: string;
  title?: string;
  html: string;
  text?: string;
  /** External script bodies fetched for the page/site (inline scripts live in `html`). */
  scripts?: string[];
}

/** One signature that matched the input. */
export interface SignatureMatch {
  id: string;
  name: string;
  severity: SignatureSeverity;
  description?: string;
  /** String-keys whose patterns matched, for explainability in the finding. */
  matchedStrings: string[];
}

/**
 * Threat-intel handle threaded onto `RuleContext.intel` by the audit engine
 * BEFORE rules run. All network / feed work is done up-front (daily-pull feeds +
 * memoized on-demand lookups), so the methods here are SYNCHRONOUS and PURE —
 * rules never open a socket at rule time. `undefined` on `ctx` means the feature
 * is off / not opted-in, in which case integrity intel rules contribute nothing.
 */
export interface IntelContext {
  /** Providers actually consulted this run (config keys present). */
  readonly providers: IntelProviderId[];
  /** Number of loaded kit signatures (transparency / debugging). */
  readonly signatureCount: number;
  /** Look up a URL against cached feeds + memoized on-demand provider results. */
  lookupUrl(url: string): IntelUrlVerdict;
  /** Match page HTML / JS against the loaded kit signatures. */
  matchSignatures(input: SignatureMatchInput): SignatureMatch[];
}
