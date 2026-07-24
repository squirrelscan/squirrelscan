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
  provider: WafProvider | null;
  confidence: "high" | "medium" | "low";
  indicators: string[];
}

export interface WafChallengeResult {
  detected: boolean;
  provider: string | null;
}
