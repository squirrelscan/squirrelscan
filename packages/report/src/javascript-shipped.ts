// "JavaScript shipped" (squirrelscan/repo#3397): one summary line, plus the
// heaviest pages, shared by every format so they all say the same thing.
// Report-only and non-scoring.

import type { AuditReport } from "./types";
import { formatBytes } from "./utils";

type JavascriptShipped = NonNullable<AuditReport["javascript"]>;

/** The block, or undefined when the report has none or it measured nothing. */
export function javascriptShipped(report: Pick<AuditReport, "javascript">): JavascriptShipped | undefined {
  const js = report.javascript;
  return js && js.scripts > 0 && js.bytes > 0 ? js : undefined;
}

/** The framework runtime's share of all measured script bytes, as a whole percent. */
export function javascriptFrameworkPercent(js: JavascriptShipped): number | null {
  if (!js.framework || js.bytes <= 0) return null;
  return Math.round((js.framework.bytes / js.bytes) * 100);
}

/**
 * The parenthesised details: framework runtime, third-party share, unmeasured
 * scripts. `escapeName` escapes the framework name for a format with markup.
 */
export function javascriptShippedDetails(
  js: JavascriptShipped,
  escapeName: (name: string) => string = (name) => name,
): string[] {
  const details: string[] = [];
  const percent = javascriptFrameworkPercent(js);
  if (js.framework && percent !== null) {
    details.push(
      `${escapeName(String(js.framework.name))} runtime ${formatBytes(js.framework.bytes)}, ${percent}%`,
    );
  }
  if (js.thirdPartyBytes > 0) details.push(`third-party ${formatBytes(js.thirdPartyBytes)}`);
  if (js.unmeasured > 0) details.push(`${js.unmeasured} not measured`);
  return details;
}

/**
 * The value, e.g. "1.2 MB across 34 scripts (Next.js runtime 640.0 KB, 52%;
 * third-party 210.0 KB)". Everything but the framework name is a number; a
 * report read back from JSON can carry any name, so a format with markup passes
 * `escapeName` (HTML escapes it by rendering it as text).
 */
export function javascriptShippedSummary(
  js: JavascriptShipped,
  escapeName?: (name: string) => string,
): string {
  const details = javascriptShippedDetails(js, escapeName);
  const scripts = `${js.scripts} script${js.scripts === 1 ? "" : "s"}`;
  return `${formatBytes(js.bytes)} across ${scripts}${
    details.length > 0 ? ` (${details.join("; ")})` : ""
  }`;
}

/** "JavaScript shipped: " and the summary. Null when there is no block. */
export function javascriptShippedLine(report: Pick<AuditReport, "javascript">): string | null {
  const js = javascriptShipped(report);
  return js ? `JavaScript shipped: ${javascriptShippedSummary(js)}` : null;
}

/** A heaviest page's size, e.g. "980.0 KB, 12 scripts". */
export function javascriptPageSize(page: JavascriptShipped["heaviestPages"][number]): string {
  return `${formatBytes(page.bytes)}, ${page.scripts} script${page.scripts === 1 ? "" : "s"}`;
}

/**
 * One heaviest page as plain text, e.g. "https://example.com/a (980.0 KB, 12
 * scripts)". The URL is the site's: a format with markup escapes it itself.
 */
export function javascriptPageLabel(page: JavascriptShipped["heaviestPages"][number]): string {
  return `${page.url} (${javascriptPageSize(page)})`;
}

/** e.g. "Heaviest pages by script: https://example.com/a (980.0 KB, 12 scripts), ...". Null when none. */
export function javascriptHeaviestPagesLine(report: Pick<AuditReport, "javascript">): string | null {
  const js = javascriptShipped(report);
  if (!js || js.heaviestPages.length === 0) return null;
  return `Heaviest pages by script: ${js.heaviestPages.map(javascriptPageLabel).join(", ")}`;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The `<javascript>` element shared by the llm and xml formats, at `depth`
 * levels of two-space indent. Optional attributes appear only when non-zero.
 * Every value off the report is escaped or coerced to a number, since a report
 * can be read back from JSON.
 */
export function javascriptXml(report: Pick<AuditReport, "javascript">, depth: number): string[] {
  const js = javascriptShipped(report);
  if (!js) return [];
  const pad = "  ".repeat(depth);
  const thirdParty =
    js.thirdPartyBytes > 0 ? ` third-party-bytes="${Number(js.thirdPartyBytes)}"` : "";
  const unmeasured = js.unmeasured > 0 ? ` unmeasured="${Number(js.unmeasured)}"` : "";
  const framework = js.framework
    ? ` framework="${escapeXmlAttr(String(js.framework.id))}" framework-bytes="${Number(js.framework.bytes)}"`
    : "";
  const open = `${pad}<javascript bytes="${Number(js.bytes)}" scripts="${Number(js.scripts)}"${thirdParty}${unmeasured}${framework}`;
  if (js.heaviestPages.length === 0) return [`${open}/>`];
  return [
    `${open}>`,
    ...js.heaviestPages.map(
      (page) =>
        `${pad}  <page url="${escapeXmlAttr(String(page.url))}" bytes="${Number(page.bytes)}" scripts="${Number(page.scripts)}"/>`,
    ),
    `${pad}</javascript>`,
  ];
}
