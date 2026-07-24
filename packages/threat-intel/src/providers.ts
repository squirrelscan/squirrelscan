// Threat-intel providers. Each is optional and behind its own config key (an API
// key or an explicit `enabled` flag). Feed providers daily-pull a blocklist;
// lookup providers answer one URL at a time (memoized per run). All parsing is
// defensive — a provider that errors or changes shape degrades to "no data"
// rather than throwing through the audit.

import type { IntelProviderId, IntelSource } from "@squirrelscan/core-contracts";

import type { FeedEntry, FeedProvider, LookupProvider, ProviderConfig } from "./types";

// ── helpers ─────────────────────────────────────────────────────────

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** base64url(url) with padding stripped — VirusTotal's URL id scheme. */
function vtUrlId(url: string): string {
  const b64 = btoa(unescape(encodeURIComponent(url)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── feed providers (daily-pull blocklists) ──────────────────────────

/** abuse.ch URLhaus — recent malicious URL feed (JSON). */
export const urlhausFeed: FeedProvider = {
  id: "urlhaus",
  async fetchFeed(transport, config): Promise<FeedEntry[]> {
    const res = await transport("https://urlhaus.abuse.ch/downloads/json_recent/", {
      headers: authKeyHeaders(config),
    });
    if (!res.ok) return [];
    const body = asRecord(await res.json().catch(() => ({})));
    const out: FeedEntry[] = [];
    for (const group of Object.values(body)) {
      for (const row of asArray(group)) {
        const rec = asRecord(row);
        const url = str(rec.url);
        if (!url) continue;
        if (rec.url_status === "offline") continue; // only currently-live threats
        out.push({
          value: url,
          kind: "url",
          threat: str(rec.threat) ?? "malware_download",
          reference: str(rec.urlhaus_reference),
        });
      }
    }
    return out;
  },
};

/** abuse.ch ThreatFox — recent IOCs (URLs + domains). */
export const threatfoxFeed: FeedProvider = {
  id: "threatfox",
  async fetchFeed(transport, config): Promise<FeedEntry[]> {
    const res = await transport("https://threatfox-api.abuse.ch/api/v1/", {
      method: "POST",
      headers: { "content-type": "application/json", ...authKeyHeaders(config) },
      body: JSON.stringify({ query: "get_iocs", days: 1 }),
    });
    if (!res.ok) return [];
    const body = asRecord(await res.json().catch(() => ({})));
    const out: FeedEntry[] = [];
    for (const row of asArray(body.data)) {
      const rec = asRecord(row);
      const ioc = str(rec.ioc);
      if (!ioc) continue;
      const iocType = str(rec.ioc_type);
      const kind = iocType === "url" ? "url" : iocType === "domain" ? "domain" : null;
      if (!kind) continue; // skip ip:port / hash IOCs
      out.push({
        value: ioc,
        kind,
        threat: str(rec.threat_type) ?? "malware",
        reference: str(rec.id) ? `threatfox:${rec.id}` : undefined,
      });
    }
    return out;
  },
};

/** OpenPhish community feed — newline-delimited phishing URLs. */
export const openphishFeed: FeedProvider = {
  id: "openphish",
  async fetchFeed(transport): Promise<FeedEntry[]> {
    const res = await transport("https://openphish.com/feed.txt");
    if (!res.ok) return [];
    const text = await res.text().catch(() => "");
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("http"))
      .map((url) => ({ value: url, kind: "url", threat: "phishing" }));
  },
};

/** PhishTank — verified online phishing URLs (JSON). */
export const phishtankFeed: FeedProvider = {
  id: "phishtank",
  async fetchFeed(transport, config): Promise<FeedEntry[]> {
    const key = config.apiKey;
    const url = key
      ? `https://data.phishtank.com/data/${key}/online-valid.json`
      : "https://data.phishtank.com/data/online-valid.json";
    const res = await transport(url, {
      headers: { "user-agent": "phishtank/squirrelscan" },
    });
    if (!res.ok) return [];
    const rows = asArray(await res.json().catch(() => []));
    const out: FeedEntry[] = [];
    for (const row of rows) {
      const rec = asRecord(row);
      const u = str(rec.url);
      if (!u) continue;
      out.push({
        value: u,
        kind: "url",
        threat: "phishing",
        reference: str(rec.phish_detail_url),
      });
    }
    return out;
  },
};

function authKeyHeaders(config: ProviderConfig): Record<string, string> {
  return config.apiKey ? { "Auth-Key": config.apiKey } : {};
}

// ── lookup providers (on-demand, memoized) ──────────────────────────

/** Google Safe Browsing v4 threatMatches lookup. */
export const safeBrowsingLookup: LookupProvider = {
  id: "safe-browsing",
  async lookup(url, transport, config): Promise<IntelSource[]> {
    if (!config.apiKey) return [];
    const res = await transport(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(config.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "squirrelscan", clientVersion: "1.0" },
          threatInfo: {
            threatTypes: [
              "MALWARE",
              "SOCIAL_ENGINEERING",
              "UNWANTED_SOFTWARE",
              "POTENTIALLY_HARMFUL_APPLICATION",
            ],
            platformTypes: ["ANY_PLATFORM"],
            threatEntryTypes: ["URL"],
            threatEntries: [{ url }],
          },
        }),
      },
    );
    if (!res.ok) return [];
    const body = asRecord(await res.json().catch(() => ({})));
    return asArray(body.matches).map((m) => {
      const rec = asRecord(m);
      return {
        provider: "safe-browsing" as IntelProviderId,
        matched: "url" as const,
        threat: str(rec.threatType) ?? "malware",
      } satisfies IntelSource;
    });
  },
};

