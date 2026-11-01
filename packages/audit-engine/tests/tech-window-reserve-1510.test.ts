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
