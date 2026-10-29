import type { ReportTechnologies, ReportTechnology } from "@squirrelscan/core-contracts";
import { detectTechnologies, type DetectedTechnology } from "@squirrelscan/tech-detect";
import { recordToHeaders } from "@squirrelscan/utils/headers";
import { detectWaf, getWafProviderName } from "@squirrelscan/waf-detect";

/** Cross-scan diff returned by the cloud tech-detect gate (absent for local). */
export interface TechScanDiff {
  added: string[];
  removed: string[];
  firstScan: boolean;
  advisories?: ReportTechnologies["advisories"];
}

export function buildReportTechnologies(
  technologies: DetectedTechnology[],
  diff?: TechScanDiff,
): ReportTechnologies {
  return {
    items: technologies.map((technology) => ({
      ...technology,
      category: technology.category as ReportTechnology["category"],
    })),
    added: diff?.added ?? [],
    removed: diff?.removed ?? [],
    firstScan: diff?.firstScan ?? false,
    ...(diff?.advisories?.length ? { advisories: diff.advisories } : {}),
  };
}

/**
 * The fingerprint that already reports each WAF provider, so a provider is one
 * technology and not a `waf-<provider>` twin beside it (#1253).
 */
const WAF_FINGERPRINT_IDS: Readonly<Record<string, string>> = {
  datadome: "datadome",
  imperva: "imperva-incapsula",
  kasada: "kasada",
  perimeterx: "human-perimeterx",
  sucuri: "sucuri-firewall",
};

export function withWafTech(
  technologies: DetectedTechnology[],
  headers: Record<string, string>,
  html: string,
): DetectedTechnology[] {
  const waf = detectWaf(recordToHeaders(headers), html);
  if (!waf.detected || !waf.provider) return technologies;
  const id = `waf-${waf.provider}`;
  const twin = WAF_FINGERPRINT_IDS[waf.provider];
  if (technologies.some((technology) => technology.id === id || technology.id === twin)) {
    return technologies;
  }
  return [
    ...technologies,
    {
      id,
      name: getWafProviderName(waf.provider),
      category: "security",
      version: null,
      confidence: waf.confidence,
      detectedBy: "waf-detect",
    },
  ];
}

const BOTID_ID = "vercel-botid";

/**
 * Vercel BotID is Kasada's client served from a Vercel site, so a page that
 * carries the Kasada client AND Vercel's own `x-vercel-id` header is reported as
 * BotID instead of Kasada (#1253). Either way it is a technology: the page it
 * guards is ordinary content, and only a challenge response is a block.
 */
export function withVercelBotId(
  technologies: DetectedTechnology[],
  pageHeaders: ReadonlyArray<Record<string, string>>,
): DetectedTechnology[] {
  const kasada = technologies.find((t) => t.id === "kasada" || t.id === "waf-kasada");
  if (!kasada) return technologies;
  const onVercel = pageHeaders.some((headers) =>
    Object.keys(headers).some((name) => name.toLowerCase() === "x-vercel-id"),
  );
  if (!onVercel) return technologies;
  return [
    ...technologies.filter((t) => t.id !== "kasada" && t.id !== "waf-kasada"),
    {
      ...kasada,
      id: BOTID_ID,
      name: "Vercel BotID",
      icon: "vercel",
    },
  ];
}

export interface LocalTechInput {
  url: string;
  headers: Record<string, string>;
  html: string;
  scripts: { url: string; content?: string }[];
}

const TECH_CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

export function detectReportTechnologiesMulti(
  pages: LocalTechInput[],
  diff?: TechScanDiff,
): ReportTechnologies {
  const byId = new Map<string, DetectedTechnology>();
  for (const page of pages) {
    for (const technology of detectTechnologies(page)) {
      const previous = byId.get(technology.id);
      const better =
        !previous ||
        (!previous.version && !!technology.version) ||
        (!!previous.version === !!technology.version &&
          TECH_CONFIDENCE_RANK[technology.confidence] > TECH_CONFIDENCE_RANK[previous.confidence]);
      if (better) byId.set(technology.id, technology);
    }
  }
  const home = pages[0];
  const technologies = home
    ? withVercelBotId(
        withWafTech([...byId.values()], home.headers, home.html),
        pages.map((page) => page.headers),
      )
    : [...byId.values()];
  return buildReportTechnologies(technologies, diff);
}

export function detectReportTechnologies(
  input: LocalTechInput,
  diff?: TechScanDiff,
): ReportTechnologies {
  return detectReportTechnologiesMulti([input], diff);
}
