// Re-export from @squirrelscan/waf-detect for backward compatibility
export {
  detectWaf,
  detectWafFromHeaders,
  detectWafFromContent,
  isLikelyWafBlock,
  getWafProviderName,
  detectWafChallengePage,
  WAF_CHALLENGE_STATUS_CODES,
  CHALLENGE_MARKUP_PATTERNS,
  CHALLENGE_TEXT_PATTERNS,
  CLOUDFLARE_CHALLENGE_SCRIPT,
  type WafProvider,
  type WafDetectionResult,
  type WafChallengeResult,
} from "@squirrelscan/waf-detect";
