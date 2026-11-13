// Refreshes the bundled edge-provider data used by #1807 edge detection. Usage:
//   bun run scripts/refresh-edge-data.ts
// This is the ONLY place that touches the network; the CLI never does at runtime. It downloads
//   - the official provider range files (Cloudflare, AWS CloudFront service only, Fastly, Google Cloud,
//     Microsoft AzureFrontDoor.Frontend service tag only), and
//   - the DB-IP "IP to ASN Lite" CSV (CC BY 4.0, https://db-ip.com), reduced to an explicit allow-list of
//     edge-specific ASNs,
// then rewrites packages/utils/geoip-db/{edge-ranges.json,edge-asn.json} and the `edge` block of
// SNAPSHOT.json with the fetch date and the sha256 of every file fetched. Downloads are parsed as data only.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const DIR = join(import.meta.dir, "..", "packages", "utils", "geoip-db");
const UA = "squirrelscan-edge-data-refresh (https://github.com/squirrelscan/squirrelscan)";

/** Edge-specific ASNs only. Shared cloud ASNs (AWS 16509/14618, Azure 8075, Google 15169) say nothing about an edge. */
export const EDGE_ASNS: Record<string, { name: string; asns: number[] }> = {
  cloudflare: { name: "Cloudflare", asns: [13335, 209242, 14789, 395747, 132892, 202623, 203898, 139242, 394536, 402542, 400095, 22061] },
  fastly: { name: "Fastly", asns: [54113, 394192] },
  // 63949 is Akamai Connected Cloud (Linode), a hosting product, so it is not listed.
  akamai: { name: "Akamai", asns: [20940, 16625, 36183, 35994, 24319, 32787, 34164, 12222, 21342, 33905, 213120, 200005, 26008, 31108, 17204, 393560, 49846] },
  vercel: { name: "Vercel", asns: [922] },
};

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const fetchedAt = new Date().toISOString().slice(0, 10);

interface Fetched { url: string; sha256: string; bytes: number; note?: string }
const sources: Fetched[] = [];
const track = (url: string, b: Uint8Array, note?: string) => sources.push({ url, sha256: sha(b), bytes: b.length, ...(note ? { note } : {}) });

const cidrRe = /^(?:\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}|[0-9a-fA-F:]+\/\d{1,3})$/;
function checked(list: string[], what: string): string[] {
  const out = new Set<string>();
  for (const c of list) {
    if (!cidrRe.test(c)) throw new Error(`${what}: bad CIDR ${JSON.stringify(c)}`);
    out.add(c.toLowerCase());
  }
  if (out.size === 0) throw new Error(`${what}: no ranges`);
  return [...out];
}

const providers: Record<string, { name: string; broad?: true; service: string; cidrs: string[] }> = {};

