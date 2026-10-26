// Local preview of the HTML report, for working on the page and its CSS.
//
//   bun run preview <report.json> [more.json ...]
//
//   /          the first report, offline (as the CLI writes it)
//   /?r=2      the second report, and so on
//   /?online   as the cloud renders it (tech icons; ?favicon=<url> for a favicon)
//
// Tailwind is rebuilt on every request, so class edits show on refresh. The
// JSON is an AuditReport, e.g. from `squirrel report --format json`.
import type { AuditReport } from "../src/types";
import { renderHtml } from "../src/output/html";
import { buildCss } from "./build-css";

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error("usage: bun run preview <report.json> [more.json ...]");

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const n = Math.min(Math.max(Number(url.searchParams.get("r") ?? 1) || 1, 1), paths.length);
    const report = (await Bun.file(paths[n - 1]!).json()) as AuditReport;
    const css = await buildCss();
    const html = renderHtml(report, {
      offline: !url.searchParams.has("online"),
      faviconUrl: url.searchParams.get("favicon") ?? undefined,
    }).replace(/<style>.*?<\/style>/s, () => `<style>${css}</style>`);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`preview: ${server.url}`);
