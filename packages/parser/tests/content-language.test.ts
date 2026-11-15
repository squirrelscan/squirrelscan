// Content-language detection behind the LanguageDetector interface
// (squirrelscan/repo#2360): the floor wrapper abstains on short and
// low-confidence text, the franc detector names the language of plain prose,
// and the per-page view is lazy, memoised and reads only the main content.
// Every sample sentence here was written for this test.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "../src/dom";
import {
  CONTENT_LANGUAGE_MAX_CHARS,
  CONTENT_LANGUAGE_MIN_CHARS,
  CONTENT_LANGUAGE_MIN_CONFIDENCE,
  createContentLanguageView,
  createFrancDetector,
  detectContentLanguage,
  FRANC_WEB_LANGUAGES,
  normalizeLanguageTag,
  withLanguageFloor,
  type DetectedLanguage,
  type LanguageDetector,
} from "../src/language";

const EN =
  "The squirrel buried twelve acorns under the old oak tree before the first snow of winter arrived in the valley.";
const DE =
  "Das Eichhörnchen hat vor dem ersten Schnee zwölf Eicheln unter der alten Eiche im Garten vergraben, weil es den Winter fürchtet.";
const FR =
  "L'écureuil a caché douze glands sous le vieux chêne avant que la première neige de l'hiver ne tombe sur la vallée.";
const ES =
  "La ardilla escondió doce bellotas debajo del viejo roble antes de que llegara la primera nieve del invierno al valle. Después durmió todo el día en su nido, mientras los niños del pueblo jugaban con trineos en la colina.";

/** A detector that always answers the same thing and counts its calls. */
function fixed(result: DetectedLanguage | null): LanguageDetector & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "fixed",
    calls,
    detectLanguage(text) {
      calls.push(text);
      return result;
    },
  };
}

describe("withLanguageFloor", () => {
  test("abstains below the length floor without calling the inner detector", () => {
    const inner = fixed({ lang: "en", confidence: 1 });
    const d = withLanguageFloor(inner, { minChars: 10, minConfidence: 0 });
    expect(d.detectLanguage("   short  ")).toBeNull();
    expect(inner.calls).toHaveLength(0);
  });

  test("abstains below the confidence floor and answers at or above it", () => {
    const floor = { minChars: 1, minConfidence: 0.5 };
    expect(withLanguageFloor(fixed({ lang: "en", confidence: 0.49 }), floor).detectLanguage(EN)).toBeNull();
    expect(withLanguageFloor(fixed({ lang: "en", confidence: 0.5 }), floor).detectLanguage(EN)).toEqual({
      lang: "en",
      confidence: 0.5,
    });
  });

  test("abstains on a NaN confidence and when the inner detector abstains", () => {
    const floor = { minChars: 1, minConfidence: 0 };
    expect(withLanguageFloor(fixed({ lang: "en", confidence: Number.NaN }), floor).detectLanguage(EN)).toBeNull();
    expect(withLanguageFloor(fixed(null), floor).detectLanguage(EN)).toBeNull();
  });

  test("hands the inner detector collapsed, capped text", () => {
    const inner = fixed({ lang: "en", confidence: 1 });
    withLanguageFloor(inner, { minChars: 1, minConfidence: 0 }).detectLanguage(
      `  a\n\n b\t${"x".repeat(CONTENT_LANGUAGE_MAX_CHARS * 2)}`,
    );
    expect(inner.calls[0].startsWith("a b x")).toBe(true);
    expect(inner.calls[0]).toHaveLength(CONTENT_LANGUAGE_MAX_CHARS);
  });

  test("the default floor uses the placeholder constants", () => {
    const inner = fixed({ lang: "en", confidence: CONTENT_LANGUAGE_MIN_CONFIDENCE });
    const d = withLanguageFloor(inner);
    expect(d.detectLanguage("a".repeat(CONTENT_LANGUAGE_MIN_CHARS - 1))).toBeNull();
    expect(d.detectLanguage("a".repeat(CONTENT_LANGUAGE_MIN_CHARS))).not.toBeNull();
  });
});

