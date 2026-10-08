// The error-shell signal survives the DOM release as a scalar (#235).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { detectSoft404, parsePage, type Soft404Input } from "../src/index";

const URL = "https://example.com/gone";
const SHELL = `<!doctype html><html id="__next_error__"><head><title>Acme Store</title></head>
<body><h1>Acme Store</h1><p>Just a few words here.</p></body></html>`;
const PLAIN = SHELL.replace(' id="__next_error__"', "");

const input = (html: string, over: Partial<Soft404Input> = {}): Soft404Input => {
  const parsed = parsePage(html, URL);
  return {
    statusCode: 200,
    document: parsed.document,
    title: parsed.meta?.title,
    h1Texts: parsed.h1?.texts,
    robotsMeta: parsed.meta?.robots,
    wordCount: parsed.content?.wordCount,
    ...over,
  };
};

describe("detectSoft404 with the captured errorShell scalar", () => {
  test("the issue repro: a released document loses the signal, the scalar restores it", () => {
    const live = detectSoft404(input(SHELL));
    expect(live.isSoft404).toBe(true);
    expect(live.signals.map((s) => s.name)).toEqual(["error-shell", "tiny-content"]);

    const released = input(SHELL, { document: null });
    expect(detectSoft404(released).isSoft404).toBe(false);

    const scalar = detectSoft404({ ...released, errorShell: parsePage(SHELL, URL).errorShell });
    expect(scalar).toEqual(live);
  });

  test("negative control: the scalar is false for a page with no marker and changes nothing", () => {
    expect(parsePage(PLAIN, URL).errorShell).toBe(false);
    const withScalar = detectSoft404({ ...input(PLAIN, { document: null }), errorShell: false });
    expect(withScalar).toEqual(detectSoft404(input(PLAIN)));
    expect(withScalar.isSoft404).toBe(false);
  });

  test("an absent scalar is the old DOM-only behaviour", () => {
    expect(detectSoft404(input(SHELL, { errorShell: undefined })).isSoft404).toBe(true);
    expect(detectSoft404(input(SHELL, { document: null, errorShell: undefined })).isSoft404).toBe(
      false
    );
  });

  test("the existing fixture gives the identical result with or without the scalar", () => {
    const html = readFileSync(join(import.meta.dir, "fixtures", "soft-404-next-error.html"), "utf8");
    const parsed = parsePage(html, URL);
    const withDom = detectSoft404(input(html));
    expect(detectSoft404(input(html, { errorShell: parsed.errorShell }))).toEqual(withDom);
    expect(detectSoft404(input(html, { document: null, errorShell: parsed.errorShell }))).toEqual(
      withDom
    );
  });
});
