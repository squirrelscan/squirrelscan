// core/meta-description: the Latin length floor is not applied to CJK or Thai text (pub#1866).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { metaDescriptionRule } from "../src/core/meta-description";
import type { ParsedPage, RuleContext } from "../src/types";

const URL = "https://example.com/";

async function run(description: string | null, lang = "en"): Promise<CheckResult[]> {
  const meta = description === null ? "" : `<meta name="description" content="${description}">`;
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>T</title>${meta}</head><body><h1>x</h1></body></html>`;
  const ctx: RuleContext = {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL) as ParsedPage,
    options: {},
  };
  return (await metaDescriptionRule.run(ctx)).checks as CheckResult[];
}

const get = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name)!;

const ZH = "真皮租借保齡球鞋，EU 尺寸 24–52，自 2003 年起供應保齡球館。可採用您的配色並加上您的標";
const JA = "本革のレンタルボウリングシューズ。サイズは24から52まで、2003年からボウリング場に提供しています。";
const KO = "가죽 대여 볼링화입니다. 사이즈는 24부터 52까지 있으며 2003년부터 볼링장에 공급하고 있습니다.";
const TH = "รองเท้าโบว์ลิ่งหนังแท้สำหรับเช่า ขนาด 24 ถึง 52 จัดจำหน่ายให้ลานโบว์ลิ่งตั้งแต่ปี 2003";

describe("core/meta-description script awareness", () => {
  test.each([
    ["zh-CN", ZH],
    ["ja", JA],
    ["ko", KO],
    ["th", TH],
  ])("complete %s description skips the floor", async (lang, text) => {
    const check = get(await run(text, lang), "meta-description-too-short");
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("Latin");
  });

  test("140-character English description passes", async () => {
    const check = get(await run("a".repeat(70) + " " + "b".repeat(69)), "meta-description-too-short");
    expect(check.status).toBe("pass");
  });

  test("short English description still warns", async () => {
    const check = get(await run("Short English description."), "meta-description-too-short");
    expect(check.status).toBe("warn");
  });

  test("300-character Korean description still warns too long", async () => {
    const check = get(await run("가".repeat(300), "ko"), "meta-description-too-long");
    expect(check.status).toBe("warn");
  });

  test.each(["en", "zh-CN", "ko"])("missing description reported for %s", async (lang) => {
    const checks = await run(null, lang);
    expect(get(checks, "meta-description").status).toBe("fail");
  });
});
