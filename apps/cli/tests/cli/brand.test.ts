// #2367: the header is one piece of art for the CLI and both installers.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { stripVTControlCharacters as strip } from "node:util";

import {
  renderHeader,
  renderSquirrel,
  rgbTo256,
  squirrelWidth,
} from "@/cli/brand";

const ESC = "\u001b[";

describe("renderSquirrel", () => {
  test("the silhouette is the website hero squirrel: 7 rows, 14 columns", () => {
    const lines = renderSquirrel(0);
    expect(lines).toHaveLength(7);
    expect(squirrelWidth()).toBe(14);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(14);
  });

  test("levels 0 and 1 carry no escapes and keep the eye as a hole", () => {
    for (const level of [0, 1] as const) {
      const art = renderSquirrel(level).join("\n");
      expect(art.includes(ESC)).toBe(false);
      expect(art).toContain("▀"); // the eye row: body pixel over the empty eye
    }
  });

  test("truecolor and 256-colour art draw the same glyphs as the silhouette", () => {
    const glyphs = (lines: string[]) =>
      lines.map((l) => strip(l).replace(/[█▄▀]/g, "#"));
    expect(glyphs(renderSquirrel(3))).toEqual(glyphs(renderSquirrel(2)));
    expect(renderSquirrel(3).join("")).toContain("38;2;");
    expect(renderSquirrel(2).join("")).toContain("38;5;");
  });
});

describe("renderHeader", () => {
  test("wordmark, version and tagline sit beside the squirrel", () => {
    const text = strip(
      renderHeader({ level: 3, unicode: true, version: "v1.2.3" })
    );
    expect(text).toContain("squirrelscan  v1.2.3");
    expect(text).toContain("The website QA tool for your coding agent");
  });

  test("no unicode: text lines only", () => {
    expect(renderHeader({ level: 0, unicode: false })).toBe(
      "  squirrelscan\n  The website QA tool for your coding agent"
    );
  });

  test("a subtitle replaces the tagline", () => {
    const text = strip(
      renderHeader({
        level: 0,
        unicode: true,
        subtitle: "Let's get you set up.",
      })
    );
    expect(text).toContain("Let's get you set up.");
    expect(text).not.toContain("coding agent");
  });
});

test("rgbTo256 maps the brand browns into the colour cube", () => {
  expect(rgbTo256([0, 0, 0])).toBe(16);
  expect(rgbTo256([255, 255, 255])).toBe(231);
  expect(rgbTo256([205, 133, 63])).toBe(173);
});

test("install.sh and install.ps1 carry the current header (sync-install-header --check)", () => {
  const script = join(
    import.meta.dir,
    "../../../../scripts/sync-install-header.ts"
  );
  const run = Bun.spawnSync(["bun", "run", script, "--check"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
});
