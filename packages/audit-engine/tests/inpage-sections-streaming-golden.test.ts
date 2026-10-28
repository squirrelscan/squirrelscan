// eeat/about-page + eeat/contact-page + crawl/single-page-site on a one-page site,
// through the STREAMING engine (#1236).
//
// #1208 matched in-page sections from `ctx.site.pages[].parsed.document`, which the
// streaming engine (the path the CLI and the cloud run) does not hand to site rules:
// page DOMs are gone by the site pass. The unit tests built SiteData with documents,
// so they passed while a real audit still said "No About page found". These tests run
// the fixture through runStreamingRules over a stored crawl, and through v1, and
// require both to judge the same. Matched by the Engine Golden Gates CI glob.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CheckResult, PreFetchedAssets } from "@squirrelscan/audit-engine";

import { runStreamingRules } from "@squirrelscan/audit-engine";
import { parsePage } from "@squirrelscan/parser";
import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";

import { getGoldenBaselineConfig, run, runV1Pipeline } from "./helpers/golden-baseline";

const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-inpage-sections-"));
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

const NAV = `<nav><a href="#about">About</a> <a href="#services">Services</a> <a href="#contact">Contact</a></nav>`;
const SERVICES = `<section id="services"><h2>Services</h2><p>We do things.</p></section>`;
const CONTACT = `<section id="contact"><h2>Talk to us</h2><a href="mailto:hello@example.com">Email us</a></section>`;
const page = (about: string, nav = NAV, contact = CONTACT) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>One page fixture site</title><meta name="description" content="A one page site with about and contact sections for testing."></head><body>${nav}<main>${SERVICES}${about}${contact}</main></body></html>`;

const FIXTURE = page(`<section id="about"><h2>Who we are</h2><p>${words(230)}</p></section>`);

type Checks = Map<string, CheckResult[]>;

/** One-page crawl with `html` as its body, judged by the streaming engine and by v1. */
async function judge(name: string, html: string): Promise<{ streaming: Checks; v1: Checks }> {
  const model = generateSiteModel({
    seed: `inpage-${name}`,
    pageCount: 1,
    templateCount: 1,
    minPageSizeBytes: 1_000,
    maxPageSizeBytes: 2_000,
    cleanRatio: 1,
  });
  const dbPath = join(tmpDir, `${name}.sqlite`);
  const { storage, crawlId } = await writeCrawlToStorage(model, dbPath);
  try {
    const [record] = await run(storage.getPages(crawlId));
    const { document: _doc, ...parsed } = parsePage(html, record!.finalUrl ?? record!.url);
    await run(
      storage.upsertPage(crawlId, { ...record!, html, parsedData: JSON.stringify(parsed) }),
    );

    const config = getGoldenBaselineConfig();
    const checksOf = (map: Map<string, { checks: CheckResult[] }>): Checks =>
      new Map([...map].map(([id, r]) => [id, r.checks]));

    const streaming = await run(runStreamingRules(storage, crawlId, config, ASSETS));
    const v1 = await runV1Pipeline(storage, crawlId, config);
    return {
      streaming: checksOf(streaming.ruleResultsMap),
      v1: checksOf(v1.ruleResults.ruleResultsMap),
    };
  } finally {
    await run(storage.close());
  }
}

const check = (checks: Checks, ruleId: string, name: string) =>
  checks.get(ruleId)?.find((c) => c.name === name);

describe("in-page About and Contact sections through the streaming engine (#1236)", () => {
  test(
    "the reporter's fixture passes both rules, on the streaming engine and v1",
    async () => {
      const { streaming, v1 } = await judge("fixture", FIXTURE);
      for (const checks of [streaming, v1]) {
        const about = check(checks, "eeat/about-page", "about-page");
        expect(about?.status).toBe("pass");
        expect(about?.message).toBe("About section found on the homepage (#about)");
        const contact = check(checks, "eeat/contact-page", "contact-page");
        expect(contact?.status).toBe("pass");
        expect(contact?.message).toBe("Contact section found on the homepage (#contact)");
      }
    },
    180_000,
  );

  test(
    "a thin About section reports info, not warn",
    async () => {
      const thin = page(`<section id="about"><h2>Who we are</h2><p>${words(40)}</p></section>`);
      const { streaming, v1 } = await judge("thin", thin);
      for (const checks of [streaming, v1]) {
        expect(check(checks, "eeat/about-page", "about-page")?.status).toBe("info");
      }
    },
    180_000,
  );

  test(
    "an id with no fragment link pointing at it is not a section",
    async () => {
      const stray = page(
        `<section id="about"><h2>Who we are</h2><p>${words(230)}</p></section>`,
        `<nav><a href="#services">Services</a> <a href="#contact">Contact</a></nav>`,
      );
      const { streaming, v1 } = await judge("stray", stray);
      for (const checks of [streaming, v1]) {
        expect(check(checks, "eeat/about-page", "about-page")?.status).toBe("warn");
      }
    },
    180_000,
  );

  test(
    "crawl/single-page-site fires on the same fixture on both engines",
    async () => {
      const { streaming, v1 } = await judge("single", FIXTURE);
      for (const checks of [streaming, v1]) {
        const found = check(checks, "crawl/single-page-site", "single-page-site");
        expect(found?.status).toBe("info");
        expect(found?.details).toEqual({ sections: 3 });
      }
    },
    180_000,
  );
});
