import type { ReportEdgeSource, ReportHost, ReportHostEdge, ReportTechnology } from "@squirrelscan/core-contracts";
import { matchEdgeAsn, matchEdgeRanges } from "@squirrelscan/utils/geoip/edge";
import { countryName, GEOIP_SNAPSHOT, lookupCountry } from "@squirrelscan/utils/geoip";

/**
 * The technology fingerprints that mean "a CDN or edge platform answers for this site" (#10, #1807), each
 * mapped to its provider key. This is only the existing detection read back: nothing here detects an edge
 * from page content on its own. Google Cloud CDN has no header of its own (its `Via: 1.1 google` is shared
 * with other products), so it is found only from the IP range source.
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
  "azure-front-door": "Azure Front Door",
};

/** Technology id to provider key. */
const TECH_PROVIDER: Readonly<Record<string, string>> = {
  "cloudflare-cdn": "cloudflare",
  "cloudflare-pages": "cloudflare",
  cloudfront: "cloudfront",
  vercel: "vercel",
  "vercel-edge": "vercel",
  netlify: "netlify",
  fastly: "fastly",
  "akamai-cdn": "akamai",
  "azure-front-door": "azure-front-door",
};

/** Platforms that are both edge and host: there is no separate origin behind them. */
const EDGE_HOSTED_PROVIDERS = new Set(["vercel", "netlify"]);
const EDGE_HOSTED_TECHNOLOGIES = new Set(["cloudflare-pages"]);

type TechInput = Pick<ReportTechnology, "id"> & Partial<Pick<ReportTechnology, "name" | "category" | "detectedBy">>;

export interface HostProbe {
  host: string;
  ipv4: string[];
  ipv6: string[];
  latency?: ReportHost["latency"];
}

/** The detected edge provider, if technology detection found one of the supported ones. */
export function detectedEdge(technologies: ReadonlyArray<TechInput> | undefined): { id: string; name: string } | null {
  for (const t of technologies ?? []) {
    const name = EDGE_TECHNOLOGY_IDS[t.id];
    if (name) return { id: t.id, name };
  }
  return null;
}

const SOURCE_ORDER: Record<ReportEdgeSource, number> = { header: 0, "ip-range": 1, asn: 2 };

/**
 * The edge of the audited host from three sources, strongest first: platform response headers (the existing
 * `cdn` and `hosting` fingerprints, only when their detector was a header), the resolved addresses against
 * the published provider ranges, and their ASN. The strongest source picks the provider; `matched` lists
 * every source that agreed and `alsoMatched` any other provider a source named. A range list that covers a
 * provider's whole cloud (Google Cloud) ranks below the edge-specific sources. The origin is reported as
 * unknown unless a separate hosting technology was detected; it is never the edge.
 */
export function detectEdge(
  addresses: ReadonlyArray<string>,
  technologies: ReadonlyArray<TechInput> | undefined,
): ReportHostEdge | null {
  interface Hit { id: string; name: string; source: ReportEdgeSource; broad: boolean; address?: string; asn?: number }
  const hits: Hit[] = [];
  for (const t of technologies ?? []) {
    const id = TECH_PROVIDER[t.id];
    if (!id) continue;
    if (t.detectedBy !== undefined && !t.detectedBy.startsWith("header:")) continue;
    hits.push({ id, name: EDGE_TECHNOLOGY_IDS[t.id]!, source: "header", broad: false });
  }
  for (const address of addresses) {
    for (const m of matchEdgeRanges(address)) {
      hits.push({ id: m.provider, name: m.name, source: "ip-range", broad: m.broad, address });
    }
    const a = matchEdgeAsn(address);
    if (a) hits.push({ id: a.provider, name: a.name, source: "asn", broad: false, address, asn: a.asn });
  }
  if (hits.length === 0) return null;
  const rank = (h: Hit) => (h.broad ? 3 : SOURCE_ORDER[h.source]);
  hits.sort((x, y) => rank(x) - rank(y));
  const best = hits[0]!;
  const same = hits.filter((h) => h.id === best.id);
  const matched = [...new Set(same.map((h) => h.source))].sort((x, y) => SOURCE_ORDER[x] - SOURCE_ORDER[y]);
  const lead = same.find((h) => h.source === best.source)!;
  const others = new Map<string, { id: string; name: string; source: ReportEdgeSource }>();
  for (const h of hits) if (h.id !== best.id && !others.has(h.id)) others.set(h.id, { id: h.id, name: h.name, source: h.source });
  const edgeHosted =
    EDGE_HOSTED_PROVIDERS.has(best.id) || (technologies ?? []).some((t) => EDGE_HOSTED_TECHNOLOGIES.has(t.id) && best.id === TECH_PROVIDER[t.id]);
  const hosting = (technologies ?? []).find((t) => t.category === "hosting" && !(t.id in EDGE_TECHNOLOGY_IDS));
  return {
    id: best.id,
    name: best.name,
    source: best.source,
    matched,
    ...(best.broad ? { broad: true as const } : {}),
    ...(lead.address ? { address: lead.address } : {}),
    ...(lead.asn !== undefined ? { asn: lead.asn } : {}),
    edgeHosted,
    origin: edgeHosted
      ? { status: "edge-hosted" }
      : hosting
        ? { status: "identified", id: hosting.id, name: hosting.name ?? hosting.id }
        : { status: "unknown" },
    ...(others.size > 0 ? { alsoMatched: [...others.values()] } : {}),
  };
}

/**
 * Builds the report's host section from a resolved probe. The country is looked up offline for the first
 * address; it is omitted when the database has none. With a detected edge in front (from any of the three
 * sources), the country is labelled `edge`: the address is the edge network's, so it says nothing about where the origin is hosted.
 */
export async function buildReportHost(
  probe: HostProbe,
  technologies: ReadonlyArray<TechInput> | undefined,
): Promise<ReportHost | undefined> {
  const address = probe.ipv4[0] ?? probe.ipv6[0];
  if (!address) return undefined;
  const host: ReportHost = {
    host: probe.host,
    addresses: { ipv4: probe.ipv4, ipv6: probe.ipv6 },
  };
  if (probe.latency) host.latency = probe.latency;
  const edge = detectEdge([...probe.ipv4, ...probe.ipv6], technologies);
  if (edge) host.edge = edge;
  const code = await lookupCountry(address);
  if (code) {
    host.country = {
      code,
      name: countryName(code),
      location: edge ? "edge" : "origin",
      ...(edge ? { edge: { id: edge.id, name: edge.name } } : {}),
      address,
    };
    host.geoipSnapshot = GEOIP_SNAPSHOT;
  }
  return host;
}
