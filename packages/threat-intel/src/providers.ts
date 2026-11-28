// Threat-intel providers. Each is optional and behind its own config key (an API
// key or an explicit `enabled` flag). Feed providers daily-pull a blocklist;
// lookup providers answer one URL at a time (memoized per run). All parsing is
// defensive — a provider that errors or changes shape degrades to "no data"
// rather than throwing through the audit.

import type {
  IntelProviderId,
  IntelSource,
} from "@squirrelscan/core-contracts";

import type {
  FeedEntry,
  FeedProvider,
  LookupProvider,
  ProviderConfig,
} from "./types";

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

/** Splits one CSV line, honouring double-quoted fields and `""` escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * abuse.ch URLhaus: recent malicious URL export (CSV). The legacy keyless JSON
 * export was retired, so the key goes in the path. Without a key there is
 * nothing to pull: throw so the provider is skipped, not counted as consulted.
 */
export const urlhausFeed: FeedProvider = {
  id: "urlhaus",
  async fetchFeed(transport, config): Promise<FeedEntry[]> {
    if (!config.apiKey) throw new Error("urlhaus: an abuse.ch key is required");
    const res = await transport(
      `https://urlhaus-api.abuse.ch/v2/files/exports/${encodeURIComponent(config.apiKey)}/recent.csv`
    );
    if (!res.ok) throw new Error(`urlhaus: feed returned HTTP ${res.status}`);
    const text = await res.text();
    // Columns: id, dateadded, url, url_status, last_online, threat, tags,
    // urlhaus_link, reporter. The header is a `#` comment line.
    if (!text.includes("url_status")) {
      throw new Error("urlhaus: unexpected feed format");
    }
    const out: FeedEntry[] = [];
    for (const line of text.split("\n")) {
      const l = line.trim();
      if (!l || l.startsWith("#")) continue;
      const f = splitCsvLine(l);
      const url = f[2];
      if (!url?.startsWith("http")) continue;
      if (f[3] === "offline") continue; // only currently-live threats
      out.push({
        value: url,
        kind: "url",
        threat: f[5] || "malware_download",
        reference: f[7] || undefined,
      });
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
      headers: {
        "content-type": "application/json",
        ...authKeyHeaders(config),
      },
      body: JSON.stringify({ query: "get_iocs", days: 1 }),
    });
    if (!res.ok) throw new Error(`threatfox: feed returned HTTP ${res.status}`);
    const body = asRecord(await res.json().catch(() => ({})));
    if (!Array.isArray(body.data)) {
      throw new Error("threatfox: unexpected response format");
    }
    const out: FeedEntry[] = [];
    for (const row of asArray(body.data)) {
      const rec = asRecord(row);
      const ioc = str(rec.ioc);
      if (!ioc) continue;
      const iocType = str(rec.ioc_type);
      const kind =
        iocType === "url" ? "url" : iocType === "domain" ? "domain" : null;
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
    if (!res.ok) throw new Error(`openphish: feed returned HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes("http"))
      throw new Error("openphish: unexpected feed format");
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
    // The keyless dump is gone (it redirects to a 404), so a key is required.
    const key = config.apiKey;
    if (!key) throw new Error("phishtank: an application key is required");
    const res = await transport(
      `https://data.phishtank.com/data/${encodeURIComponent(key)}/online-valid.json`,
      { headers: { "user-agent": "phishtank/squirrelscan" } }
    );
    if (!res.ok) throw new Error(`phishtank: feed returned HTTP ${res.status}`);
    const parsed: unknown = await res.json();
    if (!Array.isArray(parsed)) {
      throw new Error("phishtank: unexpected response format");
    }
    const rows = parsed;
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
      }
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
    const res = await transport(
      `https://www.virustotal.com/api/v3/urls/${vtUrlId(url)}`,
      {
        headers: { "x-apikey": config.apiKey },
      }
    );
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
