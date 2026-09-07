// Check the fingerprint against real captured bodies (#1899).
//
//   bun run packages/utils/scripts/fingerprint-corpus.ts <dir>
//
// The corpus is 15 bodies of drscholls.com captured from the Workers probe
// vantage over 35 minutes, ~950 KB each. They are NOT committed: 14 MB of
// fixtures in a public repo to prove one hash is a bad trade, and every shape
// they exercise is pinned as a small fixture in
// tests/fingerprint-shopify.test.ts. This script is how the real-world claim is
// re-checked whenever the normalizer changes.
//
// Expected, and what the PR reports:
//   13 bodies of the same page           -> ONE hash
//   2 bodies from before a theme publish -> their own hashes (a real change)

import { normalizeHtmlForFingerprint } from "../src/fingerprint";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: fingerprint-corpus.ts <dir of .html bodies>");
  process.exit(2);
}

const groups = new Map<string, string[]>();
let totalMs = 0;
let count = 0;

for await (const entry of new Bun.Glob("*.html").scan({ cwd: dir, absolute: true })) {
  const html = await Bun.file(entry).text();
  const started = performance.now();
  const normalized = normalizeHtmlForFingerprint(html);
  totalMs += performance.now() - started;
  count++;
  const hash = new Bun.CryptoHasher("sha256").update(normalized).digest("hex").slice(0, 12);
  groups.set(hash, [...(groups.get(hash) ?? []), entry.split("/").pop()!]);
}

console.log(
  `${count} bodies, ${groups.size} distinct hashes, ${(totalMs / count).toFixed(1)} ms each`,
);
for (const [hash, files] of groups) console.log(`  ${hash}  ${files.sort().join(" ")}`);
