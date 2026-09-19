#!/usr/bin/env bun
/**
 * Build a small, private, fresh-render queue from public audit metadata.
 * It deliberately reads no crawl database or page body. Each output row is
 * accepted by render-queue.ts: {url, corpusRef}.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type Target = { url?: unknown; votes?: unknown };
type Candidate = { url: string; host: string; hint: string };

const HOME_LIMIT = 100;
const INNER_LIMIT = 100;
const blockedPath = /(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|register|auth|oauth|account|checkout|cart|password|reset-password)(?:\/|$)/i;
const filePath = /\.(?:pdf|zip|rar|7z|dmg|exe|msi|apk|csv|xlsx?|docx?|pptx?)$/i;

function usage() {
  return "Usage: bun quick-queue.ts --campaign /private/campaign --output /private/queue-fast.jsonl";
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(usage());
  return resolve(value);
}

function privateHost(host: string) {
  const value = host.toLowerCase().replace(/\.$/, "");
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local")) return true;
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function normalized(raw: unknown, allowRoot = true) {
  if (typeof raw !== "string" || raw.length > 2_048) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || privateHost(url.hostname)) return null;
  url.hash = ""; url.search = "";
  if (filePath.test(url.pathname) || blockedPath.test(url.pathname)) return null;
  if (!allowRoot && (url.pathname === "/" || url.pathname === "")) return null;
  return url;
}

function hintFor(path: string) {
  const value = path.toLowerCase();
  if (/\/(?:pricing|plans?)(?:\/|$)/.test(value)) return "pricing";
  if (/\/(?:blog|posts?)(?:\/|$)/.test(value)) return /\/(?:blog|posts?)\/$/.test(value) ? "blog_index" : "blog_post";
  if (/\/(?:news|press)(?:\/|$)/.test(value)) return "news";
  if (/\/(?:docs?|guides?|learn|help)(?:\/|$)/.test(value)) return "docs";
  if (/\/(?:api|reference)(?:\/|$)/.test(value)) return "api_reference";
  if (/\/(?:product|products|features|solutions?|services?|use-cases?)(?:\/|$)/.test(value)) return "product";
  if (/\/(?:about|team|company|contact|careers?)(?:\/|$)/.test(value)) return "company";
  if (/\/(?:integrations?|partners?)(?:\/|$)/.test(value)) return "integrations";
  if (/\/(?:faq|support|status|changelog|legal|privacy|terms)(?:\/|$)/.test(value)) return "support_or_legal";
  return "other_inner";
}

function pushUrl(value: unknown, into: Map<string, Candidate>) {
  const url = normalized(value, false);
  if (!url) return;
  const href = url.href;
  into.set(href, { url: href, host: url.hostname.toLowerCase(), hint: hintFor(url.pathname) });
}

function collectUrls(value: unknown, into: Map<string, Candidate>) {
  if (typeof value === "string") { pushUrl(value, into); return; }
  if (Array.isArray(value)) { for (const item of value) collectUrls(item, into); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:affectedPages|sourcePages|pages|url|baseUrl)$/i.test(key)) collectUrls(child, into);
  }
}

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

function chooseHomes(targets: Target[]) {
  const byHost = new Map<string, { url: string; votes: number }>();
  for (const target of targets) {
    const source = normalized(target.url);
    if (!source) continue;
    const url = new URL("/", source).href;
    const votes = typeof target.votes === "number" && Number.isFinite(target.votes) ? target.votes : 0;
    const current = byHost.get(source.hostname.toLowerCase());
    if (!current || votes > current.votes || (votes === current.votes && url < current.url)) byHost.set(source.hostname.toLowerCase(), { url, votes });
  }
  return [...byHost.values()].sort((a, b) => b.votes - a.votes || a.url.localeCompare(b.url)).slice(0, HOME_LIMIT).map((item) => item.url);
}

function chooseInner(candidates: Candidate[]) {
  const buckets = new Map<string, Candidate[]>();
  for (const candidate of candidates) buckets.set(candidate.hint, [...(buckets.get(candidate.hint) || []), candidate]);
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.host.localeCompare(b.host) || a.url.localeCompare(b.url));
  const selected: Candidate[] = [], seenHosts = new Set<string>(), used = new Set<string>();
  const hints = [...buckets.keys()].sort();
  while (selected.length < INNER_LIMIT) {
    let added = false;
    for (const hint of hints) {
      const candidate = buckets.get(hint)?.find((item) => !used.has(item.url) && !seenHosts.has(item.host));
      if (!candidate) continue;
      selected.push(candidate); used.add(candidate.url); seenHosts.add(candidate.host); added = true;
      if (selected.length === INNER_LIMIT) break;
    }
    if (!added) break;
  }
  for (const hint of hints) for (const candidate of buckets.get(hint) || []) {
    if (selected.length === INNER_LIMIT) break;
    if (!used.has(candidate.url)) { selected.push(candidate); used.add(candidate.url); }
  }
  return selected;
}

function main() {
  const campaign = argument("--campaign"), output = argument("--output");
  const targetsPath = join(campaign, "data", "month-targets.json");
  const reports = join(campaign, "reports-local");
  const targets = JSON.parse(readFileSync(targetsPath, "utf8")) as Target[];
  if (!Array.isArray(targets) || !existsSync(reports)) throw new Error("Campaign metadata is unavailable");
  const homes = chooseHomes(targets);
  const inner = new Map<string, Candidate>();
  for (const file of readdirSync(reports).filter((name) => name.endsWith(".json")).sort()) {
    try { collectUrls(JSON.parse(readFileSync(join(reports, file), "utf8")), inner); } catch { /* a malformed report cannot contribute a candidate */ }
  }
  const selectedInner = chooseInner([...inner.values()]);
  if (homes.length !== HOME_LIMIT || selectedInner.length !== INNER_LIMIT) throw new Error("Insufficient safe, distinct candidates for a 200-page queue");
  const urls = [...homes, ...selectedInner.map((candidate) => candidate.url)];
  if (new Set(urls).size !== 200) throw new Error("Queue contains duplicate URLs");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const lines = urls.map((url) => JSON.stringify({ url, corpusRef: `fast:${hash(url).slice(0, 24)}` }));
  writeFileSync(output, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  const hints = Object.fromEntries([...new Map<string, number>(selectedInner.map((item) => [item.hint, selectedInner.filter((other) => other.hint === item.hint).length])).entries()].sort());
  const summary = { source: "public audit metadata only; URLs are fresh-capture candidates, not historical DOM evidence", homes: homes.length, inner: selectedInner.length, uniqueDomains: new Set(urls.map((url) => new URL(url).hostname)).size, innerHintCounts: hints, manifest: basename(output) };
  writeFileSync(join(dirname(output), "queue-fast-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify(summary));
}

if (import.meta.main) main();
