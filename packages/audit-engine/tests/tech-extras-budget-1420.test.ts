// #1420 through the cloud payload path: a 700 KB bundle cut to the 64 KB payload cap keeps the windows
// of every detector, so a Sentry.init near the end is still found when hundreds of earlier hint
// windows compete for the extras.

import { describe, expect, test } from "bun:test";

import {
  buildTechInputs,
  windowScanAllowances,
  DEFAULT_TECH_BUNDLE_LIMITS,
  detectReportTechnologiesMulti,
} from "../src/technologies";

const HOME = "https://example.com/";

function filler(bytes: number): string {
  const unit = `function f(x){let y=x*3;const u="https://www.example.com/a/"+y;return u.length}\n`;
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

function crowd(count: number): string {
  const key = ["eyJ", "x".repeat(40)].join("");
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(`var s${i}=mk("https://p${String(i).padStart(19, "0")}.supabase.co","${key}");`);
    lines.push(
      `var f${i}={authDomain:"app${i}.firebaseapp.com",storageBucket:"app${i}.appspot.com"};`,
    );
  }
  return lines.join("\n");
}

function detect(
  content: string,
  limits = DEFAULT_TECH_BUNDLE_LIMITS,
): { ids: string[]; bodyBytes: number } {
  const inputs = buildTechInputs(
    [
      {
        url: HOME,
        headers: {},
        html: `<!doctype html><div id="root"></div><script src="/a.js"></script>`,
      },
    ],
    [{ url: "https://example.com/a.js", content, sourcePages: [HOME] }],
    limits,
  );
  const body = inputs[0]!.scripts?.find((s) => s.content)?.content ?? "";
  return {
    ids: detectReportTechnologiesMulti(inputs).items.map((t) => t.id),
    bodyBytes: body.length,
  };
}

describe("unhinted detectors past the head, at the cloud payload caps (#1420)", () => {
  test("Sentry.init near the end of a big bundle is found with hundreds of earlier hint windows", () => {
    const content = `${filler(250_000)}\n${crowd(400)}\n${filler(100_000)}\nSentry.init({dsn:"https://k@o1.ingest.sentry.io/2"});\n${filler(100_000)}`;
    const { ids, bodyBytes } = detect(content);
    expect(bodyBytes).toBeLessThanOrEqual(DEFAULT_TECH_BUNDLE_LIMITS.bundleBytes);
    expect(ids).toContain("sentry");
  });

  test("React, PostHog and Stripe late in the same bundle are found too", () => {
    const content = [
      filler(250_000),
      crowd(400),
      filler(60_000),
      `window.__REACT_DEVTOOLS_GLOBAL_HOOK__=window.__REACT_DEVTOOLS_GLOBAL_HOOK__||{};`,
      filler(60_000),
      `posthog.init("phc_x",{api_host:"https://eu.i.posthog.com"});`,
      filler(60_000),
      `var st=Stripe("pk_test_x");`,
      filler(120_000),
    ].join("\n");
    const { ids } = detect(content);
    for (const id of ["react", "posthog", "stripe"]) expect(ids).toContain(id);
  });

  test("the existing hinted detections still win: Supabase beside its key among the crowd", () => {
    const content = `${filler(250_000)}\n${crowd(50)}\n${filler(200_000)}`;
    expect(detect(content).ids).toContain("supabase");
  });
});

