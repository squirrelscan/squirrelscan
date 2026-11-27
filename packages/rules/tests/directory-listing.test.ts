// security/directory-listing (#2336): probes the parent folders of the assets
// the crawl found, recognises Apache, nginx, IIS and Tomcat index pages by their
// markup and several file rows, ignores catch-all answers and never leaves the
// audited origin. Fixture servers run on 127.0.0.1.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import { createProbeBudget, type ProbeLevel } from "../src/probe-budget";
import {
  buildListingProbe,
  directoryListingRule,
  MAX_LISTING_FOLDERS,
  selectListingFolders,
} from "../src/security/directory-listing";
import {
  classifyDirectoryListing,
  MAX_LISTING_SAMPLE,
  type ListingServer,
} from "../src/security/directory-listing-classifier";
import { clearRequestAsync, setRequestAsync } from "../src/tools";

const APACHE = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN"><html><head><title>Index of /assets</title></head><body><h1>Index of /assets</h1><table><tr><th><a href="?C=N;O=D">Name</a></th><th><a href="?C=M;O=A">Last modified</a></th></tr><tr><td><a href="/">Parent Directory</a></td><td>&nbsp;</td></tr><tr><td><a href="app.css">app.css</a></td><td align="right">2024-05-01 10:22  </td><td align="right">12K</td></tr><tr><td><a href="app.js">app.js</a></td><td align="right">2024-05-01 10:23  </td><td align="right">80K</td></tr><tr><td><a href="backup.zip">backup.zip</a></td><td align="right">2024-05-02 08:00  </td><td align="right">4M</td></tr></table><address>Apache/2.4.57 (Ubuntu) Server at example.com Port 80</address></body></html>`;
const NGINX = `<html><head><title>Index of /assets/</title></head><body><h1>Index of /assets/</h1><hr><pre><a href="../">../</a>\n<a href="app.css">app.css</a>                 01-May-2024 10:22   12345\n<a href="img/">img/</a>                    01-May-2024 10:23       -\n</pre><hr></body></html>`;
const IIS = `<html><head><title>example.com - /assets/</title></head><body><H1>example.com - /assets/</H1><hr>\n<pre><A HREF="/">[To Parent Directory]</A><br><br>Wednesday, May 01, 2024 10:22 AM 12345 <A HREF="/assets/app.css">app.css</A><br>Wednesday, May 01, 2024 10:23 AM 999 <A HREF="/assets/app.js">app.js</A><br></pre><hr></body></html>`;
// What Tomcat 9.0.x and 10.1.x DefaultServlet (listings=true) emit for a
// subfolder: bracketed path, an "Up To" parent link inside the <h1>, absolute
// entry hrefs and HTTP dates. Line breaks are the servlet's own \r\n.
const TOMCAT = [
  `<!doctype html><html lang="en">`,
  `<head>`,
  `<title>Directory Listing For [/assets/]</title>`,
  `<style>h1 {font-family:Tahoma,Arial,sans-serif;color:white;background-color:#525D76;font-size:22px;} h2 {font-family:Tahoma,Arial,sans-serif;color:white;background-color:#525D76;font-size:16px;} h3 {font-family:Tahoma,Arial,sans-serif;color:white;background-color:#525D76;font-size:14px;} body {font-family:Tahoma,Arial,sans-serif;color:black;background-color:white;} b {font-family:Tahoma,Arial,sans-serif;color:white;background-color:#525D76;} p {font-family:Tahoma,Arial,sans-serif;background:white;color:black;font-size:12px;} a {color:black;} a.name {color:black;} .line {height:1px;background-color:#525D76;border:none;}</style> </head>`,
  `<body><h1>Directory Listing For [/assets/] - <a href="/"><b>Up To [/]</b></a></h1><hr class="line"><table width="100%" cellspacing="0" cellpadding="5" align="center">`,
  `<tr>`,
  `<td align="left"><font size="+1"><strong>Filename</strong></font></td>`,
  `<td align="center"><font size="+1"><strong>Size</strong></font></td>`,
  `<td align="right"><font size="+1"><strong>Last Modified</strong></font></td>`,
  `</tr><tr>`,
  `<td align="left">&nbsp;&nbsp;`,
  `<a href="/assets/app.css"><tt>app.css</tt></a></td>`,
  `<td align="right"><tt>12.1 kb</tt></td>`,
  `<td align="right"><tt>Wed, 01 May 2024 10:22:00 GMT</tt></td>`,
  `</tr>`,
  `<tr bgcolor="#eeeeee">`,
  `<td align="left">&nbsp;&nbsp;`,
  `<a href="/assets/app.js"><tt>app.js</tt></a></td>`,
  `<td align="right"><tt>3.4 kb</tt></td>`,
  `<td align="right"><tt>Wed, 01 May 2024 10:23:00 GMT</tt></td>`,
  `</tr>`,
  `<tr>`,
  `<td align="left">&nbsp;&nbsp;`,
  `<a href="/assets/img/"><tt>img/</tt></a></td>`,
  `<td align="right"><tt>&nbsp;</tt></td>`,
  `<td align="right"><tt>Wed, 01 May 2024 10:24:00 GMT</tt></td>`,
  `</tr>`,
  `</table>`,
  `<hr class="line"><h3>Apache Tomcat/9.0.85</h3></body>`,
  `</html>`,
  ``,
].join("\r\n");
const SPA = `<!doctype html><html><head><title>My App</title></head><body><div id="root"></div><script src="/static/js/main.js"></script></body></html>`;
const THEMED_404 = `<!doctype html><html><head><title>Page not found</title></head><body><h1>We could not find that page</h1><a href="/">Home</a><a href="/blog">Blog</a></body></html>`;

