// #1510: on a page with dozens of scripts the floor pass (a 16 KB head each, in plan order) spent the whole page
// budget before the later scripts, so a small script whose vendor literal lies past its head was never shown to
// detection. The floor pass now leaves a reserve for hint windows, and a script it left no head gets its windows first.
// Scripts and hosts are synthetic.

import { describe, expect, test } from "bun:test";

import { buildTechInputs, DEFAULT_TECH_BUNDLE_LIMITS, detectReportTechnologiesMulti } from "../src/technologies";

const HOME = "https://example.com/";
const LOADER = 't.src="https://www.clarity.ms/tag/"+i;';

function filler(bytes: number, seed = 0): string {
  const unit = `function f${seed}(x){let y=x*3+${seed};return y&255}\n`;
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/** A script of `size` bytes with the loader at `at`. */
function withLoader(size: number, at: number): string {
  const head = filler(at);
  return `${head}${LOADER}${filler(size - at - LOADER.length, 99)}`.slice(0, size);
}

interface Spec {
  count: number;
  size: number;
  target: number;
}

function inputsFor({ count, size, target }: Spec, limits = DEFAULT_TECH_BUNDLE_LIMITS) {
  const scripts = Array.from({ length: count }, (_, i) => ({
    url: `https://example.com/s${i}.js`,
    content: i === target ? withLoader(28_800, 16_600) : filler(size, i + 1),
    sourcePages: [HOME],
  }));
  const html = `<!doctype html><div id="root"></div>${scripts.map((s) => `<script src="${s.url}"></script>`).join("")}`;
  return { scripts, inputs: buildTechInputs([{ url: HOME, headers: {}, html }], scripts, limits) };
}

const SHAPE: Spec = { count: 36, size: 75_000, target: 31 };
const ids = (inputs: ReturnType<typeof buildTechInputs>): string[] => detectReportTechnologiesMulti(inputs).items.map((t) => t.id);

describe("a small script late in a crowded page", () => {
  test("its hint literal past the floor head is detected", () => {
    const { inputs } = inputsFor(SHAPE);
    expect(ids(inputs)).toContain("clarity");
  });

  test("it is found wherever it sits in the plan, after the floors would have run out", () => {
    for (const target of [28, 31, 33, 35]) {
      expect(ids(inputsFor({ ...SHAPE, target }).inputs), `position ${target}`).toContain("clarity");
    }
  });

  test("the page budget still holds: the bodies attached to the page total at most pageBytes", () => {
    const { inputs } = inputsFor(SHAPE);
    const total = (inputs[0]!.scripts ?? []).reduce((sum, s) => sum + Buffer.byteLength(s.content ?? ""), 0);
    expect(total).toBeLessThanOrEqual(DEFAULT_TECH_BUNDLE_LIMITS.pageBytes);
  });

  test("the scripts before the reserve keep their full floor head", () => {
    const { inputs, scripts } = inputsFor(SHAPE);
    const first = inputs[0]!.scripts!.find((s) => s.url === scripts[0]!.url)!;
    expect(first.content!.startsWith(scripts[0]!.content.slice(0, 16 * 1024))).toBe(true);
  });

  test("it is attached to one page only: a second page that references it does not get a second copy", () => {
    const { scripts } = inputsFor(SHAPE);
    const html = (src: string[]) => `<!doctype html>${src.map((u) => `<script src="${u}"></script>`).join("")}`;
    const urls = scripts.map((s) => s.url);
    const withPages = scripts.map((s) => ({ ...s, sourcePages: [HOME, "https://example.com/two"] }));
    const inputs = buildTechInputs(
      [
        { url: HOME, headers: {}, html: html(urls) },
        { url: "https://example.com/two", headers: {}, html: html(urls) },
      ],
      withPages,
    );
    const target = scripts[SHAPE.target]!.url;
    const holders = inputs.filter((i) => i.scripts?.some((s) => s.url === target && s.content));
    expect(holders).toHaveLength(1);
  });
});

/** Scripts whose attached body starts with the first 16 KB of the original: they got their floor head. */
function headed(spec: Spec, limits = DEFAULT_TECH_BUNDLE_LIMITS): number {
  const { inputs, scripts } = inputsFor(spec, limits);
  const bodies = new Map((inputs[0]!.scripts ?? []).map((s) => [s.url, s.content ?? ""]));
  return scripts.filter((s) => (bodies.get(s.url) ?? "").startsWith(s.content.slice(0, 16 * 1024))).length;
}

describe("the reserve is held only when the floors would not fit (#1510)", () => {
  test("29 to 32 scripts: the floors fit 512 KB (not 448 KB), so every script keeps its head as before", () => {
    for (const count of [29, 30, 32]) expect(headed({ count, size: 75_000, target: 3 }), `${count} scripts`).toBe(count);
  });

  test("33 scripts do not fit: the reserve holds back 64 KB, so 28 scripts get the head", () => {
    expect(headed({ count: 33, size: 75_000, target: 3 })).toBe(28);
    expect(headed(SHAPE)).toBe(28);
  });

  test("many small scripts: a script's floor is its own size, so the demand is the real one and the reserve is not held", () => {
    // 40 x 11.5 KB and one big script last: the real floors total 476 KB and fit 512 KB; counting 16 KB for each small
    // script would read 656 KB and hold the reserve, which would starve the last ones.
    const small = Array.from({ length: 40 }, (_, i) => ({ url: `https://example.com/m${i}.js`, content: filler(11_500, i + 1), sourcePages: [HOME] }));
    const big = { url: "https://example.com/big.js", content: filler(200_000, 77), sourcePages: [HOME] };
    const scripts = [...small, big];
    const html = `<!doctype html>${scripts.map((x) => `<script src="${x.url}"></script>`).join("")}`;
    const [home] = buildTechInputs([{ url: HOME, headers: {}, html }], scripts);
    const bodies = new Map((home!.scripts ?? []).map((x) => [x.url, x.content ?? ""]));
    for (const x of small) expect(bodies.get(x.url), x.url).toBe(x.content);
    expect(bodies.get(big.url)!.startsWith(big.content.slice(0, 16 * 1024))).toBe(true);
  });

  test("demand exactly equal to the room does not hold the reserve; one script more does", () => {
    const at = { ...DEFAULT_TECH_BUNDLE_LIMITS, pageBytes: 256 * 1024 };
    expect(headed({ count: 16, size: 75_000, target: 3 }, at)).toBe(16); // 16 x 16 KB = 256 KB: fits
    expect(headed({ count: 17, size: 75_000, target: 3 }, at)).toBe(12);
  });

  test("at exactly four times the reserve the reserve applies; below it the budget is shared as before", () => {
    const at = { ...DEFAULT_TECH_BUNDLE_LIMITS, pageBytes: 256 * 1024 };
    const below = { ...DEFAULT_TECH_BUNDLE_LIMITS, pageBytes: 256 * 1024 - 1 };
    const small = { ...DEFAULT_TECH_BUNDLE_LIMITS, pageBytes: 128 * 1024 };
    expect(headed({ count: 20, size: 75_000, target: 3 }, at)).toBe(12); // (256 - 64) / 16
    expect(headed({ count: 20, size: 75_000, target: 3 }, below)).toBe(15); // no reserve: 255.99 / 16
    expect(headed({ count: 20, size: 75_000, target: 3 }, small)).toBe(8); // no reserve: 128 / 16
  });
});

describe("a page whose floors fit is unchanged", () => {
  test("few scripts: every script is read to its floor and the target is found as before", () => {
    const { inputs, scripts } = inputsFor({ count: 8, size: 75_000, target: 5 });
    expect(ids(inputs)).toContain("clarity");
    const head = inputs[0]!.scripts!.find((s) => s.url === scripts[0]!.url)!;
    expect(head.content!.startsWith(scripts[0]!.content.slice(0, 16 * 1024))).toBe(true);
  });

  test("scripts that all fit whole are attached whole", () => {
    const { inputs, scripts } = inputsFor({ count: 4, size: 2_000, target: 2 });
    for (const s of scripts) {
      if (s.content.length === 28_800) continue;
      expect(inputs[0]!.scripts!.find((x) => x.url === s.url)!.content).toBe(s.content);
    }
  });
});
