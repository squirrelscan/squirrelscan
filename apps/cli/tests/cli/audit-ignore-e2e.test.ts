// `squirrel audit` with `[[ignore]]` entries (#1262), end to end: the real CLI in a
// subprocess against a local site whose pages set cookies, as a Shopify store does.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-ignore-e2e-"));

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    const pages = ["/", "/a", "/b", "/c"];
    if (!pages.includes(pathname))
      return new Response("not found", { status: 404 });
    const links = pages.map((p) => `<a href="${p}">p${p}</a>`).join(" ");
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
    headers.append("set-cookie", "localization=DE; Path=/");
    headers.append("set-cookie", "cart_currency=EUR; Path=/");
    headers.append("set-cookie", "merchant_pref=1; Path=/");
    return new Response(
      `<!doctype html><html lang="en"><head><title>Page ${pathname} of the cookie test shop</title></head><body><h1>Shop</h1><p>${links}</p></body></html>`,
      { headers }
    );
  },
});

afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

let homes = 0;
function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
  };
}

interface SlimReport {
  meta: {
    ignored?: {
      items: number;
      pages: number;
      byRule: Record<string, { items: number; pages: number }>;
      entries: Array<{
        index: number;
        rule: string;
        reason?: string;
        items: number;
        pages: number;
      }>;
      disabled?: boolean;
      carriedStale?: boolean;
    };
  };
  issues: Array<{
    ruleId: string;
    checks: Array<{
      name: string;
      status: string;
      message: string;
      items?: Array<{ id: string }>;
    }>;
  }>;
}

async function audit(home: string, config: string, ...args: string[]) {
  const configPath = join(scratch, `squirrel-${++homes}.toml`);
  writeFileSync(configPath, config);
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      site.url.origin,
      "--offline",
      "--http",
      "--rule-include",
      "security/cookie-flags",
      ...(args.includes("-f") ? [] : ["-f", "json"]),
      "--config-file",
      configPath,
      ...args,
    ],
    { env: cleanEnv(home), stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const report = out.trim().startsWith("{")
    ? (JSON.parse(out) as SlimReport)
    : undefined;
  return { code, err, out, report };
}

const httpOnlyItems = (r: SlimReport | undefined): string[] =>
  r?.issues
    .flatMap((i) => i.checks)
    .filter((c) => c.name === "cookie-httponly")
    .flatMap((c) => c.items?.map((i) => i.id) ?? []) ?? [];

const IGNORE = `
[[ignore]]
rule = "security/cookie-flags"
items = ["localization", "cart_currency"]
reason = "Shopify sets these itself"

[[ignore]]
rule = "security/cookie-flags"
items = ["never_set_cookie"]
`;

describe("squirrel audit with [[ignore]]", () => {
  test("waives the Shopify cookies, keeps the merchant cookie and says what it did", async () => {
    const home = join(scratch, `home-${++homes}`);
    const r = await audit(home, IGNORE);
    expect(r.code).toBe(0);
    expect(new Set(httpOnlyItems(r.report))).toEqual(
      new Set(["merchant_pref"])
    );
    const ignored = r.report!.meta.ignored!;
    expect(ignored.items).toBeGreaterThanOrEqual(8);
    expect(ignored.byRule["security/cookie-flags"]?.items).toBe(ignored.items);
    expect(ignored.entries[0]).toMatchObject({
      index: 0,
      rule: "security/cookie-flags",
      reason: "Shopify sets these itself",
    });
    expect(ignored.entries[0]!.items).toBeGreaterThan(0);
    // The second entry matched nothing, and the report says so.
    expect(ignored.entries[1]).toMatchObject({ items: 0, pages: 0 });
  }, 90_000);

  test("--no-ignore runs without the entries and shows every cookie", async () => {
    const home = join(scratch, `home-${++homes}`);
    const r = await audit(home, IGNORE, "--no-ignore");
    expect(r.code).toBe(0);
    expect(new Set(httpOnlyItems(r.report))).toEqual(
      new Set(["localization", "cart_currency", "merchant_pref"])
    );
    expect(r.report!.meta.ignored).toMatchObject({ disabled: true, items: 0 });
  }, 90_000);

  test("without entries the report has no ignored section", async () => {
    const home = join(scratch, `home-${++homes}`);
    const r = await audit(home, "");
    expect(r.report!.meta.ignored).toBeUndefined();
  }, 90_000);

  test("text output names the waiver and the entry that matched nothing", async () => {
    const home = join(scratch, `home-${++homes}`);
    const r = await audit(home, IGNORE, "-f", "text");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Ignored by squirrel.toml:");
    expect(r.out).toContain("1 of 2 entries matched");
    expect(r.out).toContain(
      "Ignore entry 2 (security/cookie-flags) matched nothing."
    );
  }, 90_000);

  // The carry path: findings carried from pages this run did not crawl are replayed from
  // the store, not re-run through the engine, so a changed list cannot reach them.
  test("a changed list with findings carried from uncrawled pages says they may still hold waived items", async () => {
    const home = join(scratch, `home-${++homes}`);
    const smart = "smart_audits = true\n";
    const first = await audit(home, smart + IGNORE, "-m", "4");
    expect(first.report!.meta.ignored?.carriedStale).toBeUndefined();
    const changed = `${smart}\n[[ignore]]\nrule = "security/cookie-flags"\nitems = ["localization"]\n`;
    const second = await audit(home, changed, "-m", "1");
    expect(second.report!.meta.ignored?.carriedStale).toBe(true);
    // The same list again, still carrying rows nobody re-evaluated: the warning stays.
    const third = await audit(home, changed, "-m", "1");
    expect(third.report!.meta.ignored?.carriedStale).toBe(true);
    // A run that crawls everything re-evaluates every page, and the warning ends.
    const full = await audit(home, changed, "-m", "4");
    expect(full.report!.meta.ignored?.carriedStale).toBeUndefined();
    const after = await audit(home, changed, "-m", "1");
    expect(after.report!.meta.ignored?.carriedStale).toBeUndefined();
  }, 240_000);

  test("a --no-ignore run in between does not hide that carried rows were never waived", async () => {
    const home = join(scratch, `home-${++homes}`);
    const smart = "smart_audits = true\n";
    await audit(home, smart + IGNORE, "-m", "4");
    const off = await audit(home, smart + IGNORE, "-m", "1", "--no-ignore");
    expect(off.report!.meta.ignored?.carriedStale).toBe(true);
    // Back to normal, partial again: the rows carried from the --no-ignore run are unwaived.
    const back = await audit(home, smart + IGNORE, "-m", "1");
    expect(back.report!.meta.ignored?.carriedStale).toBe(true);
  }, 240_000);
});
