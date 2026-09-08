/**
 * Uniform script-heavy synthetic site — the fixture for squirrelscan/repo#1864.
 *
 * `site.ts` serves a MIXED estate (10% heavy product pages) which is the right
 * shape for storage and crawl work. It is the wrong shape for rule cost on a
 * script-heavy site: the case #1864 is about is drscholls.com, where EVERY page
 * is ~1 MB with ~820 KB of inline script, and the mixed estate dilutes that to a
 * tenth. This server serves N copies of one real saved page so the per-page rule
 * cost measured here is the per-page rule cost the container pays.
 *
 * Every page is byte-unique (the page id is woven into the title, h1 and
 * canonical) so the content-hash store cannot dedupe them, and each page links
 * to 40 siblings so the whole estate is reachable from "/".
 *
 * Usage: bun script-heavy-site.ts <base-page.html> <N> [--port P] [--salt S]
 * Prints the chosen port on stdout, then serves until killed.
 */

const basePath = process.argv[2];
if (!basePath) throw new Error("usage: script-heavy-site.ts <base-page.html> <N>");
const N = Number(process.argv[3] ?? 150);
const portArgIdx = process.argv.indexOf("--port");
const wantPort = portArgIdx > -1 ? Number(process.argv[portArgIdx + 1]) : 0;
const saltIdx = process.argv.indexOf("--salt");
const SALT = saltIdx > -1 ? String(process.argv[saltIdx + 1]) : "";

const BASE = await Bun.file(basePath).text();

const cache = new Map<number, string>();

function render(i: number): string {
  const hit = cache.get(i);
  if (hit) return hit;
  const links = Array.from({ length: 40 }, (_, k) => {
    const t = (i * 7 + k * 13) % N;
    return `<a href="/p/${t}">Product ${t}</a>`;
  }).join("\n");
  const html = BASE
    // byte-unique per page, and the salt makes a whole run cold against the
    // global content store without touching anyone's cache
    .replace(/<title>[^<]*<\/title>/, `<title>Page ${i}${SALT ? ` ${SALT}` : ""} Dr Scholls</title>`)
    .replace("</body>", `<nav id="syn" aria-label="Related">${links}</nav></body>`);
  // only memoise a working set; N copies of a 1 MB page is not worth holding
  if (cache.size < 24) cache.set(i, html);
  return html;
}

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Array.from(
  { length: N },
  (_, i) => `<url><loc>__ORIGIN__/p/${i}</loc></url>`
).join("\n")}\n</urlset>`;

const srv = Bun.serve({
  port: wantPort,
  fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/robots.txt") {
      return new Response(`User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`, {
        headers: { "content-type": "text/plain" },
      });
    }
    if (p === "/sitemap.xml") {
      return new Response(sitemap.replaceAll("__ORIGIN__", url.origin), {
        headers: { "content-type": "application/xml" },
      });
    }
    const m = p.match(/^\/p\/(\d+)$/);
    const i = m ? Number(m[1]) % N : 0;
    return new Response(render(i), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
console.log(srv.port);
await new Promise(() => {});