// #1433 corpus: a loader the string tracker lost (a quote in a regex after `}` reads as the start of a
// string that runs to the end of the line) in a small script, with another hint's window after it.
describe("a loader in a small script survives the string tracker, at both caps (#1433 corpus)", () => {
  const lostLine = (loader: string): string =>
    `x=a}/'/.test(c);${filler(1_500).replaceAll("\n", "")}${loader}${filler(1_000).replaceAll("\n", "")}\n`;
  const cases = [
    { name: "ttq.load( at 21 KB of 26 KB", loader: "ttq.load('ABCDEFGH');ttq.page();", id: "tiktok-pixel", before: 20_000, rest: 3_500 },
    { name: "fbq( 2 KB from the end of 121 KB", loader: "fbq('init','1234567890');", id: "facebook-pixel", before: 116_000, rest: 1_500 },
    { name: "posthog.init at 19 KB of 34 KB", loader: "window.posthog||[]);posthog.init('phc_x',{});", id: "posthog", before: 17_000, rest: 14_000 },
  ];
  const caps = [
    { cap: "cloud", limits: DEFAULT_TECH_BUNDLE_LIMITS },
    { cap: "24 KB bundle", limits: { bundleBytes: 24 * 1024, pageBytes: 512 * 1024, auditBytes: 1024 * 1024 } },
  ];
  for (const c of cases) {
    for (const { cap, limits } of caps) {
      test(`${c.name} (${cap})`, () => {
        const content = `${filler(c.before)}\n${lostLine(c.loader)}${filler(300)}\nStripe("pk_test_x");\n${filler(c.rest)}`;
        expect(detect(content, limits).ids).toContain(c.id);
      });
    }
  }
});


// #1445: the page budget is shared by every bundle of a page. Early small scripts' whole remainders
// used the room that a later bundle's hint windows needed, so the loader literal there was never sent.
describe("hint windows are allocated across all of a page's bundles before whole remainders (#1445)", () => {
  // Code with no vendor literal in it: only the loader line is a hint hit.
  const plain = (bytes: number): string => {
    const unit = "var q=(a<<3)+b;if(q>9){q-=9}\n";
    return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
  };
  const HTML = `<!doctype html><div id="root"></div>`;
  function detectPage(
    scripts: Array<{ url: string; content: string }>,
    limits = DEFAULT_TECH_BUNDLE_LIMITS,
  ): string[] {
    const inputs = buildTechInputs(
      [{ url: HOME, headers: {}, html: HTML }],
      scripts.map((s) => ({ ...s, sourcePages: [HOME] })),
      limits,
    );
    return detectReportTechnologiesMulti(inputs).items.map((t) => t.id);
  }
  const small = (n: number) => ({ url: `https://example.com/s${n}.js`, content: plain(40_000) });
  const late = (loader: string, before = 150_000) => ({
    url: "https://example.com/late.js",
    content: `${plain(before)}\n${loader}\n${plain(50_000)}`,
  });

  test("25 scripts at the 512 KB page cap: a loader in the last bundle's window is found beside the early remainders", () => {
    const scripts = [...Array.from({ length: 24 }, (_, n) => small(n)), late('posthog.init("phc_x",{api_host:"https://eu.i.posthog.com"});')];
    expect(detectPage(scripts)).toContain("posthog");
  });

  test("fewer, bigger early scripts: the same loader is found", () => {
    const scripts = [...Array.from({ length: 20 }, (_, n) => small(n)), late('var st=Stripe("pk_test_x");')];
    expect(detectPage(scripts)).toContain("stripe");
  });

  test("a loader inside an early small script's remainder is still found", () => {
    const early = { url: "https://example.com/early.js", content: `${plain(20_000)}\nposthog.init("phc_x",{});\n${plain(10_000)}` };
    const scripts = [early, ...Array.from({ length: 25 }, (_, n) => small(n)), late("var st=Stripe('pk_test_x');")];
    const ids = detectPage(scripts);
    expect(ids).toContain("posthog");
    expect(ids).toContain("stripe");
  });

  test("the page budget still holds", () => {
    const scripts = [...Array.from({ length: 24 }, (_, n) => small(n)), late('Sentry.init({dsn:"https://k@o1.ingest.sentry.io/2"});')];
    const inputs = buildTechInputs([{ url: HOME, headers: {}, html: HTML }], scripts.map((s) => ({ ...s, sourcePages: [HOME] })), DEFAULT_TECH_BUNDLE_LIMITS);
    const bytes = (inputs[0]!.scripts ?? []).reduce((sum, s) => sum + Buffer.byteLength(s.content ?? ""), 0);
    expect(bytes).toBeLessThanOrEqual(DEFAULT_TECH_BUNDLE_LIMITS.pageBytes);
  });
});

