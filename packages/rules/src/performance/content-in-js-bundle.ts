// perf/content-in-js-bundle - Page content shipped in a client JavaScript chunk
// (squirrelscan/squirrelscan#1200)

import { z } from "zod";

import {
  MAX_CHUNK_CHARS,
  buildNeedleIndex,
  estimateProseShare,
  extractContentSentences,
  findNeedles,
  gzipSize,
  normalizeScriptText,
  sentenceNeedle,
} from "../shared/content-in-script";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export const optionsSchema = z.object({
  min_chunk_bytes: z
    .number()
    .default(50 * 1024)
    .describe("Chunks smaller than this are not searched"),
  min_sentences: z
    .number()
    .default(3)
    .describe("Distinctive sentences of a page that must be found in the chunk for the page's content to count as inside it"),
  escalate_other_pages: z
    .number()
    .default(2)
    .describe("Other pages whose content is in the same chunk before the finding is reported as sitewide"),
  max_pages_checked: z
    .number()
    .max(20000)
    .default(2000)
    .describe("Pages searched for per chunk (5 sentences each), so a very large site stays bounded"),
  max_chunks: z
    .number()
    .default(10)
    .describe("Largest chunks searched"),
});

/** Wall-clock budget for the whole search, across chunks. A search that runs out reports what it covered. */
const SEARCH_BUDGET_MS = 2500;

/** A sentence that opens this many pages' main content is site template text, not a page's own. */
const BOILERPLATE_PAGES = 3;

interface ChunkFinding {
  url: string;
  sizeBytes: number;
  gzipBytes?: number;
  proseShare: number;
  /** Pages (among those checked) whose own content is in the chunk. */
  pagesWithContent: string[];
  /** Pages that load the chunk and have their own content in it. */
  loadingPages: string[];
}

