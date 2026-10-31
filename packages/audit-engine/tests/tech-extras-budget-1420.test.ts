// #1420 through the cloud payload path: a 700 KB bundle cut to the 64 KB payload cap keeps the windows
// of every detector, so a Sentry.init near the end is still found when hundreds of earlier hint
// windows compete for the extras.

import { describe, expect, test } from "bun:test";

import {
  buildTechInputs,
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

function detect(content: string): { ids: string[]; bodyBytes: number } {
  const inputs = buildTechInputs(
    [
      {
        url: HOME,
        headers: {},
        html: `<!doctype html><div id="root"></div><script src="/a.js"></script>`,
      },
    ],
    [{ url: "https://example.com/a.js", content, sourcePages: [HOME] }],
    DEFAULT_TECH_BUNDLE_LIMITS,
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