describe("the budget steps of a page (#1445)", () => {
  const HTML = `<!doctype html><div id="root"></div>`;
  const plain = (bytes: number): string => {
    const unit = "var q=(a<<3)+b;if(q>9){q-=9}\n";
    return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
  };
  const page = (scripts: Array<{ url: string; content: string }>, limits: typeof DEFAULT_TECH_BUNDLE_LIMITS) =>
    buildTechInputs(
      [{ url: HOME, headers: {}, html: HTML }],
      scripts.map((s) => ({ ...s, sourcePages: [HOME] })),
      limits,
    );
  const ids = (inputs: ReturnType<typeof page>): string[] => detectReportTechnologiesMulti(inputs).items.map((t) => t.id);

  // Eight copies of six loaders: about 48 qualifying windows (over 18 KB) before the file's end.
  const LOADERS = [
    'posthog.init("phc_x",{api_host:"https://eu.i.posthog.com"});',
    'var st=Stripe("pk_test_x");',
    'Sentry.init({dsn:"https://k@o1.ingest.sentry.io/2"});',
    "fbq('init','1234567890');",
    "ttq.load('ABCDEFGH');",
    'window.__REACT_DEVTOOLS_GLOBAL_HOOK__=window.__REACT_DEVTOOLS_GLOBAL_HOOK__||{};',
  ];
  // Each copy sits in different text, so the windows are all distinct.
  const unique = (bytes: number, seed: number): string =>
    Array.from({ length: Math.ceil(bytes / 30) }, (_, n) => `var q${seed}_${n}=(a<<3)+b;\n`).join("").slice(0, bytes);
  const heavy = (): string =>
    LOADERS.flatMap((l, i) => Array.from({ length: 8 }, (_, k) => `${unique(2_500, i * 10 + k)}\n${l}\n`)).join("");

  test("a window-heavy bundle still sends its tail (the reserve holds)", () => {
    // adobe-analytics has no literal to search for: only the end of the file can carry it.
    const content = `${plain(20_000)}\n${heavy()}${plain(40_000)}\nvar u="https://x.sc.omtrdc.net/b/ss/y";\n${plain(1_500)}`;
    const found = ids(page([{ url: "https://example.com/a.js", content }], DEFAULT_TECH_BUNDLE_LIMITS));
    expect(found).toContain("adobe-analytics");
  });

  test("windows are given out in rounds: bundles with many windows cannot take the room from a later one", () => {
    // Room for about 30 KB of extras after six floors. Each of five bundles holds far more windows than that.
    const limits = { bundleBytes: 64 * 1024, pageBytes: 6 * 16 * 1024 + 30 * 1024, auditBytes: 1024 * 1024 };
    const crowded = Array.from({ length: 5 }, (_, n) => ({
      url: `https://example.com/crowd${n}.js`,
      content: `${unique(20_000, 100 + n)}\n${heavy()}${unique(10_000, 110 + n)}`,
    }));
    // A vendor only the last bundle holds.
    const last = { url: "https://example.com/last.js", content: `${unique(60_000, 120)}\nmixpanel.init("tok",{});\n${unique(10_000, 121)}` };
    expect(ids(page([...crowded, last], limits))).toContain("mixpanel");
  });

  test("the room a bundle already holds is given back before its windows grow", () => {
    const limits = { bundleBytes: 64 * 1024, pageBytes: 16 * 1024 + 5 * 1024, auditBytes: 1024 * 1024 };
    const content = `${unique(20_000, 300)}\n${heavy()}${unique(10_000, 301)}`;
    const inputs = page([{ url: "https://example.com/a.js", content }], limits);
    const bytes = (inputs[0]!.scripts ?? []).reduce((sum, s) => sum + Buffer.byteLength(s.content ?? ""), 0);
    expect(bytes).toBeLessThanOrEqual(limits.pageBytes);
    // The whole 5 KB of extras is used, not only what is left after the first 2 KB round.
    expect(bytes).toBeGreaterThan(limits.pageBytes - 600);
    const body = inputs[0]!.scripts?.[0]?.content ?? "";
    expect(LOADERS.reduce((n, l) => n + body.split(l).length - 1, 0)).toBeGreaterThanOrEqual(8);
  });

  test("a page of window-heavy bundles spends its budget to the byte: windows are charged once", () => {
    const limits = { bundleBytes: 64 * 1024, pageBytes: 6 * 16 * 1024 + 30 * 1024, auditBytes: 1024 * 1024 };
    const crowded = Array.from({ length: 6 }, (_, n) => ({
      url: `https://example.com/crowd${n}.js`,
      content: `${unique(20_000, 200 + n)}\n${heavy()}${unique(10_000, 210 + n)}`,
    }));
    const inputs = page(crowded, limits);
    const bytes = (inputs[0]!.scripts ?? []).reduce((sum, s) => sum + Buffer.byteLength(s.content ?? ""), 0);
    expect(bytes).toBeLessThanOrEqual(limits.pageBytes);
    expect(bytes).toBeGreaterThan(limits.pageBytes - 4 * 1024);
  });

  test("the page budget is spent, not wasted: whole remainders fill what the windows left", () => {
    const small = Array.from({ length: 24 }, (_, n) => ({ url: `https://example.com/s${n}.js`, content: plain(40_000) }));
    const inputs = page(small, DEFAULT_TECH_BUNDLE_LIMITS);
    const bytes = (inputs[0]!.scripts ?? []).reduce((sum, s) => sum + Buffer.byteLength(s.content ?? ""), 0);
    expect(bytes).toBeLessThanOrEqual(DEFAULT_TECH_BUNDLE_LIMITS.pageBytes);
    // 24 bundles of 40 KB would be 960 KB: the page cap is reached, not left a long way off.
    expect(bytes).toBeGreaterThan(DEFAULT_TECH_BUNDLE_LIMITS.pageBytes - 8 * 1024);
  });
});

