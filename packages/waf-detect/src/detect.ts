import type { WafDetectionResult, WafProvider } from "./types";
import { HEADER_PATTERNS, CONTENT_PATTERNS } from "./providers";

const NO_WAF: WafDetectionResult = {
  detected: false,
  provider: null,
  confidence: "low",
  indicators: [],
};

/** Detect WAF from response headers */
export function detectWafFromHeaders(headers: Headers): WafDetectionResult {
  const indicators: string[] = [];
  let detectedProvider: WafProvider | null = null;
  let confidence: "high" | "medium" | "low" = "low";

  for (const {
    provider,
    headers: headerPatterns,
    confidence: conf,
  } of HEADER_PATTERNS) {
    for (const { name, pattern } of headerPatterns) {
      const value = headers.get(name);
      if (value !== null) {
        if (!pattern || pattern.test(value)) {
          indicators.push(`header:${name}=${value.slice(0, 50)}`);
          if (!detectedProvider) {
            detectedProvider = provider;
            confidence = conf;
          }
        }
      }
    }
  }

  if (!detectedProvider && indicators.length === 0) {
    return NO_WAF;
  }

  return {
    detected: true,
    provider: detectedProvider,
    confidence,
    indicators,
  };
}

/** Detect WAF from response body (challenge/block pages) */
export function detectWafFromContent(html: string): WafDetectionResult {
  const indicators: string[] = [];
  let detectedProvider: WafProvider | null = null;
  let confidence: "high" | "medium" | "low" = "low";

  // Only check first 10KB to avoid performance issues
  const sample = html.slice(0, 10240);

  for (const { provider, patterns, confidence: conf } of CONTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(sample)) {
        indicators.push(`content:${pattern.source.slice(0, 30)}`);
        if (!detectedProvider) {
          detectedProvider = provider;
          confidence = conf;
        }
        break; // One match per provider is enough
      }
    }
  }

  if (!detectedProvider && indicators.length === 0) {
    return NO_WAF;
  }

  return {
    detected: true,
    provider: detectedProvider,
    confidence,
    indicators,
  };
}

/** Combined WAF detection from headers and optional body */
export function detectWaf(headers: Headers, body?: string): WafDetectionResult {
  const headerResult = detectWafFromHeaders(headers);

  if (headerResult.detected && headerResult.confidence === "high") {
    return headerResult;
  }

  if (body) {
    const contentResult = detectWafFromContent(body);

    if (contentResult.detected) {
      if (!headerResult.detected || contentResult.confidence === "high") {
        return {
          detected: true,
          provider: contentResult.provider ?? headerResult.provider,
          confidence: contentResult.confidence,
          indicators: [...headerResult.indicators, ...contentResult.indicators],
        };
      }
    }
  }

  return headerResult;
}

/**
 * Quick check if a 403 response is likely WAF-blocked.
 * Use for external link checking to distinguish "truly forbidden" from "bot blocked".
 */
export function isLikelyWafBlock(
  status: number,
  headers: Headers,
  body?: string,
): boolean {
  if (status !== 403) {
    return false;
  }
  const result = detectWaf(headers, body);
  return result.detected;
}
