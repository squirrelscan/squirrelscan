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
/** The last reading of a text: the folded one when it differs from the text as written. */
const folded = (text: string): string => digitForms(text).at(-1)!;

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
    expect(folded("1995 2024 10 5 3 100")).toBe("1995 2024 10 5 3 100");
    expect(folded("1995-2024, 2 for 1")).toBe("1995-2024, 2 for 1");
  });
  test("only a token that mixes letters and digits is folded, and 2, 4, 6, 7, 8, 9 are not", () => {
    expect(folded("s1gn")).toBe("sign");
    expect(folded("g00gle")).toBe("google");
    expect(folded("g00g1e")).toBe("google"); // a 1 is an l here and an i in s1gn: the reading that is a cue word wins
    expect(folded("1og1n")).toBe("login"); // l then i
    expect(folded("l0g1n")).toBe("login");
    expect(folded("w1th 1n")).toBe("with in");
    expect(folded("1n")).toBe("in");
    expect(folded("x1y")).toBe("xiy"); // no cue word either way: read with i, not a cue
    expect(folded("11111a")).toBe("iiiiia"); // more than four 1s are all read as i
    expect(folded("abc2")).toBe("abc2");
    expect(folded("a4b7c9")).toBe("a4b7c9");
    expect(folded("2024")).toBe("2024");
    expect(folded("sign 1n")).toBe("sign in");
  });
  test("a word with many 1s is not tried every way: past four it is read with i, in no time", () => {
    const started = performance.now();
    expect(folded(`a${"1".repeat(25)}`)).toBe(`a${"i".repeat(25)}`);
    expect(folded("1a1b1c1d1e")).toBe("iaibicidie"); // five 1s
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


// ── review round: Office365, a bounded fold, the capital lunate sigma, digit swaps in later attribute windows ─────────────────

describe("a cue that contains a digit is read as written as well as folded", () => {
  test("digitForms gives the text as written first, then the fold when it differs", () => {
    expect(digitForms("office365 login")).toEqual(["office365 login", "officee6s login"]);
    expect(digitForms("s1gn")).toEqual(["s1gn", "sign"]);
    expect(digitForms("nothing to fold")).toEqual(["nothing to fold"]);
    expect(digitForms("1995 2024")).toEqual(["1995 2024"]);
    expect(digitForms("office 365")).toEqual(["office 365"]);
  });
  test("Office365 login, Office365 Login and Microsoft Office365 Login to an off-brand host are Microsoft", () => {
    for (const label of ["Office365 login", "Office365 Login", "Microsoft Office365 Login"]) {
      expect([label, brandOf(label)]).toEqual([label, "Microsoft"]);
    }
  });
});

describe("the capital lunate sigma is a c, before NFKC turns it into a sigma", () => {
  test("U+03F9 and U+03F2 through readable and through the detector", () => {
    expect(readable("\u03f9ontinue with Google")).toBe("continue with google");
    expect(readable("\u03f2ontinue with Google")).toBe("continue with google");
    expect(google("\u03f9ontinue with Google")).toBe(true);
    expect(google("\u03f2ontinue with Google")).toBe(true);
    // a real Greek word keeps its sigma
    expect(readable("\u03a3\u03c0\u03b9\u03c4\u03b9")).not.toContain("c");
  });
});

describe("a digit-swapped cue past the first 300 characters of an attribute", () => {
  const filler = "lorem ipsum dolor sit amet ".repeat(40); // 1,080 characters
  test("an aria-label, a title and a value are read in the folded reading", () => {
    for (const attr of ["aria-label", "title"]) {
      const html = `<!doctype html><html><head><title>A</title></head><body><main><a href="${OFF}" ${attr}="${filler} S1gn 1n w1th G00g1e ${filler}"><svg></svg></a></main></body></html>`;
      const parsed = parsePage(html, url);
      const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
      expect([attr, detectBrandImpersonation(ctx)?.brand]).toEqual([attr, "Google"]);
    }
  });
});

describe("limits of the digit fold", () => {
  test("a glued token that needs an l (signinwithg00g1e) is read with i and is not a cue; page text is not folded", () => {
    expect(google("signinwithg00g1e")).toBe(false);
    expect(google("signinwithg00gle")).toBe(true);
    // page text is not digit-folded: the prose near a plain link is not a cue
    expect(brandOf("Google", OFF, "<p>S1gn 1n w1th G00g1e</p>")).toBeNull();
  });
});
