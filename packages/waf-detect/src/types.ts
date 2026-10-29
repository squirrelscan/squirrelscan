export type WafProvider =
  | "cloudflare"
  | "akamai"
  | "aws-waf"
  | "sucuri"
  | "imperva"
  | "datadome"
  | "perimeterx"
  | "kasada"
  | "unknown";

/**
 * Every provider a challenge or block page can be attributed to. A superset of
 * {@link WafProvider}, which stays the vocabulary of header and body
 * attribution (and of the cloud's stored link-check results): the providers
 * added here are recognised only by their block pages.
 */
export type WafBlockProvider = WafProvider | "f5" | "vercel" | "wordfence" | "radware";

export interface WafDetectionResult {
  detected: boolean;
  /**
   * The provider most specific to the block: a bot-management vendor over the
   * CDN it sits behind (DataDome behind Cloudflare is DataDome). See
   * `PROVIDER_PRECEDENCE`.
   */
  provider: WafProvider | null;
  confidence: "high" | "medium" | "low";
  indicators: string[];
  /**
   * Every provider with a signal, most specific first. A caller asking "did
   * this come through Cloudflare?" reads this, not `provider`.
   */
  providers: WafProvider[];
}

export interface WafChallengeResult {
  detected: boolean;
  provider: string | null;
}

/** A {@link WafChallengeResult} that also says which provider id matched and why. */
export interface WafChallengeDetail extends WafChallengeResult {
  /** The provider id, when the response named one. */
  providerId: WafBlockProvider | null;
  /**
   * What matched, in words a person can act on ("cf-mitigated: challenge
   * header"). Never a slice of the page: the page is chosen by the site.
   * Null when nothing matched.
   */
  signal: string | null;
}

/**
 * How sure a response is a perimeter block. `blocked` fails a seed page and
 * keeps any other page out of scoring; `suspect` is a refusal-shaped page
 * without a provider-specific marker, so it warns and the page is still audited.
 */
export type WafVerdict = "blocked" | "suspect" | "clear";

export interface WafBlockResult {
  verdict: WafVerdict;
  providerId: WafBlockProvider | null;
  provider: string | null;
  signal: string | null;
}

/** Response headers by lower-case name, or a `Headers` object. */
export type HeaderBag = Headers | Readonly<Record<string, string | null | undefined>>;

export interface WafResponse {
  status: number;
  headers: {
    server?: string | null;
    cfCacheStatus?: string | null;
    xCache?: string | null;
    /**
     * Every response header the caller kept (a `Headers`, or the page record's
     * `techHeaders`). The provider-specific headers (`cf-mitigated`,
     * `x-amzn-waf-action`, `x-vercel-mitigated`, `x-px-blocked`) are read here.
     */
    raw?: HeaderBag | null;
  };
  html: string | null;
}