describe("the window scan is bounded and shared fairly (#1445)", () => {
  const MB = 1024 * 1024;
  const HTML = `<!doctype html><div id="root"></div>`;
  const code = (chars: number): string => "var q=(a<<3)+b;if(q>9){q-=9}\n".repeat(Math.ceil(chars / 29)).slice(0, chars);
  const page = (scripts: Array<{ url: string; content: string }>, limits = DEFAULT_TECH_BUNDLE_LIMITS) =>
    buildTechInputs(
      [{ url: HOME, headers: {}, html: HTML }],
      scripts.map((s) => ({ ...s, sourcePages: [HOME] })),
      limits,
    );
  const ids = (inputs: ReturnType<typeof page>): string[] => detectReportTechnologiesMulti(inputs).items.map((t) => t.id);

  test("the allowances stay within the cap, give small bundles their whole length and large ones an equal share", () => {
    const thirty = windowScanAllowances(Array.from({ length: 30 }, () => 3 * MB));
    expect(thirty.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(12 * MB + 30 * 64 * 1024);
    expect(Math.min(...thirty)).toBeGreaterThan(300 * 1024);
    const mixed = windowScanAllowances([100_000, 200_000, 10 * MB, 10 * MB]);
    expect(mixed.slice(0, 2)).toEqual([100_000, 200_000]);
    expect(mixed[2]).toBe(mixed[3]);
    expect(mixed[2]!).toBeGreaterThan(3.5 * MB);
  });

  test("a single huge body is searched in its whole share, never skipped", () => {
    expect(windowScanAllowances([40 * MB])).toEqual([12 * MB]);
    expect(windowScanAllowances([5_000])).toEqual([5_000]);
  });

  test("every bundle gets a floor even when the page has far more than the cap", () => {
    const many = windowScanAllowances(Array.from({ length: 400 }, () => 2 * MB));
    expect(Math.min(...many)).toBeGreaterThanOrEqual(64 * 1024);
  });

  test("six 3 MB bundles: a loader 0.8 MB into the last one is found (first-fit used to skip it)", () => {
    const scripts = Array.from({ length: 5 }, (_, n) => ({ url: `https://example.com/b${n}.js`, content: code(3 * MB) }));
    scripts.push({ url: "https://example.com/last.js", content: `${code(0.8 * MB)}\nposthog.init("phc_x",{});\n${code(2 * MB)}` });
    expect(ids(page(scripts))).toContain("posthog");
  }, 60_000);

  test("one 18 MB body is searched: a loader 2 MB in is found", () => {
    const body = `${code(2 * MB)}\nvar st=Stripe("pk_test_x");\n${code(16 * MB)}`;
    expect(ids(page([{ url: "https://example.com/huge.js", content: body }]))).toContain("stripe");
  }, 60_000);

  test("the scan is bounded by the page's share: 40 bundles of 600 KB search 300 KB each", () => {
    const filler = Array.from({ length: 39 }, (_, n) => ({ url: `https://example.com/f${n}.js`, content: code(600_000) }));
    const near = { url: "https://example.com/near.js", content: `${code(100_000)}\nposthog.init("phc_x",{});\n${code(500_000)}` };
    const far = { url: "https://example.com/far.js", content: `${code(550_000)}\nvar st=Stripe("pk_test_x");\n${code(50_000)}` };
    const found = ids(page([...filler, near, far], { bundleBytes: 128 * 1024, pageBytes: 8 * MB, auditBytes: 32 * MB }));
    expect(found).toContain("posthog");
    // Past the share (about 300 KB of each) is not searched; the tail is not sent either for a prefixed scan.
    expect(found).not.toContain("stripe");
  }, 90_000);

  test("a tail under 420 bytes is still sent when that is all the room there is", () => {
    const limits = { bundleBytes: 64 * 1024, pageBytes: 16 * 1024 + 300, auditBytes: 1024 * 1024 };
    const content = `${code(40_000)}\nvar u="https://x.sc.omtrdc.net/b/ss/y";\n${code(40)}`;
    expect(ids(page([{ url: "https://example.com/a.js", content }], limits))).toContain("adobe-analytics");
  });

  test("the tail reserve holds on a page: windows alone never take the room of a tail", () => {
    // 8 KB of extras: the windows may take 6 KB, so the last 1.5 KB of the file is sent.
    const limits = { bundleBytes: 16 * 1024 + 8 * 1024, pageBytes: 1024 * 1024, auditBytes: 4 * 1024 * 1024 };
    const unique = (bytes: number, seed: number): string =>
      Array.from({ length: Math.ceil(bytes / 30) }, (_, n) => `var q${seed}_${n}=(a<<3)+b;\n`).join("").slice(0, bytes);
    const loaders = ['posthog.init("phc_x",{});', 'var st=Stripe("pk_test_x");', 'Sentry.init({dsn:"https://k@o1.ingest.sentry.io/2"});', "fbq('init','1234567890');", "ttq.load('ABCDEFGH');"];
    const crowd = loaders.flatMap((l, i) => Array.from({ length: 8 }, (_, k) => `${unique(2_500, i * 10 + k)}\n${l}\n`)).join("");
    const content = `${unique(20_000, 900)}\n${crowd}${unique(40_000, 901)}\nvar u="https://x.sc.omtrdc.net/b/ss/y";\n${unique(1_000, 902)}`;
    expect(ids(page([{ url: "https://example.com/a.js", content }], limits))).toContain("adobe-analytics");
  });
});
