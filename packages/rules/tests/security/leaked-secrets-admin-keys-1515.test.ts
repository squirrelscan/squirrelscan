// security/leaked-secrets: the tier of a hosted-search key follows the name it is held under (#1515).
// An admin-named variable holding a provider-shaped key is a high; a search-named one stays medium with the search-only hint;
// a Meilisearch master key is high and a search key is found with the hint. Every value is built at runtime from parts.

import { describe, expect, test } from "bun:test";

import { scanContent } from "../../src/security/leaked-secrets";
import { mixedRun, runOf, seededRng } from "./leaked-secrets/generators";

const HEX = "0123456789abcdef";
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PAGE = "https://shop.acme.test/";
const r = seededRng(1515);

const scan = (text: string) => scanContent(text, "inline-script", PAGE);
/** A 32-character value of the given alphabet that opens with a digit (a lowercase-then-capital start reads as a code identifier) and is varied enough to pass the entropy floor. */
const key32 = (alphabet: string): string => reportable(() => `7${runOf(r, alphabet, 31)}`);
/** A value the plain `apiKey` assignment reports (random draws can land under the entropy floor), so the tier is the only thing that varies. */
function reportable(make: () => string): string {
  for (;;) {
    const value = make();
    if (scan(`var c={apiKey:"${value}"};`).length === 1) return value;
  }
}
const summary = (text: string) => scan(text).map((f) => [f.type, f.confidence, f.publicByDesign, typeof f.extra?.hint === "string" ? "hint" : "-"]);

describe("an admin-named variable holding a hosted-search key is high (#1515)", () => {
  test("Algolia's 32-hex and Typesense's 32-character keys under an admin name report at high with an admin hint", () => {
    for (const name of ["search_admin_api_key", "adminApiKey", "admin_api_key", "ALGOLIA_ADMIN_API_KEY", "typesenseAdminApiKey", "searchAdminApiKey"]) {
      for (const value of [key32(HEX), key32(ALNUM)]) {
        const [finding] = scan(`var c={"${name}":"${value}"};`);
        expect([name, finding?.type, finding?.confidence, finding?.publicByDesign]).toEqual([name, "Generic API Key Assignment", "high", false]);
        expect(String(finding?.extra?.hint)).toContain("admin");
      }
    }
  });

  test("the hint says what the tier means and is not the search-only hint", () => {
    const [finding] = scan(`var c={adminApiKey:"${key32(HEX)}"};`);
    expect(String(finding?.extra?.hint)).toContain("write and delete an index");
    expect(String(finding?.extra?.hint)).not.toContain("search-only");
  });

  test("a search name keeps medium with the search-only hint; any other name stays medium without one", () => {
    for (const name of ["search_api_key", "searchApiKey", "typesense_search_api_key", "search-api-key", "typesenseSearchApiKey"]) {
      expect([name, summary(`var c={"${name}":"${key32(ALNUM)}"};`)]).toEqual([name, [["Generic API Key Assignment", "medium", false, "hint"]]]);
    }
    // under a brand's own variable the brand's pattern names it: still medium, never high
    for (const name of ["ALGOLIA_SEARCH_API_KEY", "algoliaSearchApiKey"]) {
      const found = scan(`var c={"${name}":"${key32(HEX)}"};`);
      expect([name, found.length > 0, found.some((f) => f.confidence === "high")]).toEqual([name, true, false]);
    }
    expect(summary(`var c={apiKey:"${key32(HEX)}"};`)).toEqual([["Generic API Key Assignment", "medium", false, "-"]]);
  });

  test("an admin name needs the provider's shape: 31 or 33 characters, or a value with a separator, stay medium", () => {
    for (const make of [() => `7${runOf(r, HEX, 30)}`, () => `7${runOf(r, HEX, 32)}`, () => `7${runOf(r, ALNUM, 14)}_${runOf(r, ALNUM, 16)}`, () => `7${runOf(r, ALNUM, 14)}-${runOf(r, ALNUM, 16)}`]) {
      const value = reportable(make);
      expect([value.length, summary(`var c={adminApiKey:"${value}"};`)]).toEqual([value.length, [["Generic API Key Assignment", "medium", false, "-"]]]);
    }
  });

  test("`admin` is a whole word of the name: `administrator`, `sadmin` and `padmin` do not make it admin", () => {
    for (const name of ["administratorApiKey", "sadminApiKey", "radmin_api_key", "adminsApiKey"]) {
      expect([name, summary(`var c={${name}:"${key32(HEX)}"};`).map((f) => f[1])]).toEqual([name, ["medium"]]);
    }
  });
});

describe("Meilisearch keys (#1515)", () => {
  const key = () => mixedRun(r, 32);

  test("a master key is a high, under any name that says master or admin", () => {
    for (const text of [
      `var c={meilisearch:{host:"x",masterKey:"${key()}"}};`,
      `MEILI_MASTER_KEY="${key()}"`,
      `var meiliMasterKey = "${key()}";`,
      `new MeiliSearch({host:"x",adminKey:"${key()}"});`,
      `<div data-meili-master-key="${key()}"></div>`,
      `MEILISEARCH_MASTER_KEY: "${key()}"`,
    ]) {
      const found = scan(text).filter((f) => f.type.startsWith("Meilisearch"));
      expect([text.slice(0, 40), found.map((f) => [f.type, f.confidence])]).toEqual([text.slice(0, 40), [["Meilisearch Master Key", "high"]]]);
      expect(String(found[0]?.extra?.hint)).toContain("admin key");
    }
  });

  test("a search key is detected as such, at medium, with the search-only hint", () => {
    for (const text of [
      `var c={meilisearch:{host:"x",searchKey:"${key()}"}};`,
      `MEILI_SEARCH_KEY="${key()}"`,
      `var meiliSearchKey = "${key()}";`,
      `var meiliPublicKey = "${key()}";`,
    ]) {
      const found = scan(text).filter((f) => f.type.startsWith("Meilisearch"));
      expect([text.slice(0, 40), found.map((f) => [f.type, f.confidence, f.publicByDesign])]).toEqual([text.slice(0, 40), [["Meilisearch Search Key", "medium", false]]]);
      expect(String(found[0]?.extra?.hint)).toContain("search-only");
    }
  });

  test("the key has to follow the word meili within 40 characters (the keyword gap of every brand pattern)", () => {
    const far = `meilisearch:{host:"https://search.internal.acme.example.test/v1",masterKey:"${key()}"}`;
    expect(scan(far).filter((f) => f.type.startsWith("Meilisearch"))).toEqual([]);
    expect(scan(`meilisearch:{host:"x",masterKey:"${key()}"}`).map((f) => f.type)).toContain("Meilisearch Master Key");
  });

  test("another name is a medium Meilisearch key, never a high", () => {
    const found = scan(`var c={meilisearch:{host:"x",apiKey:"${key()}"}};`);
    expect(found.some((f) => f.confidence === "high")).toBe(false);
    expect(found.length).toBeGreaterThan(0);
  });

  test("the word meili has to be in front of the key: a master key of anything else is not claimed", () => {
    expect(scan(`var c={masterKey:"${key()}"};`).filter((f) => f.type.startsWith("Meilisearch"))).toEqual([]);
    expect(scan(`var c={other:{masterKey:"${key()}"}, note:"${"x".repeat(80)}meilisearch"};`).filter((f) => f.type.startsWith("Meilisearch"))).toEqual([]);
    // fewer than 16 characters is not a key
    expect(scan(`MEILI_MASTER_KEY="${runOf(r, ALNUM, 15)}"`).filter((f) => f.type.startsWith("Meilisearch"))).toEqual([]);
  });
});