type Handler = (req: Request) => Response | Promise<Response>;
interface Fixture {
  origin: string;
  seen: string[];
  stop: () => void;
}
const servers: Fixture[] = [];

const html =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status, headers: { "content-type": "text/html" } });

function serve(routes: Record<string, Handler>, fallback?: Handler): Fixture {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(`${req.method} ${path}`);
      const route = routes[path];
      if (route) return route(req);
      return fallback ? fallback(req) : html(THEMED_404, 404)();
    },
  });
  const f = {
    origin: `http://127.0.0.1:${server.port}`,
    seen,
    stop: () => server.stop(true),
  };
  servers.push(f);
  return f;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});
beforeAll(() => setRequestAsync(() => Promise.reject(new Error("unused"))));
afterAll(() => clearRequestAsync());

function ctx(
  origin: string,
  opts: {
    level?: ProbeLevel;
    noProbe?: boolean;
    scripts?: string[];
    css?: string[];
    images?: string[];
    fonts?: string[];
  } = {}
): RuleContext {
  const res = (urls: string[]) =>
    urls.map((url) => ({
      url,
      status: 200,
      error: null,
      contentType: null,
      sizeBytes: null,
      sourcePages: [],
    }));
  return {
    page: {
      url: `${origin}/`,
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {} as RuleContext["parsed"],
    site: {
      baseUrl: `${origin}/`,
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      scripts: (opts.scripts ?? ["/assets/app.js"]).map((url) => ({
        url,
        status: 200,
        error: null,
        contentType: null,
        sizeBytes: null,
        content: null,
        sourcePages: [],
      })),
      resourceSizes: {
        css: res(opts.css ?? []),
        images: res(opts.images ?? []),
        fonts: res(opts.fonts ?? []),
      },
    },
    probe: opts.noProbe
      ? undefined
      : createProbeBudget({
          level: opts.level ?? "aggressive",
          budgetMs: 60_000,
        }),
    options: {},
  };
}

async function run(c: RuleContext): Promise<CheckResult[]> {
  return (await directoryListingRule.run(c)).checks;
}

describe("classifyDirectoryListing", () => {
  test.each<[ListingServer, string]>([
    ["apache", APACHE],
    ["nginx", NGINX],
    ["iis", IIS],
    ["tomcat", TOMCAT],
  ])("recognises %s", (server, body) => {
    const r = classifyDirectoryListing(body);
    expect(r?.server).toBe(server);
    expect(r?.files).toContain("app.css");
    expect(r?.files.some((f) => f.includes("/") && !f.endsWith("/"))).toBe(
      false
    );
  });

  test("reads every Tomcat entry and skips the Up To link in the heading", () => {
    expect(classifyDirectoryListing(TOMCAT)).toEqual({
      server: "tomcat",
      files: ["app.css", "app.js", "img/"],
      rows: 3,
    });
  });

  test("a catch-all or themed 404 is not a listing", () => {
    expect(classifyDirectoryListing(SPA)).toBeNull();
    expect(classifyDirectoryListing(THEMED_404)).toBeNull();
  });

  test("an Index of title with no file rows is not a listing", () => {
    const quoted = `<html><head><title>Index of /docs</title></head><body><h1>Index of /docs</h1><p>Parent Directory</p><a href="a">a</a></body></html>`;
    expect(classifyDirectoryListing(quoted)).toBeNull();
  });

  test("file rows without the server's header marker are not a listing", () => {
    const rows = `<html><body><pre><a href="../">../</a>\n<a href="a.css">a.css</a> 01-May-2024 10:22 1\n<a href="b.css">b.css</a> 01-May-2024 10:22 1\n</pre></body></html>`;
    expect(classifyDirectoryListing(rows)).toBeNull();
  });

  test("a single row is below the several-rows bar", () => {
    const one = NGINX.replace(/<a href="img\/">[^\n]*\n/, "");
    expect(classifyDirectoryListing(one)).toBeNull();
  });

  test("the sample is bounded", () => {
    const rows = Array.from(
      { length: 50 },
      (_, i) => `<a href="f${i}.css">f${i}.css</a>  01-May-2024 10:22  1\n`
    ).join("");
    const body = `<title>Index of /x/</title><h1>Index of /x/</h1><hr><pre><a href="../">../</a>\n${rows}</pre>`;
    const r = classifyDirectoryListing(body);
    expect(r?.files.length).toBe(MAX_LISTING_SAMPLE);
    expect(r?.rows).toBe(50);
  });

  test("a hostile page of links returns in bounded time", () => {
    const body = `${NGINX.slice(0, NGINX.indexOf("</pre>"))}${"<a ".repeat(200_000)}`;
    expect(() => classifyDirectoryListing(body)).not.toThrow();
  });
});

describe("selectListingFolders", () => {
  const origin = "https://example.com";
  test("takes parents, dedupes, drops root, query and other origins", () => {
    const out = selectListingFolders(origin, [
      "https://example.com/assets/app.js?v=1",
      "/assets/app.css",
      "/assets/img/a.png",
      "/favicon.ico",
      "https://cdn.example.net/lib/x.js",
      "https://example.com:8443/other/x.js",
      "not a url \u0000",
    ]);
    expect(out).toEqual(["/assets/", "/assets/img/"]);
  });
  test("caps the count", () => {
    const urls = Array.from({ length: 100 }, (_, i) => `/d${i}/f.js`);
    expect(selectListingFolders(origin, urls).length).toBe(MAX_LISTING_FOLDERS);
    expect(selectListingFolders(origin, urls, 3).length).toBe(3);
  });
  test("buildListingProbe keeps a path that looks like another host on the origin", () => {
    expect(buildListingProbe(origin, "//evil.example.net/x/").url).toBe(
      "https://example.com//evil.example.net/x/"
    );
    expect(buildListingProbe(origin, "//wp-content/").url).toBe(
      "https://example.com//wp-content/"
    );
  });
});

describe("security/directory-listing", () => {
  test("reports an exposed folder with a bounded sample of files", async () => {
    const f = serve({ "/assets/": html(APACHE) });
    const checks = await run(ctx(f.origin));
    const hit = checks.find((c) => c.name === "directory-listing");
    expect(hit?.status).toBe("warn");
    expect(hit?.message).toContain(`${f.origin}/assets/`);
    expect(hit?.items?.[0]?.meta?.files).toEqual([
      "app.css",
      "app.js",
      "backup.zip",
    ]);
    expect(checks.some((c) => c.name === "directory-listing-none")).toBe(false);
  });

  test("an asset under a double-slash path does not lose the listings found", async () => {
    const f = serve({ "/assets/": html(APACHE) });
    const checks = await run(
      ctx(f.origin, { css: [`${f.origin}//wp-content/x.css`] })
    );
    expect(checks.find((c) => c.name === "directory-listing")?.status).toBe(
      "warn"
    );
    // Bun's server collapses the doubled slash in the path it reports.
    expect(f.seen.some((s) => s.endsWith("/wp-content/"))).toBe(true);
  });

  test("a themed 404 is clean", async () => {
    const f = serve({});
    const checks = await run(ctx(f.origin));
    expect(checks.map((c) => c.name)).toEqual(["directory-listing-none"]);
  });

  test("an SPA catch-all answering 200 everywhere is clean", async () => {
    const f = serve({}, html(SPA));
    const checks = await run(ctx(f.origin, { css: ["/static/css/a.css"] }));
    expect(checks.map((c) => c.name)).toEqual(["directory-listing-none"]);
  });

  test("a server that lists every path is not reported, and says so", async () => {
    const f = serve({}, html(NGINX));
    const checks = await run(ctx(f.origin));
    expect(checks.map((c) => c.name)).toEqual(["directory-listing-incomplete"]);
    expect(f.seen.length).toBe(1);
  });

  test("a redirect is never followed", async () => {
    const other = serve({ "/assets/": html(APACHE) });
    const f = serve({
      "/assets/": () =>
        new Response(null, {
          status: 302,
          headers: { location: `${other.origin}/assets/` },
        }),
    });
    const checks = await run(ctx(f.origin));
    expect(checks.map((c) => c.name)).toEqual(["directory-listing-none"]);
    expect(other.seen).toEqual([]);
  });

  test("probes stay on the audited origin and are GET only", async () => {
    const other = serve({ "/lib/": html(APACHE) });
    const f = serve({ "/assets/": html(NGINX) });
    await run(
      ctx(f.origin, {
        scripts: ["/assets/app.js", `${other.origin}/lib/x.js`],
        css: [`${other.origin}/lib/y.css`],
      })
    );
    expect(other.seen).toEqual([]);
    expect(f.seen.every((s) => s.startsWith("GET "))).toBe(true);
    expect(f.seen).toContain("GET /assets/");
  });

  test("asks the shared budget: nothing is sent below aggressive or without a probe", async () => {
    const f = serve({ "/assets/": html(APACHE) });
    for (const level of ["passive", "active"] as const) {
      const checks = await run(ctx(f.origin, { level }));
      expect(checks[0]?.name).toBe("directory-listing-not-checked");
    }
    const none = await run(ctx(f.origin, { noProbe: true }));
    expect(none[0]?.name).toBe("directory-listing-not-checked");
    expect(f.seen).toEqual([]);
  });

  test("no asset folders is not checked, with nothing sent", async () => {
    const f = serve({});
    const checks = await run(ctx(f.origin, { scripts: ["/app.js"] }));
    expect(checks[0]?.name).toBe("directory-listing-not-checked");
    expect(f.seen).toEqual([]);
  });

  test("a 429 stops the run as incomplete", async () => {
    const f = serve({
      "/assets/": () => new Response("slow down", { status: 429 }),
    });
    const checks = await run(ctx(f.origin, { css: ["/css/a.css"] }));
    expect(checks.some((c) => c.name === "directory-listing-incomplete")).toBe(
      true
    );
  });
});
