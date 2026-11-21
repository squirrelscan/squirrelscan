// Shared fixtures for the grouped-stream tests and bench (squirrelscan/repo#1883).
import type { CheckResult } from "@squirrelscan/core-contracts";

export type FixtureRules = Record<
  string,
  {
    meta: { id: string; severity: string; [k: string]: unknown };
    checks: CheckResult[];
  }
>;

const meta = (id: string, severity = "warning") => ({
  id,
  name: id,
  description: id,
  category: "content" as const,
  scope: "page" as const,
  severity,
  weight: 10,
});

export const pageUrl = (i: number) => `https://x.test/p/${i}`;

/**
 * drscholls-shaped: shared-chrome defects on every page (SRI with a page-varying
 * count in the message, nav link defects), a partial-coverage defect, and a few
 * per-page unique defects. Per-page rows land in the tens of thousands while
 * distinct groups stay in the low thousands.
 */
export function buildDrschollsFixture(pages = 401): FixtureRules {
  const sri: CheckResult[] = [];
  const nav: CheckResult[] = [];
  const title: CheckResult[] = [];
  const unique: CheckResult[] = [];
  const img: CheckResult[] = [];
  for (let i = 0; i < pages; i++) {
    const u = pageUrl(i);
    const count = 20 + (i % 7);
    sri.push({
      name: "sri",
      status: "warn",
      message: `${count} cross-origin resources without Subresource Integrity`,
      value: String(count),
      expected: "0",
      pageUrl: u,
      items: Array.from({ length: count }, (_, k) => ({
        id: `https://cdn.shopify.com/extensions/asset-${k}.js`,
        label: "script",
      })),
    });
    nav.push({
      name: "link-name",
      status: "fail",
      message: "nav links lack discernible text",
      pageUrl: u,
      items: Array.from({ length: 42 }, (_, k) => ({
        id: `nav > a:nth-child(${k})`,
        label: "a",
      })),
    });
    if (i % 3 !== 0) {
      title.push({
        name: "title-length",
        status: "warn",
        message: "Title too long",
        value: String(70 + (i % 5)),
        expected: "60",
        pageUrl: u,
      });
    }
    unique.push({
      name: "broken-image",
      status: "fail",
      message: "images fail to load",
      pageUrl: u,
      items: Array.from({ length: 6 }, (_, k) => ({
        id: `${u}/img-${k}.png`,
        label: "img",
      })),
    });
    img.push({ name: "alt", status: "pass", message: "ok", pageUrl: u });
  }
  return {
    "security/sri": { meta: meta("security/sri"), checks: sri },
    "a11y/link-name": { meta: meta("a11y/link-name", "error"), checks: nav },
    "core/title": { meta: meta("core/title"), checks: title },
    "perf/broken-image": { meta: meta("perf/broken-image"), checks: unique },
    "a11y/alt": { meta: meta("a11y/alt"), checks: img },
  };
}