export const contentInJsBundleRule: Rule = {
  meta: {
    id: "perf/content-in-js-bundle",
    name: "Page Content Shipped in a JavaScript Bundle",
    description:
      "Flags a same-origin JavaScript chunk that contains the text of the site's pages (compiled MDX or Markdown bodies, inlined CMS JSON), so the content downloads twice",
    solution:
      "Render static content on the server and keep it out of the client bundle. For MDX: compile and render bodies in a server function or loader, import only frontmatter on the client, and use lazy (not eager) globs for bodies. For frameworks with server components, keep content in server components. For CMS JSON, fetch it on the server rather than importing it at build time into client code.",
    category: "perf",
    scope: "site",
    severity: "warning",
    weight: 6,
    optionsSchema,
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const opts = optionsSchema.parse(ctx.options);
    const scripts = ctx.site?.scripts ?? [];

    // Page-time sentences: the streaming engine records them while each DOM is
    // live (collected-signals.ts); v1 reads the live documents.
    const sentencesByPage = new Map<string, string[]>();
    let judged = true;
    // Every page was browser-rendered: no copy to search for, which is not the same as nothing found (#1329).
    let allRendered = false;
    if (ctx.collectedSignals) {
      allRendered = ctx.collectedSignals.pages.length > 0 && ctx.collectedSignals.pages.every((rec) => rec.contentRendered === true);
      judged = !(
        ctx.collectedSignals.pages.length > 0 &&
        ctx.collectedSignals.pages.every((rec) => rec.contentSentences === undefined)
      );
      for (const rec of ctx.collectedSignals.pages) sentencesByPage.set(rec.url, rec.contentSentences ?? []);
    } else {
      const pages = ctx.site?.pages ?? [];
      allRendered = pages.length > 0 && pages.every((page) => page.rendered === true);
      for (const page of pages) {
        const doc = page.parsed?.document;
        // A browser-rendered page has its copy in the script that rendered it, by necessity.
        sentencesByPage.set(page.url, doc && page.rendered !== true ? extractContentSentences(doc) : []);
      }
    }
    if (allRendered) {
      return {
        checks: [
          {
            name: "content-in-js-bundle",
            status: "skipped",
            message:
              "Page content in JavaScript was not checked: every page was browser-rendered, and a rendered page's copy is in the script that rendered it by design. Audit with rendering off (--http) to check it",
          },
        ],
      };
    }
    if (!judged) {
      return {
        checks: [
          {
            name: "content-in-js-bundle",
            status: "skipped",
            message:
              "Page content in JavaScript was not checked: this crawl's page records predate the check. Re-run the audit with --refresh to check it",
          },
        ],
      };
    }

    // Sentences that open many pages' main content are template text.
    const pageCountBySentence = new Map<string, number>();
    for (const sentences of sentencesByPage.values()) {
      for (const sentence of new Set(sentences)) {
        pageCountBySentence.set(sentence, (pageCountBySentence.get(sentence) ?? 0) + 1);
      }
    }
    const needlesByPage = new Map<string, string[]>();
    for (const [url, sentences] of sentencesByPage) {
      const own = sentences
        .filter((s) => (pageCountBySentence.get(s) ?? 0) < BOILERPLATE_PAGES)
        .map(sentenceNeedle)
        .filter((s) => s.length > 0);
      if (own.length >= opts.min_sentences) needlesByPage.set(url, own);
    }

    const candidates = scripts
      .filter((s) => s.content !== null && (s.sizeBytes ?? s.content.length) >= opts.min_chunk_bytes)
      .sort((a, b) => (b.sizeBytes ?? b.content!.length) - (a.sizeBytes ?? a.content!.length));
    const searched = candidates.slice(0, opts.max_chunks);
    const skippedLarge: string[] = [];

    const checkedPages = [...needlesByPage.keys()];
    const findings: ChunkFinding[] = [];
    const deadline = performance.now() + SEARCH_BUDGET_MS;
    let outOfTime = false;
    let verificationCapped = false;
    for (const script of searched) {
      const decoded = normalizeScriptText(script.content!);
      if (decoded === null) {
        skippedLarge.push(script.url);
        continue;
      }
      if (performance.now() > deadline) {
        outOfTime = true;
        break;
      }
      // Let other work run between chunks: decoding and hashing are synchronous.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // The pages that load the chunk first, then an even sample of the rest,
      // up to the page cap; one pass over the chunk finds every page's sentences.
      const loaders = new Set(script.sourcePages);
      const loading = checkedPages.filter((url) => loaders.has(url));
      const others = checkedPages.filter((url) => !loaders.has(url));
      const room = Math.max(0, opts.max_pages_checked - loading.length);
      const step = others.length > room && room > 0 ? others.length / room : 1;
      const sampled: string[] = loading.slice(0, opts.max_pages_checked);
      for (let i = 0; i < others.length && sampled.length < opts.max_pages_checked; i += step) {
        sampled.push(others[Math.floor(i)]!);
      }

      const index = buildNeedleIndex(sampled.flatMap((url) => needlesByPage.get(url)!));
      const search = findNeedles(decoded, index, deadline);
      if (search.truncated) {
        if (performance.now() > deadline) outOfTime = true;
        else verificationCapped = true;
      }
      const pagesWithContent = sampled.filter(
        (url) => needlesByPage.get(url)!.filter((n) => search.found.has(n)).length >= opts.min_sentences,
      );
      const loadingPages = pagesWithContent.filter((url) => loaders.has(url));
      if (loadingPages.length === 0) continue;

      const sizeBytes = script.sizeBytes ?? script.content!.length;
      findings.push({
        url: script.url,
        sizeBytes,
        gzipBytes: await gzipSize(script.content!),
        proseShare: estimateProseShare(decoded),
        pagesWithContent,
        loadingPages,
      });
    }

    const checks: CheckResult[] = [];
    const itemOf = (f: ChunkFinding) => ({
      id: f.url,
      sourcePages: f.loadingPages,
      meta: {
        size: formatBytes(f.sizeBytes),
        sizeBytes: f.sizeBytes,
        ...(f.gzipBytes !== undefined ? { gzipSize: formatBytes(f.gzipBytes), gzipBytes: f.gzipBytes } : {}),
        pagesWithContent: f.pagesWithContent.length,
        otherPagesWithContent: Math.max(0, f.pagesWithContent.length - 1),
        proseShareEstimate: `${Math.round(f.proseShare * 100)}%`,
      },
    });

    const escalated = findings.filter((f) => f.pagesWithContent.length - 1 >= opts.escalate_other_pages);
    const own = findings.filter((f) => !escalated.includes(f));

    if (escalated.length > 0) {
      const worst = escalated[0]!;
      checks.push({
        name: "content-in-js-bundle-sitewide",
        // A warning until the escalation is measured against real sites.
        status: "warn",
        message: `${escalated.length} JS chunk(s) hold the text of several pages: ${worst.url} carries the content of ${worst.pagesWithContent.length} pages (${formatBytes(worst.sizeBytes)}) in every page's bundle`,
        items: escalated.map(itemOf),
        details: { suggestion: "Render the bodies on the server and import only frontmatter on the client" },
      });
    }
    if (own.length > 0) {
      checks.push({
        name: "content-in-js-bundle",
        // One page's copy in a chunk is also what a hard-coded route component looks like
        // (4 of 36 real documentation sites, none of them an MDX bundle): information, not a warning.
        status: "info",
        message: `${own.length} JS chunk(s) contain the page's own content as script`,
        items: own.map(itemOf),
        details: { suggestion: "Render static content on the server and keep it out of the client bundle" },
      });
    }
    if (skippedLarge.length > 0) {
      checks.push({
        name: "content-in-js-bundle-skipped",
        status: "info",
        message: `${skippedLarge.length} JS chunk(s) over ${formatBytes(MAX_CHUNK_CHARS)} were not searched`,
        items: skippedLarge.map((id) => ({ id })),
      });
    }
    if (outOfTime) {
      checks.push({
        name: "content-in-js-bundle-partial",
        status: "info",
        message: `The search stopped after ${SEARCH_BUDGET_MS / 1000} s: later pages and chunks were not searched`,
      });
    }
    if (verificationCapped) {
      checks.push({
        name: "content-in-js-bundle-partial",
        status: "info",
        message: "A chunk repeated the start of the same sentences so often that the search stopped comparing candidates early: its result is a floor",
      });
    }
    // Chunks big enough to matter whose body the audit does not have (not fetched, failed,
    // over the script fetch cap, skipped by a budget): not searched, so never a clean pass.
    const unchecked = scripts.filter(
      (s) => s.content === null && (s.sizeBytes === null || s.sizeBytes >= opts.min_chunk_bytes),
    );
    if (unchecked.length > 0) {
      checks.push({
        name: "content-in-js-bundle-unchecked",
        status: "info",
        message: `${unchecked.length} JS chunk(s) could not be searched (not fetched, failed, or over the script size limit): this audit did not fully check for page content in JavaScript`,
        items: unchecked.slice(0, 20).map((s) => ({ id: s.url })),
      });
    }
    if (findings.length === 0 && unchecked.length === 0 && skippedLarge.length === 0 && !outOfTime && !verificationCapped) {
      checks.push({
        name: "content-in-js-bundle",
        status: "pass",
        message:
          searched.length === 0
            ? "No JavaScript chunk large enough to hold page content"
            : "No page content found inside the JavaScript chunks",
      });
    }
    return { checks };
  },
};
