// #1570: a page whose markup could not be parsed is audited as an empty document. Rules that read the markup are not evaluated on it
// (a skipped check, never a finding), `crawl/html-size` still warns `html-parse`, and the rules that judge only the response still run.

import { describe, expect, test } from "bun:test";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolutionRuleKey, resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";
import { parsePage } from "@squirrelscan/parser";
import { normalizeUrl } from "@squirrelscan/utils/url";

import { loadAllRules } from "../src/loader";
import { buildResolutionSignal } from "../src/resolution";
import { RUNS_ON_UNREAD_PAGE, RuleRunner, UNREAD_PAGE_SKIP_REASON, type RulesConfig } from "../src/runner";
import type { PageData } from "../src/types";

const URL_ = "https://example.com/unread";
const NOTICE = "the page could not be read (boom), so it was audited empty";
const DOM_RULES = ["core/meta-title", "core/meta-description", "core/h1", "a11y/valid-lang", "mobile/viewport", "content/word-count", "a11y/landmark-one-main"];
const RESPONSE_RULES = ["crawl/html-size", "security/https"];

async function run(html: string, notices: string[] | undefined) {
  const config: RulesConfig = { rule_options: {}, rules: { enable: [...DOM_RULES, ...RESPONSE_RULES] } };
  const parsed = parsePage("<!doctype html><html><head></head><body></body></html>", URL_);
  if (notices) parsed.parseNotices = notices;
  const page: PageData = { url: URL_, html, statusCode: 200, loadTime: 0, headers: {}, parsed };
  const { ruleResults } = await new RuleRunner({ config }).runPageRules(page);
  return (id: string) => ruleResults.get(id)?.checks ?? [];
}

describe("a page audited as an empty document reports no missing-markup findings (#1570)", () => {
  test("every markup rule is skipped as not evaluated, none fails or warns", async () => {
    const checks = await run("<html><body><h1>Real</h1></body></html>", [NOTICE]);
    for (const id of DOM_RULES) {
      const own = checks(id);
      expect([id, own.length > 0]).toEqual([id, true]);
      for (const check of own) expect([id, check.status, check.skipReason]).toEqual([id, "skipped", UNREAD_PAGE_SKIP_REASON]);
    }
  });

  test("crawl/html-size still warns html-parse, and the response rules still run", async () => {
    const checks = await run("<html><body></body></html>", [NOTICE]);
    expect(checks("crawl/html-size").find((c) => c.name === "html-parse")?.status).toBe("warn");
    expect(checks("security/https").some((c) => c.status === "skipped" && c.skipReason === UNREAD_PAGE_SKIP_REASON)).toBe(false);
  });

  test("control: an empty document that was NOT a failed parse still reports the missing markup", async () => {
    const checks = await run("<html><body></body></html>", undefined);
    expect(checks("core/meta-title").some((c) => c.status === "fail" || c.status === "warn")).toBe(true);
    expect(checks("core/h1").some((c) => c.status === "fail" || c.status === "warn")).toBe(true);
  });

  test("control: a cut class attribute (page read in full otherwise) is not an unread page", async () => {
    const checks = await run("<html><body></body></html>", ["a class attribute of 640,000 tokens was cut to the first 20,000 to read the page"]);
    expect(checks("core/h1").some((c) => c.status === "skipped" && c.skipReason === UNREAD_PAGE_SKIP_REASON)).toBe(false);
  });
});

// Every page rule is classified: it either reads the parsed markup (and is skipped on an unread page) or it does not (and is in
// RUNS_ON_UNREAD_PAGE). A new rule that reads no parsed field and is not listed fails here, so a response-only rule is never skipped
// by default. Reading is judged from the rule's source: a code line (not a comment, string contents ignored) that names `parsed`.
const SRC = join(import.meta.dir, "../src");
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith(".ts") ? [path] : [];
  });
const readsParsed = (text: string): boolean =>
  text.split("\n").some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /\bparsed\b/.test(line.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, "")));
// Rules whose source reads parsed fields but that still run: the raw HTML is what they judge.
// Rules that hand `ctx` to a helper, checked by hand: none of the helpers read the parse.
const HELPER_CHECKED = new Set<string>();
// Rules that read only the cloud results, but the cloud payload is built from the parsed page (title, text, headings), so an unread
// page would be scored as an empty document (and cost credits): skipped, and the payload builders leave the page out.
const CLOUD_FED = new Set(["ai/llm-parsability", "eeat/authority-signals"]);
const READS_PARSED_BUT_RUNS = new Set(["crawl/html-size", "integrity/kit-signature"]);

describe("every page rule is classified for an unread page (#1570)", () => {
  const files = new Map<string, string>();
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bmeta:\s*\{\s*id: "([a-z0-9-]+\/[a-z0-9-]+)"/g)) if (!files.has(m[1]!)) files.set(m[1]!, text);
  }
  const pageRules = [...loadAllRules({ includeOptIn: true }).values()].filter((r) => r.meta.scope === "page").map((r) => r.meta.id);

  test("a page rule that reads no parsed field is in RUNS_ON_UNREAD_PAGE, one that does is not", () => {
    expect(pageRules.length).toBeGreaterThan(150);
    const wrong: string[] = [];
    for (const id of pageRules) {
      const text = files.get(id);
      if (text === undefined) {
        wrong.push(`${id}: source not found`);
        continue;
      }
      // A read the scan cannot see: bracket access, or the whole `ctx` handed to a helper (which may read the parse). Check by hand.
      const reads0 = readsParsed(text);
      if (!reads0 && RUNS_ON_UNREAD_PAGE.has(id) && (/ctx\[\s*["'`]parsed/.test(text) || /\b\w+\(\s*ctx\s*[,)]/.test(text))) {
        if (!HELPER_CHECKED.has(id)) wrong.push(`${id}: uses bracket access or hands ctx to a helper; check the helper's reads by hand before classifying`);
      }
      const runs = RUNS_ON_UNREAD_PAGE.has(id);
      const reads = readsParsed(text);
      if (reads && runs && !READS_PARSED_BUT_RUNS.has(id)) wrong.push(`${id}: reads parsed fields but runs on an unread page`);
      if (!reads && !runs && !CLOUD_FED.has(id)) wrong.push(`${id}: reads no parsed field but is skipped on an unread page (add it to RUNS_ON_UNREAD_PAGE)`);
    }
    expect(wrong).toEqual([]);
  });

  test("every listed rule is a real page rule", () => {
    for (const id of RUNS_ON_UNREAD_PAGE) expect([id, pageRules.includes(id)]).toEqual([id, true]);
  });
});

describe("an unread page never resolves a prior finding (#1570)", () => {
  test("the skip lands in the rule-wide notEvaluated key of its page, so a prior finding carries", () => {
    const ruleId = "core/meta-title";
    const unread = "https://x.test/unread";
    const read = "https://x.test/read";
    const signal = buildResolutionSignal(
      {
        [ruleId]: {
          checks: [
            { name: ruleId, status: "skipped", message: "Not evaluated", pageUrl: unread, skipReason: UNREAD_PAGE_SKIP_REASON, details: { foldKey: UNREAD_PAGE_SKIP_REASON } },
            { name: "meta-title", status: "pass", message: "ok", pageUrl: read },
          ],
        },
      },
      [unread, read],
    )!;
    const hash = (url: string) => resolutionUrlHash(normalizeUrl(url));
    expect(signal.notEvaluated?.[resolutionRuleKey(ruleId)]).toContain(hash(unread));
    expect(signal.notEvaluated?.[resolutionRuleKey(ruleId)]).not.toContain(hash(read));
  });
});