describe("franc detector", () => {
  test.each([
    ["en", EN],
    ["de", DE],
    ["fr", FR],
    ["es", ES],
  ])("names %s prose with an ISO 639-1 code", (lang, text) => {
    const result = detectContentLanguage(text);
    expect(result?.lang).toBe(lang);
    expect(result!.confidence).toBeGreaterThan(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });

  test("the production detector abstains on short text and on text with no letters", () => {
    expect(detectContentLanguage("Hello there")).toBeNull();
    expect(detectContentLanguage("12345 67890 ".repeat(10))).toBeNull();
    expect(detectContentLanguage("")).toBeNull();
  });

  test("the raw detector restricted to the web list returns only listed languages", () => {
    const raw = createFrancDetector({ only: FRANC_WEB_LANGUAGES });
    expect(raw.id).toBe("franc");
    expect(createFrancDetector().id).toBe("franc-all");
    expect(raw.detectLanguage(EN)?.lang).toBe("en");
  });
});

describe("normalizeLanguageTag", () => {
  test("folds region subtags, case and deprecated aliases", () => {
    expect(normalizeLanguageTag("en-US")).toBe("en");
    expect(normalizeLanguageTag("PT_br")).toBe("pt");
    expect(normalizeLanguageTag("iw")).toBe("he");
    expect(normalizeLanguageTag("no")).toBe("nb");
    expect(normalizeLanguageTag("")).toBeNull();
    expect(normalizeLanguageTag("x")).toBeNull();
    expect(normalizeLanguageTag(undefined)).toBeNull();
  });
});

describe("createContentLanguageView", () => {
  const page = (body: string) => ({
    document: parseHTML(`<html lang="en"><body>${body}</body></html>`).document,
  });

  test("detects the main content, not the declared language or the chrome", () => {
    const view = createContentLanguageView(
      page(`<nav>${EN} ${EN}</nav><main><p>${DE}</p><p>${DE}</p></main><footer>${EN}</footer>`),
    );
    expect(view.detectorId).toBe("franc");
    expect(view.page()?.lang).toBe("de");
  });

  test("reports per-block languages in document order, outermost block only", () => {
    const view = createContentLanguageView(
      page(`<main><h1>Hi</h1><p>${EN}</p><ul><li><p>${FR}</p></li></ul><pre>${ES}</pre><p>${ES}</p></main>`),
    );
    const blocks = view.blocks();
    expect(blocks.map((b) => b.tag)).toEqual(["h1", "p", "li", "p"]);
    expect(blocks.map((b) => b.language?.lang ?? null)).toEqual([null, "en", "fr", "es"]);
    expect(blocks.map((b) => b.index)).toEqual([0, 1, 2, 3]);
  });

  test("is lazy and memoised: nothing runs until asked, then at most once", () => {
    const inner = fixed({ lang: "xx", confidence: 1 });
    const view = createContentLanguageView(page(`<main><p>${EN}</p><p>${FR}</p></main>`), inner);
    expect(inner.calls).toHaveLength(0);
    expect(view.page()).toEqual({ lang: "xx", confidence: 1 });
    view.page();
    expect(inner.calls).toHaveLength(1);
    view.blocks();
    view.blocks();
    expect(inner.calls).toHaveLength(3);
  });

  test("abstention surfaces as null at page and block level", () => {
    const view = createContentLanguageView(page(`<main><p>${EN}</p></main>`), fixed(null));
    expect(view.page()).toBeNull();
    expect(view.blocks()[0].language).toBeNull();
  });

  test("without a DOM it reads stored text content and reports no blocks", () => {
    const view = createContentLanguageView({ document: null, content: { textContent: `${FR} ${FR}` } });
    expect(view.page()?.lang).toBe("fr");
    expect(view.blocks()).toEqual([]);
    expect(createContentLanguageView({ document: null }).page()).toBeNull();
  });
});
