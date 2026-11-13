import type { ReportHost, ReportTechnology } from "@squirrelscan/core-contracts";
import { countryName, GEOIP_SNAPSHOT, lookupCountry } from "@squirrelscan/utils/geoip";

/**
 * The technology fingerprints that mean "a CDN or edge platform answers for this site" (#10). This is only
 * the existing detection read back: nothing here detects an edge on its own.
 */
export const EDGE_TECHNOLOGY_IDS: Readonly<Record<string, string>> = {
  "cloudflare-cdn": "Cloudflare",
  "cloudflare-pages": "Cloudflare",
  cloudfront: "Amazon CloudFront",
  vercel: "Vercel",
  "vercel-edge": "Vercel",
  netlify: "Netlify",
  fastly: "Fastly",
  "akamai-cdn": "Akamai",
};

export interface HostProbe {
  host: string;
  ipv4: string[];
  ipv6: string[];
  latency?: ReportHost["latency"];
}

/** The detected edge provider, if technology detection found one of the supported ones. */
export function detectedEdge(
  technologies: ReadonlyArray<Pick<ReportTechnology, "id">> | undefined,
): { id: string; name: string } | null {
  for (const t of technologies ?? []) {
    const name = EDGE_TECHNOLOGY_IDS[t.id];
    if (name) return { id: t.id, name };
  }
  return null;
}

/**
 * Builds the report's host section from a resolved probe. The country is looked up offline for the first
 * address; it is omitted when the database has none. With a detected edge in front, the country is labelled
 * `edge`: the address is the edge network's, so it says nothing about where the origin is hosted.
 */
export async function buildReportHost(
  probe: HostProbe,
  technologies: ReadonlyArray<Pick<ReportTechnology, "id">> | undefined,
): Promise<ReportHost | undefined> {
  const address = probe.ipv4[0] ?? probe.ipv6[0];
  if (!address) return undefined;
  const host: ReportHost = {
    host: probe.host,
    addresses: { ipv4: probe.ipv4, ipv6: probe.ipv6 },
  };
  if (probe.latency) host.latency = probe.latency;
  const code = await lookupCountry(address);
  if (code) {
    const edge = detectedEdge(technologies);
    host.country = {
      code,
      name: countryName(code),
      location: edge ? "edge" : "origin",
      ...(edge ? { edge } : {}),
      address,
    };
    host.geoipSnapshot = GEOIP_SNAPSHOT;
  }
  return host;
}