/** urlscan.io search — flagged when a prior scan rendered a malicious verdict. */
export const urlscanLookup: LookupProvider = {
  id: "urlscan",
  async lookup(url, transport, config): Promise<IntelSource[]> {
    const q = `task.url:%22${encodeURIComponent(url)}%22%20AND%20verdicts.overall.malicious:true`;
    const res = await transport(`https://urlscan.io/api/v1/search/?q=${q}`, {
      headers: config.apiKey ? { "API-Key": config.apiKey } : {},
    });
    if (!res.ok) return [];
    const body = asRecord(await res.json().catch(() => ({})));
    const results = asArray(body.results);
    if (results.length === 0) return [];
    const first = asRecord(results[0]);
    return [
      {
        provider: "urlscan",
        matched: "url",
        threat: "phishing",
        reference: str(first.result),
      },
    ];
  },
};

/** VirusTotal v3 — flagged when any engine scores the URL malicious. */
export const virustotalLookup: LookupProvider = {
  id: "virustotal",
  async lookup(url, transport, config): Promise<IntelSource[]> {
    if (!config.apiKey) return [];
    const res = await transport(`https://www.virustotal.com/api/v3/urls/${vtUrlId(url)}`, {
      headers: { "x-apikey": config.apiKey },
    });
    if (!res.ok) return []; // 404 = never scanned → unknown, not clean
    const body = asRecord(await res.json().catch(() => ({})));
    const attrs = asRecord(asRecord(body.data).attributes);
    const stats = asRecord(attrs.last_analysis_stats);
    const malicious = Number(stats.malicious ?? 0);
    const suspicious = Number(stats.suspicious ?? 0);
    if (malicious + suspicious <= 0) return [];
    return [
      {
        provider: "virustotal",
        matched: "url",
        threat: malicious > 0 ? "malicious" : "suspicious",
        reference: `vt:${malicious}/${malicious + suspicious}`,
      },
    ];
  },
};

// ── registries ──────────────────────────────────────────────────────

export const FEED_PROVIDERS: FeedProvider[] = [
  urlhausFeed,
  threatfoxFeed,
  openphishFeed,
  phishtankFeed,
];

export const LOOKUP_PROVIDERS: LookupProvider[] = [
  safeBrowsingLookup,
  urlscanLookup,
  virustotalLookup,
];

/** True when a provider is configured to run (explicit enable or an API key). */
export function isProviderEnabled(config: ProviderConfig | undefined): boolean {
  if (!config) return false;
  return config.enabled === true || (config.apiKey?.length ?? 0) > 0;
}
