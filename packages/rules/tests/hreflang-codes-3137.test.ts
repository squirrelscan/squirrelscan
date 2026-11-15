// squirrelscan/repo#3137: i18n/hreflang validates the format of each hreflang
// code (x-default, or language[-script][-region]). Code format only.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { hreflangRule } from "../src/i18n/hreflang";
import type { RuleContext } from "../src/types";

const URL_ = "https://example.com/";

async function run(codes: string[]) {
  const links = codes
    .map((c) => `<link rel="alternate" hreflang="${c}" href="${URL_}${c}">`)
    .join("");
  const html = `<!doctype html><html lang="en"><head><title>t</title>${links}<link rel="alternate" hreflang="x-default" href="${URL_}"></head><body></body></html>`;
  const ctx = {
    page: { url: URL_, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL_),
    options: {},
  } as unknown as RuleContext;
  return (await hreflangRule.run(ctx)).checks;
}

async function invalid(codes: string[]) {
  const c = (await run(codes)).find((x) => x.name === "hreflang-codes");
  return c?.items?.map((i) => i.id) ?? [];
}

describe("i18n/hreflang code validation (#3137)", () => {
  test("valid codes pass with no code check", async () => {
    const codes = [
      "en",
      "en-US",
      "en-gb",
      "de-AT",
      "pt-BR",
      "zh-Hant-TW",
      "zh-hans",
      "es-419",
      "fil",
      "yue-HK",
      "uk",
      "ja",
    ];
    expect(await invalid(codes)).toEqual([]);
    expect((await run(codes)).map((c) => c.name)).not.toContain("hreflang-codes");
  });

  test("x-default is case-insensitive", async () => {
    expect(await invalid(["X-Default"])).toEqual([]);
  });

  test("case variants are accepted", async () => {
    expect(await invalid(["EN", "En-us", "EN-GB", "ZH-hant-tw"])).toEqual([]);
  });

  test("legacy language codes iw, in, ji are accepted", async () => {
    expect(await invalid(["iw", "in", "ji", "iw-IL"])).toEqual([]);
  });

  test("invalid language is flagged", async () => {
    expect(await invalid(["xx", "english", "e", "xx-US"])).toEqual(["xx", "english", "e", "xx-US"]);
  });

  test("invalid region is flagged; uk as a region suggests GB", async () => {
    const c = (await run(["en-uk", "en-ZZ"])).find((x) => x.name === "hreflang-codes");
    expect(c?.status).toBe("warn");
    expect(c?.items?.map((i) => i.id)).toEqual(["en-uk", "en-ZZ"]);
    expect(c?.items?.[0]?.label).toContain("en-GB");
    expect(c?.message).toBe("2 invalid hreflang code(s): en-uk, en-ZZ");
  });

  test("uk as a language is not flagged", async () => {
    expect(await invalid(["uk", "uk-UA"])).toEqual([]);
  });

  test("underscore is flagged with a hyphenated suggestion", async () => {
    const c = (await run(["en_US", "zh_hant_TW"])).find((x) => x.name === "hreflang-codes");
    expect(c?.items?.map((i) => i.id)).toEqual(["en_US", "zh_hant_TW"]);
    expect(c?.items?.[0]?.label).toContain("use en-US");
  });

  test("script subtag is accepted case-insensitively; bad shapes are flagged", async () => {
    expect(await invalid(["sr-Latn", "sr-LATN-RS", "sr-latn"])).toEqual([]);
    expect(await invalid(["en-US-x", "en-Latn-US-1996", "en-1"])).toEqual([
      "en-US-x",
      "en-Latn-US-1996",
      "en-1",
    ]);
  });

  test("UN M.49 numeric region is accepted", async () => {
    expect(await invalid(["es-419", "en-150"])).toEqual([]);
  });

  test("existing checks are unchanged: pass check lists every code, the x-default self reference still counts", async () => {
    const checks = await run(["en_US"]);
    const pass = checks.find((c) => c.name === "hreflang");
    expect(pass?.status).toBe("pass");
    expect(pass?.items?.map((i) => i.id)).toEqual(["en_US", "x-default"]);
    expect(checks.map((c) => c.name)).not.toContain("hreflang-self");
  });
});
