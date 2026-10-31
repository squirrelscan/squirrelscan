// #1387: the local tech scan reads bundles whole (8 MB a bundle by default), says
// when a byte cap or the time budget cut it short, and stays inside its time
// budget on a hostile 5 MB body.

import { describe, expect, test } from "bun:test";

import { SERVICE_LIMITS } from "@squirrelscan/core-contracts";

import {
  buildTechInputs,
  DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
  DEFAULT_TECH_BUNDLE_LIMITS,
  detectReportTechnologiesMulti,
  LOCAL_TECH_DETECT_OPTIONS,
  techInputTruncation,
  type TechBundleLimits,
} from "../src/technologies";

const REF = "abcdefghijklmnopqrst";
const HOME = "https://example.com/";
const MB = 1024 * 1024;

/** Benign string-heavy filler, `bytes` long. */
function filler(bytes: number): string {
  const unit = `function f(x){let y=x*3;const u="https://www.example.com/a/"+y,t=\`//t/\${y}\`;return u.length+t.length}\n`;
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

function inputsFor(scripts: { url: string; content: string }[], limits: TechBundleLimits) {
  return buildTechInputs(
    [
      {
        url: HOME,
        headers: {},
        html: `<!doctype html><div id="root"></div>${scripts.map((s) => `<script src="${s.url}"></script>`).join("")}`,
      },
    ],
    scripts.map((s) => ({ ...s, sourcePages: [HOME] })),
    limits,
  );
}

const CALL = `\ncreateClient("https://${REF}.supabase.co","k");\n`;

describe("#1387 the local scan reads bundles whole", () => {
  test("a fingerprint 1.5 MB into a 2 MB bundle is detected at the local defaults, and nothing is truncated", () => {
    const code = `${filler(1.5 * MB)}${CALL}${filler(0.5 * MB)}`;
    const section = detectReportTechnologiesMulti(
      inputsFor(
        [{ url: "https://example.com/a.js", content: code }],
        DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
      ),
      undefined,
      LOCAL_TECH_DETECT_OPTIONS,
    );
    expect(section.items.map((t) => t.id)).toContain("supabase");
    expect(section.truncated).toBeUndefined();
  });

  test("the local defaults are 8 MB a bundle, and a bundle of that size is read whole", () => {
    expect(DEFAULT_LOCAL_TECH_BUNDLE_LIMITS.bundleBytes).toBe(8 * MB);
    const code = `${filler(7.5 * MB)}${CALL}`;
    const section = detectReportTechnologiesMulti(
      inputsFor(
        [{ url: "https://example.com/a.js", content: code }],
        DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
      ),
      undefined,
      LOCAL_TECH_DETECT_OPTIONS,
    );
    expect(section.items.map((t) => t.id)).toContain("supabase");
    expect(section.truncated).toBeUndefined();
  });

  test("the cloud payload caps stay as they were (64 KB, 512 KB, 1 MB)", () => {
    expect(DEFAULT_TECH_BUNDLE_LIMITS).toEqual({
      bundleBytes: 64 * 1024,
      pageBytes: 512 * 1024,
      auditBytes: MB,
    });
  });
});

describe("#1387 callers that do not opt in keep the package cap", () => {
  test("detectReportTechnologiesMulti without options matches only 256 KB of a script", () => {
    const code = `${filler(1.5 * MB)}${CALL}`;
    const inputs = inputsFor(
      [{ url: "https://example.com/a.js", content: code }],
      DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
    );
    expect(detectReportTechnologiesMulti(inputs).items.map((t) => t.id)).not.toContain("supabase");
    expect(
      detectReportTechnologiesMulti(inputs, undefined, LOCAL_TECH_DETECT_OPTIONS).items.map(
        (t) => t.id,
      ),
    ).toContain("supabase");
  });

  test("the local options are the 16 MiB script limit and the 30 s page budget", () => {
    expect(LOCAL_TECH_DETECT_OPTIONS).toEqual({ pageBudgetMs: 30_000, maxScriptChars: 16 * MB });
  });
});

describe("#1387 the cloud result carries what the payload caps cut", () => {
  test("techInputTruncation lists the byte reasons of capped inputs, and nothing when all was read", () => {
    const code = `${filler(200 * 1024)}${CALL}${filler(100 * 1024)}`;
    const capped = inputsFor(
      [{ url: "https://example.com/a.js", content: code }],
      DEFAULT_TECH_BUNDLE_LIMITS,
    );
    expect(techInputTruncation(capped)).toEqual({ reasons: ["bundle-bytes"], scripts: 1 });
    const whole = inputsFor(
      [{ url: "https://example.com/a.js", content: code }],
      DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
    );
    expect(techInputTruncation(whole)).toBeUndefined();
    expect(techInputTruncation(whole, ["time-budget"])).toEqual({
      reasons: ["time-budget"],
      scripts: 0,
    });
  });
});

describe("#1387 the report says when detection was cut short", () => {
  test("a bundle past bundle_bytes: truncated with bundle-bytes", () => {
    // A call no vendor window picks up: plain padding between, the pair far past a 64 KB cap.
    const code = `${filler(200 * 1024)}${CALL}${filler(100 * 1024)}`;
    const section = detectReportTechnologiesMulti(
      inputsFor([{ url: "https://example.com/a.js", content: code }], DEFAULT_TECH_BUNDLE_LIMITS),
    );
    expect(section.truncated?.reasons).toContain("bundle-bytes");
    expect(section.truncated?.scripts).toBe(1);
  });

  test("scripts left out by the page budget: truncated with page-bytes", () => {
    const scripts = Array.from({ length: 6 }, (_, i) => ({
      url: `https://example.com/s${i}.js`,
      content: filler(100 * 1024),
    }));
    const section = detectReportTechnologiesMulti(
      inputsFor(scripts, { bundleBytes: 200 * 1024, pageBytes: 250 * 1024, auditBytes: 8 * MB }),
    );
    expect(section.truncated?.reasons).toContain("page-bytes");
    expect(section.truncated?.scripts).toBeGreaterThan(0);
  });

  test("scripts left out by the audit budget: truncated with audit-bytes", () => {
    const scripts = Array.from({ length: 6 }, (_, i) => ({
      url: `https://example.com/s${i}.js`,
      content: filler(100 * 1024),
    }));
    const section = detectReportTechnologiesMulti(
      inputsFor(scripts, { bundleBytes: 200 * 1024, pageBytes: 8 * MB, auditBytes: 250 * 1024 }),
    );
    expect(section.truncated?.reasons).toContain("audit-bytes");
  });

  test("an exhausted time budget: truncated with time-budget, never silent", () => {
    const section = detectReportTechnologiesMulti(
      inputsFor(
        [{ url: "https://example.com/a.js", content: filler(10 * 1024) }],
        DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
      ),
      undefined,
      { pageBudgetMs: -1 },
    );
    expect(section.truncated?.reasons).toContain("time-budget");
  });

  test("everything read: no truncated field", () => {
    const section = detectReportTechnologiesMulti(
      inputsFor(
        [{ url: "https://example.com/a.js", content: filler(10 * 1024) }],
        DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
      ),
    );
    expect(section.truncated).toBeUndefined();
  });
});

describe("#1387 a hostile 5 MB bundle", () => {
  test("is read whole inside the local per-page budget, with no cut", () => {
    const REF2 = REF;
    const hostile = [
      `createClient(`.repeat(40_000),
      `"`.repeat(300_000),
      `/*`.repeat(200_000),
      `authDomain:"`.repeat(40_000),
      `(`.repeat(300_000),
      `"https://${REF2}.supabase.co" , `.repeat(20_000),
      `publishableKey:a||`.repeat(30_000),
      `"authDomain":"a`.repeat(30_000),
      `.supabase.co"`.repeat(100_000),
      `pk_test_`.repeat(100_000),
      `<script `.repeat(100_000),
    ].join("\n");
    expect(hostile.length).toBeGreaterThan(5 * MB);
    const inputs = inputsFor(
      [{ url: "https://example.com/a.js", content: hostile }],
      DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
    );
    const started = performance.now();
    const section = detectReportTechnologiesMulti(inputs, undefined, LOCAL_TECH_DETECT_OPTIONS);
    const ms = performance.now() - started;
    // Linear work over 5 MB is a second or two; the page budget (30 s) is not the bound.
    expect(ms).toBeLessThan(8_000);
    expect(section.truncated).toBeUndefined();
  });
});
