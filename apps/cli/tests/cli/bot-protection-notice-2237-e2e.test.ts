// Bot-protection caveat (repo#2237), end to end with the real CLI against local sites that
// carry Cloudflare headers on every response, so preflight detects the vendor. A crawl that
// was served every page prints no caveat; a crawl the vendor refused names the refused count.
//
// The sites listen on 127.0.0.2: preflight skips vendor detection for localhost and 127.0.0.1,
// so a site there would never count as behind a detected vendor. Linux routes all of 127/8 to
// loopback; where 127.0.0.2 cannot be bound (stock macOS) the tests skip.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-bot-2237-"));

const HOST = "127.0.0.2";
const CLOUDFLARE = { server: "cloudflare", "cf-ray": "8abc123def-AMS" };

function page(title: string, links: string[]): Response {
  const anchors = links
    .map((href) => `<a href="${href}">${href}</a>`)
    .join(" ");
  return new Response(
    `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="${title} page"></head><body><h1>${title}</h1>${anchors}</body></html>`,
    { headers: { "content-type": "text/html", ...CLOUDFLARE } }
  );
}

function serve(fetch: (req: Request) => Response) {
  try {
    return Bun.serve({ port: 0, hostname: HOST, fetch });
  } catch {
    return undefined;
  }
}

/** Behind Cloudflare, and every page is served. */
const servedHits = new Set<string>();
const servedSite = serve((req) => {
  const { pathname } = new URL(req.url);
  servedHits.add(pathname);
  if (pathname === "/") return page("Home", ["/about", "/contact"]);
  if (pathname === "/about") return page("About", ["/"]);
  if (pathname === "/contact") return page("Contact", ["/"]);
  return new Response("nf", { status: 404, headers: CLOUDFLARE });
});

/** Behind Cloudflare, and one linked page is a challenge. */
const refusingSite = serve((req) => {
  const { pathname } = new URL(req.url);
  if (pathname === "/") return page("Home", ["/about", "/members"]);
  if (pathname === "/about") return page("About", ["/"]);
  if (pathname === "/members") {
    return new Response(
      "<html><title>Just a moment...</title><body>wait</body></html>",
      {
        status: 403,
        headers: {
          "content-type": "text/html",
          "cf-mitigated": "challenge",
          ...CLOUDFLARE,
        },
      }
    );
  }
  return new Response("nf", { status: 404, headers: CLOUDFLARE });
});
const unbindable = !servedSite || !refusingSite;

afterAll(() => {
  void servedSite?.stop(true);
  void refusingSite?.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

let homes = 0;
async function audit(port: number | undefined) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      `http://${HOST}:${port}/`,
      "--offline",
      "--http",
      "-m",
      "5",
    ],
    {
      env: {
        ...env,
        HOME: join(scratch, `home-${++homes}`),
        SQUIRREL_NO_UPDATE: "1",
        NO_TELEMETRY: "1",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { output: `${out}\n${err}`, code };
}

describe.skipIf(unbindable)("bot protection caveat (repo#2237)", () => {
  test("a crawl behind a detected vendor that serves every page prints no caveat", async () => {
    const r = await audit(servedSite?.port);
    // The crawl reached every page, so the vendor never got in the way.
    expect(servedHits.has("/about")).toBe(true);
    expect(servedHits.has("/contact")).toBe(true);
    expect(r.output).not.toMatch(/protection refused/i);
    expect(r.output).not.toMatch(/Site uses .* protection/i);
    expect(r.output).not.toMatch(/coverage may be reduced/i);
  }, 120_000);

  test("the same vendor refusing a page prints the caveat with the refused count", async () => {
    const r = await audit(refusingSite?.port);
    // The control: identical vendor headers on the same host, and the caveat names the vendor,
    // so preflight did detect it; the only difference from the first site is the refusal.
    expect(r.output).toMatch(/cloudflare protection refused 1 URL\b/i);
    expect(r.output).toMatch(/coverage may be reduced/i);
  }, 120_000);
});
