/**
 * PageSpeed Insights API client
 *
 * Uses Google's free PSI API instead of local Lighthouse:
 * - 25,000 req/day free with API key
 * - Returns identical Lighthouse JSON structure
 * - No Chrome dependency
 *
 * Set GOOGLE_PSI_API_KEY env var for higher quota (required for production use)
 */

import type { PageSpeedInsightsResponse } from "./types";

const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export interface FetchPSIOptions {
  strategy?: "mobile" | "desktop";
  categories?: string[];
  apiKey?: string;
}

/**
 * Fetch PageSpeed Insights for a URL
 *
 * @param url - Target URL to analyze
 * @param options - Strategy (mobile/desktop), categories, and optional API key
 * @returns PSI API response with Lighthouse results
 */
export async function fetchPageSpeedInsights(
  url: string,
  options: FetchPSIOptions = {}
): Promise<PageSpeedInsightsResponse> {
  const {
    strategy = "mobile",
    categories = ["accessibility", "best-practices", "seo", "performance"],
  } = options;

  // Use API key from options, env var, or none
  const apiKey = options.apiKey ?? process.env.GOOGLE_PSI_API_KEY;

  const params = new URLSearchParams({
    url,
    strategy,
  });

  // Add API key if available
  if (apiKey) {
    params.append("key", apiKey);
  }

  // Add each category as separate param
  for (const cat of categories) {
    params.append("category", cat);
  }

  const apiUrl = `${PSI_ENDPOINT}?${params}`;

  const response = await fetch(apiUrl);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PSI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return data as PageSpeedInsightsResponse;
}

/**
 * Extract category scores from PSI response
 */
export function extractScores(psi: PageSpeedInsightsResponse): {
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  performance: number | null;
} {
  const cats = psi.lighthouseResult.categories;
  return {
    accessibility: cats.accessibility?.score ?? null,
    bestPractices: cats["best-practices"]?.score ?? null,
    seo: cats.seo?.score ?? null,
    performance: cats.performance?.score ?? null,
  };
}
