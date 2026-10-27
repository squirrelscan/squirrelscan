import { describe, expect, test } from "bun:test";

import { buildJavascriptShipped, type JavascriptShippedInput } from "../src/javascript-shipped";

const script = (
  url: string,
  sizeBytes: number | null,
  sourcePages: string[],
  status: number | null = 200,
): JavascriptShippedInput => ({ url, sizeBytes, status, sourcePages });

describe("buildJavascriptShipped (squirrelscan/repo#3397)", () => {
  test("totals distinct measured scripts and ranks the heaviest pages", () => {
    const js = buildJavascriptShipped({
      sameSite: [
        script("https://e.test/_next/static/chunks/main.js", 4000, ["https://e.test/", "https://e.test/a"]),
        script("https://e.test/_next/static/chunks/page.js", 2000, ["https://e.test/a"]),
        script("https://e.test/app.js", 1000, ["https://e.test/b"]),
        // Listed twice: counted once.
        script("https://e.test/app.js", 1000, ["https://e.test/b"]),
      ],
      thirdParty: [script("https://cdn.other.test/widget.js", 500, ["https://e.test/"])],
    });
    expect(js).toEqual({
      scripts: 4,
      bytes: 7500,
      thirdPartyBytes: 500,
      unmeasured: 0,
      framework: { id: "nextjs", name: "Next.js", bytes: 6000 },
      heaviestPages: [
        { url: "https://e.test/a", bytes: 6000, scripts: 2 },
        { url: "https://e.test/", bytes: 4500, scripts: 2 },
        { url: "https://e.test/b", bytes: 1000, scripts: 1 },
      ],
    });
  });

  test("failed, sizeless and capped scripts are unmeasured, not counted", () => {
    const js = buildJavascriptShipped({
      sameSite: [
        script("https://e.test/ok.js", 100, ["https://e.test/"]),
        script("https://e.test/missing.js", 900, ["https://e.test/"], 404),
        script("https://e.test/no-size.js", null, ["https://e.test/"]),
        script("https://e.test/zero.js", 0, ["https://e.test/"]),
        script("https://e.test/no-status.js", 50, ["https://e.test/"], null),
      ],
      unmeasuredCapped: 3,
    });
    expect(js?.scripts).toBe(1);
    expect(js?.bytes).toBe(100);
    expect(js?.unmeasured).toBe(7);
  });

  test("no measured script means no block", () => {
    expect(buildJavascriptShipped({ sameSite: [] })).toBeUndefined();
    expect(
      buildJavascriptShipped({
        sameSite: [script("https://e.test/missing.js", 10, [], 500)],
        unmeasuredCapped: 4,
      }),
    ).toBeUndefined();
  });

  test("a runtime is named only from its own chunk path, never from a third party", () => {
    const sameSitePlain = buildJavascriptShipped({
      sameSite: [script("https://e.test/js/next.js", 100, ["https://e.test/"])],
      thirdParty: [script("https://cdn.test/_next/static/x.js", 100, ["https://e.test/"])],
    });
    expect(sameSitePlain?.framework).toBeUndefined();
    for (const [path, id] of [
      ["/_nuxt/entry.js", "nuxt"],
      ["/_astro/client.js", "astro"],
      ["/_app/immutable/start.js", "sveltekit"],
    ] as const) {
      const js = buildJavascriptShipped({
        sameSite: [script(`https://e.test${path}`, 100, ["https://e.test/"])],
      });
      expect(js?.framework?.id).toBe(id);
    }
  });

  test("at most three pages, ties broken by URL", () => {
    const pages = ["https://e.test/d", "https://e.test/c", "https://e.test/b", "https://e.test/a"];
    const js = buildJavascriptShipped({
      sameSite: [script("https://e.test/shared.js", 100, pages)],
    });
    expect(js?.heaviestPages.map((page) => page.url)).toEqual([
      "https://e.test/a",
      "https://e.test/b",
      "https://e.test/c",
    ]);
  });
});
