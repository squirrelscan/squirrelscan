// #1410: the look-alike fold of the integrity cue matcher completes the letters the issue names, and digit swaps inside a
// word read as the letters they stand for, without turning an ordinary number into a cue. Synthetic page and hosts.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { CONFUSABLES, digitForms } from "../src/integrity/confusables";
import { readable } from "../src/integrity/controls";
import { detectBrandImpersonation } from "../src/integrity/signals";
import type { RuleContext } from "../src/types";

setDefaultTimeout(60_000);

const url = "https://shop.example/";
const OFF = "https://credential-fixture.invalid/signin";
const BRAILLE_BLANK = String.fromCharCode(0x2800);

function brandOf(label: string, href = OFF, body = ""): string | null {
  const html = `<!doctype html><html><head><title>Account</title></head><body><main><h1>Account</h1>${body}<a href="${href}">${label}</a></main></body></html>`;
  const parsed = parsePage(html, url);
  const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
  return detectBrandImpersonation(ctx)?.brand ?? null;
}
const google = (label: string): boolean => brandOf(label) === "Google";

describe("letters that look like Latin letters fold to them", () => {
  test("U+03F2 (c), U+0269 (i), Cyrillic п (n) and г (r), each inside the full cue", () => {
    expect(google("Sign in with Google")).toBe(true); // control: the plain cue
    expect(google("ϲontinue with Google")).toBe(true); // Greek lunate sigma for c
    expect(google("sɩgn ɩn wɩth Google")).toBe(true); // Latin iota for i
    expect(google("sigп іп with Google")).toBe(true); // Cyrillic п for n (і is Cyrillic i)
    expect(brandOf("Sign in with Micгosoft")).toBe("Microsoft"); // Cyrillic г for r
  });
  test("the table maps each of them to the letter", () => {
    expect(readable("ϲontinue")).toBe("continue"); // NFKC turns U+03F2 into the final sigma U+03C2
    expect(CONFUSABLES["ς"]).toBe("c");
    expect(CONFUSABLES["ϲ"]).toBe("c");
    expect(CONFUSABLES["ɩ"]).toBe("i");
    expect(CONFUSABLES["п"]).toBe("n");
    expect(CONFUSABLES["г"]).toBe("r");
  });
  test("a braille blank spliced into the cue is removed", () => {
    expect(google(`Si${BRAILLE_BLANK}gn in with Goo${BRAILLE_BLANK}gle`)).toBe(true);
    expect(readable(`a${BRAILLE_BLANK}b`)).toBe("ab");
  });
});

