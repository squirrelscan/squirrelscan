/**
 * Peak RSS of the crawl's fetch paths against Content-Encoding bombs (1 GiB of
 * spaces sent as about 1 MB of gzip, or about 200 KB of brotli), with the
 * server in its own process so its buffers stay out of the numbers.
 * Produced the table in ../2026-10-content-encoding-bombs.md.
 *
 * Usage: bun benchmarks/harness/encoding-bomb.ts [--root <checkout>] [--repeats 3]
 *
 * `--root` is the repository checkout whose packages are measured (default:
 * this one), so a before/after pair is two runs: one with `--root` at a
 * checkout of the parent commit, one without. Each case runs in a fresh
 * process; repeats are interleaved and the minimum and maximum are reported.
 */
import { constants, createBrotliCompress, createGzip } from "node:zlib";
import { join, resolve } from "node:path";

const GIB = 1024 * 1024 * 1024;
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const CASES = [
  "page-identity",
  "page-gzip",
  "page-br",
  "page-hop-br",
  "fetcher-gzip",
  "robots-br",
  "llms-gzip",
  "well-known-gzip",
  "agent-access-gzip",
] as const;
type Case = (typeof CASES)[number];

/** `total` bytes of spaces through a streaming compressor, never held whole. */
async function bomb(compressor: NodeJS.ReadWriteStream, total: number): Promise<Buffer> {
  const out: Buffer[] = [];
  compressor.on("data", (chunk: Buffer) => out.push(chunk));
  const ended = new Promise((done) => compressor.on("end", done));
  const chunk = Buffer.alloc(16 * 1024 * 1024, 0x20);
  for (let sent = 0; sent < total; sent += chunk.byteLength) {
    if (!compressor.write(chunk)) await new Promise((done) => compressor.once("drain", done));
  }
  compressor.end();
  await ended;
  return Buffer.concat(out);
}

/** A body sent chunked, so no Content-Length lets a probe skip the read. */
function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + 64 * 1024));
      offset += 64 * 1024;
    },
  });
}