// Cloudflare
{
  const u4 = "https://www.cloudflare.com/ips-v4";
  const u6 = "https://www.cloudflare.com/ips-v6";
  const [a, b] = [await fetchBytes(u4), await fetchBytes(u6)];
  track(u4, a);
  track(u6, b);
  providers.cloudflare = {
    name: "Cloudflare",
    service: "cloudflare.com/ips (v4 and v6)",
    cidrs: checked([...text(a).split(/\s+/), ...text(b).split(/\s+/)].filter(Boolean), "cloudflare"),
  };
}
// Amazon CloudFront: only the CLOUDFRONT service (also the _GLOBAL / REGIONAL_EDGE variants are NOT taken).
{
  const url = "https://ip-ranges.amazonaws.com/ip-ranges.json";
  const raw = await fetchBytes(url);
  const j = JSON.parse(text(raw)) as { createDate: string; prefixes: any[]; ipv6_prefixes: any[] };
  track(url, raw, `createDate ${j.createDate}`);
  providers.cloudfront = {
    name: "Amazon CloudFront",
    service: "CLOUDFRONT",
    cidrs: checked(
      [
        ...j.prefixes.filter((p) => p.service === "CLOUDFRONT").map((p) => p.ip_prefix),
        ...j.ipv6_prefixes.filter((p) => p.service === "CLOUDFRONT").map((p) => p.ipv6_prefix),
      ],
      "cloudfront",
    ),
  };
}
// Fastly
{
  const url = "https://api.fastly.com/public-ip-list";
  const raw = await fetchBytes(url);
  const j = JSON.parse(text(raw)) as { addresses: string[]; ipv6_addresses: string[] };
  track(url, raw);
  providers.fastly = { name: "Fastly", service: "public-ip-list", cidrs: checked([...j.addresses, ...j.ipv6_addresses], "fastly") };
}
// Google. cloud.json lists every Google Cloud customer range (Compute Engine, load balancers, Cloud CDN...);
// Google publishes no Cloud CDN-only list, so this provider is marked `broad`.
{
  const url = "https://www.gstatic.com/ipranges/cloud.json";
  const raw = await fetchBytes(url);
  const j = JSON.parse(text(raw)) as { creationTime: string; prefixes: any[] };
  track(url, raw, `creationTime ${j.creationTime}`);
  providers["google-cloud"] = {
    name: "Google Cloud",
    broad: true,
    service: "Google Cloud (cloud.json)",
    cidrs: checked(j.prefixes.map((p) => p.ipv4Prefix ?? p.ipv6Prefix), "google-cloud"),
  };
}
// Microsoft Service Tags: the download link is dated, so it is read from the official download page.
{
  const page = text(await fetchBytes("https://www.microsoft.com/en-us/download/details.aspx?id=56519"));
  const m = /https:\/\/download\.microsoft\.com\/download\/[^"'\s]*ServiceTags_Public_\d+\.json/.exec(page);
  if (!m) throw new Error("Service Tags download link not found");
  const raw = await fetchBytes(m[0]);
  const j = JSON.parse(text(raw)) as { changeNumber: number; values: Array<{ name: string; properties: { addressPrefixes: string[] } }> };
  track(m[0], raw, `changeNumber ${j.changeNumber}`);
  const tag = j.values.find((v) => v.name === "AzureFrontDoor.Frontend");
  if (!tag) throw new Error("AzureFrontDoor.Frontend tag missing");
  providers["azure-front-door"] = {
    name: "Azure Front Door",
    service: "AzureFrontDoor.Frontend",
    cidrs: checked(tag.properties.addressPrefixes, "azure-front-door"),
  };
}

// DB-IP ASN Lite: the download link carries the month, so it is read from the official download page.
const asnPage = "https://db-ip.com/db/download/ip-to-asn-lite";
const asnHtml = text(await fetchBytes(asnPage));
if (!/Creative Commons Attribution 4\.0 International/.test(asnHtml)) throw new Error("DB-IP ASN Lite licence text not found; check the licence before refreshing");
const link = /https:\/\/download\.db-ip\.com\/free\/dbip-asn-lite-(\d{4}-\d{2})\.csv\.gz/.exec(asnHtml);
if (!link) throw new Error("ASN Lite CSV link not found");
const asnRaw = await fetchBytes(link[0]);
track(link[0], asnRaw);
const wanted = new Map<number, string>();
for (const [id, p] of Object.entries(EDGE_ASNS)) for (const a of p.asns) wanted.set(a, id);
const asnRanges: Record<string, Array<[string, string, number]>> = {};
for (const line of text(gunzipSync(asnRaw)).split("\n")) {
  if (!line.trim()) continue;
  // start,end,asn,"org" (org may contain commas inside quotes; only the first three fields are used)
  const [start, end, asn] = line.split(",");
  const id = wanted.get(Number(asn));
  if (!id || !start || !end) continue;
  (asnRanges[id] ??= []).push([start, end, Number(asn)]);
}
for (const id of Object.keys(EDGE_ASNS)) if (!asnRanges[id]?.length) throw new Error(`no ASN Lite ranges for ${id}`);

writeFileSync(join(DIR, "edge-ranges.json"), `${JSON.stringify({ fetchedAt, providers }, null, 1)}\n`);
writeFileSync(
  join(DIR, "edge-asn.json"),
  `${JSON.stringify({ snapshot: link[1], providers: Object.fromEntries(Object.entries(EDGE_ASNS).map(([id, p]) => [id, { name: p.name, asns: p.asns, ranges: asnRanges[id] }])) })}\n`,
);
const snapPath = join(DIR, "SNAPSHOT.json");
const snap = JSON.parse(readFileSync(snapPath, "utf8"));
snap.edge = {
  fetchedAt,
  asn: {
    source: "DB-IP.com IP to ASN Lite",
    sourceUrl: asnPage,
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    snapshot: link[1],
    sourceFile: `dbip-asn-lite-${link[1]}.csv.gz`,
    sourceSha256: sha(asnRaw),
    keptAsns: [...wanted.keys()].length,
  },
  rangeSources: sources.filter((s) => !/(^|\.)db-ip\.com$/.test(new URL(s.url).hostname)).map((s) => ({ ...s, fetchedAt })),
};
writeFileSync(snapPath, `${JSON.stringify(snap, null, 2)}\n`);
console.log(JSON.stringify({ fetchedAt, providers: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, v.cidrs.length])), asn: Object.fromEntries(Object.entries(asnRanges).map(([k, v]) => [k, v.length])) }, null, 1));