describe("digit swaps inside a word", () => {
  test("the leetspeak spellings of the cue", () => {
    expect(google("S1gn 1n w1th G00gle")).toBe(true);
    expect(google("S1gn 1n w1th G00g1e")).toBe(true); // the second 1 is an l
    expect(google("5ign in with Google")).toBe(true);
    expect(google("Sign in w1th Google")).toBe(true);
    expect(google("L0g 1n w1th G00gle")).toBe(true);
    expect(google("L0g1n w1th Google")).toBe(true);
    expect(google("C0nt1nue w1th Google")).toBe(true);
    expect(brandOf("S1gn 1n w1th M1cr0soft")).toBe("Microsoft");
    expect(google("Sign 1n with Google")).toBe(true);
    expect(google("S1gn in with Google")).toBe(true);
    expect(google("Sign in with Googl3")).toBe(true); // 3 is an e
  });
  test("an ordinary number in a word is not a cue: prices, years, versions, codes", () => {
    const page = "Prices from 1995 to 2024: 5 items, 10% off, 3 for 2, v1.0, H1 tags, 24h support, 100 in stock, Sign 5 times";
    expect(brandOf("Read more", OFF, `<p>${page}</p>`)).toBeNull();
    expect(brandOf("Download 1.0", OFF, `<p>${page}</p>`)).toBeNull();
    expect(brandOf("Sign in", OFF, `<p>${page}</p>`)).toBeNull(); // no brand
    expect(readable("1995 2024 10 5 3 100")).toBe("1995 2024 10 5 3 100");
    expect(digitForms("1995 2024 10 5 3 100")).toEqual(["1995 2024 10 5 3 100"]);
    expect(digitForms("1995-2024, 2 for 1")).toEqual(["1995-2024, 2 for 1"]);
  });
  test("only a token that mixes letters and digits is folded, and 2, 4, 6, 7, 8, 9 are not", () => {
    expect(digitForms("s1gn")).toEqual(["sign"]);
    expect(digitForms("g00gle")).toEqual(["google"]);
    expect(digitForms("g00g1e")).toEqual(["google"]); // a 1 is an l here and an i in s1gn: the reading that is a cue word wins
    expect(digitForms("1og1n")).toEqual(["login"]); // l then i
    expect(digitForms("l0g1n")).toEqual(["login"]);
    expect(digitForms("w1th 1n")).toEqual(["with in"]);
    expect(digitForms("1n")).toEqual(["in"]);
    expect(digitForms("x1y")).toEqual(["xiy"]); // no cue word either way: read with i, not a cue
    expect(digitForms("11111a")).toEqual(["iiiiia"]); // more than four 1s are all read as i
    expect(digitForms("abc2")).toEqual(["abc2"]);
    expect(digitForms("a4b7c9")).toEqual(["a4b7c9"]);
    expect(digitForms("2024")).toEqual(["2024"]);
    expect(digitForms("sign 1n")).toEqual(["sign in"]);
  });
  test("a word with many 1s is not tried every way: past four it is read with i, in no time", () => {
    const started = performance.now();
    expect(digitForms(`a${"1".repeat(25)}`)).toEqual([`a${"i".repeat(25)}`]);
    expect(digitForms("1a1b1c1d1e")).toEqual(["iaibicidie"]); // five 1s
    expect(performance.now() - started).toBeLessThan(1_000);
  });
  test("a long token of digits and letters costs a linear pass", () => {
    const start = performance.now();
    digitForms("1a".repeat(2_000_000));
    expect(performance.now() - start).toBeLessThan(3_000);
  });
});

describe("other scripts: a Google sign-in link on a Russian, Spanish or German page does not fire", () => {
  test("labels in the page's language, to an off-brand host and to Google itself", () => {
    for (const label of ["Войти через Google", "Iniciar sesión con Google", "Mit Google anmelden", "Continuar con Google", "Войти с помощью Microsoft"]) {
      expect(brandOf(label), label).toBeNull();
      expect(brandOf(label, "https://accounts.google.com/o/oauth2/v2/auth"), label).toBeNull();
    }
  });
});

describe("hostile text stays linear, at 5 MB and at 10 MiB", () => {
  for (const [label, bytes] of [["5 MB", 5_000_000], ["10 MiB", 10 * 1_048_576]] as const) {
    test(`${label} of swapped-digit text on a page with one sign-in link: the whole detector`, () => {
      const unit = "s1gn 1n w1th G00g1e 1995 2024 ";
      const body = `<p>${unit.repeat(Math.ceil(bytes / unit.length))}</p>`;
      const html = `<!doctype html><html><head><title>A</title></head><body><main><h1>A</h1>${body}<a href="${OFF}">S1gn 1n w1th G00g1e</a></main></body></html>`;
      const parsed = parsePage(html, url);
      const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
      const started = performance.now();
      const hit = detectBrandImpersonation(ctx);
      const elapsed = performance.now() - started;
      console.log(`TIMING detector ${label}: ${elapsed.toFixed(0)} ms`);
      expect(hit?.brand).toBe("Google");
      expect(elapsed).toBeLessThan(6_000);
    });
  }

  for (const [label, bytes] of [["5 MB", 5_000_000], ["10 MiB", 10 * 1_048_576]] as const) {
    test(`${label} of mixed digits, look-alikes and blanks in a page's text`, () => {
      const unit = `s1gn ϲonп 0135 ${BRAILLE_BLANK} g00g1e `;
      const body = unit.repeat(Math.ceil(bytes / unit.length));
      const started = performance.now();
      const forms = digitForms(readable(body));
      const elapsed = performance.now() - started;
      console.log(`TIMING ${label}: ${elapsed.toFixed(0)} ms`);
      expect(forms.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(6_000);
    });
  }
});
