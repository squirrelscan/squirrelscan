// pub#401: a collector that throws inside the pre-rules walk's onBatchContext
// does not fail `squirrel audit`. The run completes and writes its report, the
// entity map is left out whole rather than built from the batches that
// survived, and the failure is logged once however many batches follow.
//
// No real JSON-LD makes the entity-map collector throw today, so the test
// swaps in one that does, through a spy on the module's live binding (not
// `mock.module`, which is process-wide in Bun). The site is a stubbed fetch.

import * as entityMapCollect from "@squirrelscan/audit-engine/entity-map/collect";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { runCommand } from "citty";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { audit } from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";
import { logger } from "@/utils/logger";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

// The content store and link cache are process-wide singletons opened at the
// path current on first use: close them on the way in and out so this file's
// audits use its own scratch dir (see audit-discovery-probes-wiring.test.ts).
function closeGlobalStores(): void {
  closeGlobalContentStore();
  closeGlobalLinkCache();
}
// #626: every squirrel path under one scratch dir, removed afterwards.
const scratch = isolateSquirrelHome("squirrel-collector-failure").root;
const configPath = join(scratch, "squirrel.toml");
const reportPath = join(scratch, "report.json");
let previousConfig: string | undefined;

beforeAll(() => {
  closeGlobalStores();
  previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
  writeFileSync(configPath, "");
});

afterAll(() => {
  closeGlobalStores();
  setGlobalConfigPath(previousConfig);
});

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const PAGES = 12;
const page = (i: number): string =>
  `<html><head><title>Page ${i}</title><script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script></head><body><h1>Page ${i}</h1></body></html>`;
const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from(
  { length: PAGES },
  (_, i) =>
    `<url><loc>https://example.com/${i === 0 ? "" : `p${i}`}</loc></url>`
).join("")}</urlset>`;

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalEnv = { ...process.env };
let restoreSpies: () => void = () => {};
let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  rmSync(reportPath, { force: true });
  process.exitCode = 0;
  // Anonymous and offline: nothing here may reach a real API.
  delete process.env.SQUIRREL_API_TOKEN;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  // The site is a stubbed fetch keyed by name: send its hosts by name
  // rather than resolving and pinning them (repo#3430).
  process.env.SQUIRREL_NO_HOST_PINNING = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  // Batches of 5 pages, so the crawl folds in more than one batch.
  process.env.SQUIRREL_STREAM_BATCH_PAGES = "5";
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  const warn = spyOn(logger, "warn").mockImplementation(
    (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    }
  );
  restoreSpies = () => {
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.hostname !== "example.com")
      return new Response("", { status: 404 });
    if (url.pathname === "/sitemap.xml") {
      return new Response(sitemap, {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }
    const match = url.pathname.match(/^\/(?:p(\d+))?$/);
    if (!match) return new Response("not found", { status: 404 });
    return new Response(page(Number(match[1] ?? 0)), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  restoreSpies();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  process.exitCode = originalExitCode ?? 0;
  process.env = { ...originalEnv };
});

async function runAudit(): Promise<Record<string, unknown>> {
  const rawArgs = [
    "https://example.com/",
    "-m",
    String(PAGES),
    "--offline",
    "-y",
    "--refresh",
    "-f",
    "json",
    "-o",
    reportPath,
  ];
  try {
    await runCommand(audit, { rawArgs });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  expect(existsSync(reportPath)).toBe(true);
  return JSON.parse(readFileSync(reportPath, "utf8")) as Record<
    string,
    unknown
  >;
}

describe("squirrel audit with a failing batch collector (pub#401)", () => {
  // THE CONTROL: with the real collector the report carries the map, so the
  // test below cannot pass because no map is ever written.
  test("the real collector puts an entity map in the report", async () => {
    const report = await runAudit();
    expect(process.exitCode).toBe(0);
    const totalPages = (report.meta as { totalPages: number }).totalPages;
    // More pages than one batch holds, so the walk folds several batches in.
    expect(totalPages).toBeGreaterThan(5);
    const entities = report.entities as { summary: { pagesTotal: number } };
    expect(entities.summary.pagesTotal).toBe(totalPages);
  });

  test("a throwing collector: the audit completes, writes no map, logs once", async () => {
    let absorbCalls = 0;
    const spy = spyOn(
      entityMapCollect,
      "createEntityMapCollector"
    ).mockImplementation(() => ({
      absorb() {
        absorbCalls++;
        throw new Error("collector exploded");
      },
      build() {
        throw new Error("build must not run once a batch failed");
      },
    }));
    try {
      const report = await runAudit();
      expect(process.exitCode).toBe(0);
      expect(report.entities).toBeUndefined();
      expect(
        (report.meta as { totalPages: number }).totalPages
      ).toBeGreaterThan(5);
    } finally {
      spy.mockRestore();
    }
    // Poisoned on the first batch: later batches never reach it.
    expect(absorbCalls).toBe(1);
    const entityWarnings = warnings.filter((w) =>
      w.includes("Could not build the entity map")
    );
    expect(entityWarnings).toEqual([
      "Could not build the entity map: collector exploded",
    ]);
  });
});
