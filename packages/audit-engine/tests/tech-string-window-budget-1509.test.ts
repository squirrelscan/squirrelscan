// #1509: a hint window for a string-carried script is up to 400 + 1,536 + 400 characters, not the ~416 bytes the page
// budget math was first written around. A page of scripts that each carry several such windows must still stay within
// the page, bundle and audit budgets, and still detect the loader. Scripts and ids are synthetic.

import { describe, expect, test } from "bun:test";

import { buildTechInputs, DEFAULT_TECH_BUNDLE_LIMITS, type TechBundleLimits } from "../src/technologies";

const HOME = "https://example.com/";
const BODY =
  '(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y)})(window,document,"clarity","script","p0fakeid01");';

function filler(bytes: number, seed: number): string {
  const unit = `function f${seed}(x){let y=x*3+${seed};return y&255}\n`;
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/** A 70 KB script with eight carrier strings of about 1.4 KB (decoys: no script-shaped element), and one real one if asked. */
function crowdedScript(seed: number, real: boolean): string {
  const padded = BODY + " ".repeat(1_100);
  const parts: string[] = [filler(20_000, seed)];
  for (let k = 0; k < 8; k++) parts.push(`h(Code,{children:'${padded}'});\n`, filler(4_000, seed + k + 1));
  if (real) parts.push(`h(Script,{strategy:"lazyOnload",children:'${padded}'});\n`);
  parts.push(filler(10_000, seed + 99));
  return parts.join("");
}

function build(pages: number, perPage: number, limits: TechBundleLimits, realAt: number) {
  const scripts = Array.from({ length: pages * perPage }, (_, i) => ({
    url: `https://example.com/p${Math.floor(i / perPage)}/s${i}.js`,
    content: crowdedScript(i + 1, i === realAt),
    sourcePages: [pages === 1 || i < perPage ? HOME : `https://example.com/page${Math.floor(i / perPage)}`],
  }));
  const pageUrl = (p: number): string => (p === 0 ? HOME : `https://example.com/page${p}`);
  const sources = Array.from({ length: pages }, (_, p) => ({
    url: pageUrl(p),
    headers: {},
    html: `<!doctype html>${scripts
      .filter((s) => s.sourcePages[0] === pageUrl(p))
      .map((s) => `<script src="${s.url}"></script>`)
      .join("")}`,
  }));
  return buildTechInputs(sources, scripts, limits);
}

const bytes = (inputs: ReturnType<typeof build>[number]): number =>
  (inputs.scripts ?? []).reduce((sum, s) => sum + Buffer.byteLength(s.content ?? ""), 0);

describe("string-hint windows against the page, bundle and audit budgets (#1509)", () => {
  test("a crowded page with eight big windows per script stays within pageBytes and bundleBytes", () => {
    const inputs = build(1, 30, DEFAULT_TECH_BUNDLE_LIMITS, 25);
    expect(bytes(inputs[0]!)).toBeLessThanOrEqual(DEFAULT_TECH_BUNDLE_LIMITS.pageBytes);
    for (const s of inputs[0]!.scripts ?? []) {
      expect(Buffer.byteLength(s.content ?? "")).toBeLessThanOrEqual(DEFAULT_TECH_BUNDLE_LIMITS.bundleBytes);
    }
    // Detection is not asserted: eight decoy windows per script share the page's room with the real one, by design.
  });

  test("with the reserve and 8 decoy windows per script on a page of 40 scripts, the page total still holds", () => {
    const inputs = build(1, 40, DEFAULT_TECH_BUNDLE_LIMITS, 37);
    expect(bytes(inputs[0]!)).toBeLessThanOrEqual(DEFAULT_TECH_BUNDLE_LIMITS.pageBytes);
  });

  test("over several pages the audit total holds as well", () => {
    const limits: TechBundleLimits = { ...DEFAULT_TECH_BUNDLE_LIMITS, auditBytes: 700 * 1024 };
    const inputs = build(3, 14, limits, 30);
    let total = 0;
    for (const input of inputs) {
      expect(bytes(input)).toBeLessThanOrEqual(limits.pageBytes);
      total += bytes(input);
    }
    expect(total).toBeLessThanOrEqual(limits.auditBytes);
  });

  test("a tight page budget is never overspent by the windows", () => {
    const limits: TechBundleLimits = { ...DEFAULT_TECH_BUNDLE_LIMITS, pageBytes: 96 * 1024 };
    const inputs = build(1, 20, limits, 10);
    expect(bytes(inputs[0]!)).toBeLessThanOrEqual(limits.pageBytes);
  });
});
