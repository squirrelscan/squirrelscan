// repo#2144: the engine can run the rules that read external-link verdicts
// last, after the link check, and every other rule without waiting on it. That
// is only safe if LINK_VERDICT_RULE_IDS names EVERY rule that reads them: a
// rule left out would run before its verdicts are bound and read "nothing
// checked". This reads each rule's source and fails when one reads
// `site.externalLinks` or `site.externalLinkCheck` (the two fields the link
// check fills) and is missing from the set, or the set names a rule that no
// longer reads them.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { LINK_VERDICT_RULE_IDS } from "../src/link-verdict-rules";

const SRC = join(import.meta.dir, "..", "src");
const READS = /\bsite\??\.(?:externalLinks|externalLinkCheck)\b|\{[^}]*\b(?:externalLinks|externalLinkCheck)\b[^}]*\}\s*=\s*(?:ctx\.)?site\b/;
const RULE_ID = /\bid:\s*"([a-z0-9-]+\/[a-z0-9-]+)"/g;

async function readers(): Promise<{ files: string[]; ids: Set<string> }> {
  const files: string[] = [];
  const ids = new Set<string>();
  for await (const rel of new Bun.Glob("*/**/*.ts").scan(SRC)) {
    if (rel.endsWith(".test.ts")) continue;
    const source = await Bun.file(join(SRC, rel)).text();
    if (!READS.test(source)) continue;
    files.push(rel);
    for (const m of source.matchAll(RULE_ID)) ids.add(m[1]!);
  }
  return { files, ids };
}

describe("LINK_VERDICT_RULE_IDS", () => {
  test("names every rule that reads the external-link verdicts, and nothing else", async () => {
    const { files, ids } = await readers();
    // The scan found the readers at all (a broken pattern would pass vacuously).
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect([...ids].sort()).toEqual([...LINK_VERDICT_RULE_IDS].sort());
  });
});
