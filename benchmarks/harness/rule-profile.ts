/**
 * Per-rule cost from a `SQUIRREL_RULE_PROFILE=1` audit's stderr (squirrelscan/repo#1864).
 *
 * Every rule invocation logs one `[rule-profile] {...}` line with unrounded
 * `durationUs`: a page rule with its `pageUrl`, a page-time collector extractor
 * with `scope: "collect"` (security/leaked-secrets' per-page scan runs there),
 * and a site rule with `scope: "site"`. This sums them per rule and divides by
 * the number of pages profiled.
 *
 * Usage: bun rule-profile.ts <audit.err> [--top N]
 *
 * Prints, per page: the page rules, the collector, both together (the page-time
 * rules phase), and the site rules; then the top N rules.
 */

const path = process.argv[2];
if (!path) throw new Error("usage: rule-profile.ts <audit.err> [--top N]");
const topIdx = process.argv.indexOf("--top");
const TOP = topIdx > -1 ? Number(process.argv[topIdx + 1]) : 15;

const perRule = new Map<string, number>();
const pages = new Set<string>();
let pageUs = 0;
let collectUs = 0;
let siteUs = 0;

for (const line of (await Bun.file(path).text()).split("\n")) {
  if (!line.startsWith("[rule-profile] ")) continue;
  const d = JSON.parse(line.slice("[rule-profile] ".length)) as {
    ruleId: string;
    scope?: string;
    pageUrl?: string;
    durationMs: number;
    durationUs?: number;
  };
  const us = d.durationUs ?? d.durationMs * 1000;
  if (d.pageUrl) pages.add(d.pageUrl);
  if (d.scope === "collect") collectUs += us;
  else if (d.scope === "site") siteUs += us;
  else pageUs += us;
  const key = d.scope ? `${d.ruleId} (${d.scope})` : d.ruleId;
  perRule.set(key, (perRule.get(key) ?? 0) + us);
}

const n = pages.size;
if (n === 0) throw new Error(`no [rule-profile] page lines in ${path}: was SQUIRREL_RULE_PROFILE=1 set?`);
const ms = (us: number) => (us / 1000 / n).toFixed(1);
console.log(`pages profiled: ${n}`);
console.log(`page rules ${ms(pageUs)} ms/page, collector ${ms(collectUs)} ms/page, together ${ms(pageUs + collectUs)} ms/page`);
console.log(`site rules ${ms(siteUs)} ms/page (${(siteUs / 1e6).toFixed(1)} s in all)`);
for (const [rule, us] of [...perRule].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
  console.log(`  ${rule.padEnd(48)} ${(us / 1000 / n).toFixed(2).padStart(7)} ms/page`);
}