async function serve(): Promise<void> {
  const bombs: Record<string, Buffer> = {
    gzip: await bomb(createGzip({ level: 6 }), GIB),
    br: await bomb(createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }), GIB),
  };
  const page = new TextEncoder().encode("<!doctype html><title>plain</title>");
  const pages = Bun.serve({
    port: 0,
    fetch(req) {
      const [, kind, coding = "gzip"] = new URL(req.url).pathname.split("/");
      const encoded = (status = 200, headers: Record<string, string> = {}) =>
        new Response(bombs[coding], {
          status,
          headers: { "content-type": "text/html", "content-encoding": coding, ...headers },
        });
      if (kind === "page") return encoded();
      if (kind === "hop") return encoded(302, { location: "/plain" });
      if (kind === "identity") {
        let sent = 0;
        const chunk = new Uint8Array(1024 * 1024).fill(0x20);
        const body = new ReadableStream({
          pull(controller) {
            if (sent >= GIB) return controller.close();
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        return new Response(body, { headers: { "content-type": "text/html" } });
      }
      return new Response(page, { headers: { "content-type": "text/html" } });
    },
  });
  // Root probes ask for fixed paths, so each coding gets an origin where every
  // path is the bomb.
  const everyPath = (coding: string) =>
    Bun.serve({
      port: 0,
      fetch: (req) =>
        new Response(chunked(bombs[coding]!), {
          headers: {
            "content-type": new URL(req.url).pathname.endsWith(".txt") ? "text/plain" : "text/html",
            "content-encoding": coding,
          },
        }),
    });
  const gzipSite = everyPath("gzip");
  const brSite = everyPath("br");
  console.log(`PORTS ${pages.port} ${gzipSite.port} ${brSite.port}`);
}

async function measure(which: Case, root: string, ports: number[]): Promise<void> {
  const pkg = (path: string) => join(root, "packages", path);
  const { Effect } = await import(Bun.resolveSync("effect", pkg("crawler/src")));
  const { fetchPage } = await import(pkg("crawler/src/fetcher.ts"));
  const { createFetchDocumentFetcher } = await import(pkg("fetchers/src/index.ts"));
  const { fetchRobotsEvaluator } = await import(pkg("crawler/src/robots.ts"));
  const { fetchLlmsTxt } = await import(pkg("crawler/src/llms.ts"));
  const { probeWellKnown } = await import(pkg("crawler/src/well-known.ts"));
  const { probeAgentAccess } = await import(pkg("crawler/src/agent-access.ts"));
  const [pages, gzipSite, brSite] = ports.map((port) => `http://127.0.0.1:${port}`);
  const ua = "squirrel-bench";
  const page = (path: string) =>
    Effect.runPromise(
      fetchPage(`${pages}${path}`, { userAgent: ua, timeoutMs: 60_000, followRedirects: true }),
    );

  const run: Record<Case, () => Promise<unknown>> = {
    "page-identity": () => page("/identity"),
    "page-gzip": () => page("/page/gzip"),
    "page-br": () => page("/page/br"),
    "page-hop-br": () => page("/hop/br"),
    "fetcher-gzip": () =>
      createFetchDocumentFetcher().fetch({ url: `${pages}/page/gzip`, timeoutMs: 60_000 }),
    "robots-br": () => Effect.runPromise(fetchRobotsEvaluator(brSite, ua, true)),
    "llms-gzip": () => Effect.runPromise(fetchLlmsTxt(gzipSite, ua)),
    "well-known-gzip": () => Effect.runPromise(probeWellKnown(gzipSite, ua)),
    "agent-access-gzip": () => Effect.runPromise(probeAgentAccess(gzipSite, ua)),
  };

  // Warm the HTTP client and the modules, then measure growth from here.
  await (await fetch(`${pages}/plain`)).text();
  Bun.gc(true);
  await Bun.sleep(50);
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 2);
  const startedAt = performance.now();
  await run[which]();
  const ms = performance.now() - startedAt;
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  console.log(JSON.stringify({ case: which, peakGrowthMB: (peak - before) / 1e6, ms }));
  process.exit(0);
}

async function main(): Promise<void> {
  const root = resolve(flag("--root") ?? join(import.meta.dir, "..", ".."));
  const repeats = Number(flag("--repeats") ?? 3);
  const server = Bun.spawn(["bun", import.meta.path, "--serve"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = server.stdout.getReader();
  let banner = "";
  while (!banner.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) throw new Error("bomb server exited before listening");
    banner += new TextDecoder().decode(value);
  }
  const ports = banner.trim().split(/\s+/).slice(1);
  const results = new Map<Case, number[]>();
  try {
    for (let r = 0; r < repeats; r++) {
      for (const which of CASES) {
        const child = Bun.spawnSync(
          ["bun", import.meta.path, "--measure", which, "--root", root, "--ports", ports.join(",")],
          { stderr: "inherit" },
        );
        const line = child.stdout.toString().trim().split("\n").pop() ?? "";
        const { peakGrowthMB } = JSON.parse(line) as { peakGrowthMB: number };
        results.set(which, [...(results.get(which) ?? []), peakGrowthMB]);
      }
    }
  } finally {
    server.kill();
  }
  console.log(`root: ${root}\nBun ${Bun.version}, ${repeats} interleaved repeats\n`);
  console.log("| case | peak RSS growth, min | max |\n|---|---|---|");
  for (const [which, values] of results) {
    console.log(
      `| ${which} | ${Math.min(...values).toFixed(1)} MB | ${Math.max(...values).toFixed(1)} MB |`,
    );
  }
}

if (argv.includes("--serve")) await serve();
else if (argv.includes("--measure")) {
  await measure(
    flag("--measure") as Case,
    flag("--root")!,
    flag("--ports")!.split(",").map(Number),
  );
} else await main();
