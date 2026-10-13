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
