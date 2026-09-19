import { describe, expect, test } from "bun:test";
import { playwrightRuntimeFromModule } from "./browser-runtime.ts";
import type { Browser } from "playwright";

// The loader's guard only checks that chromium.launch is a function, so the
// launch result is never touched here. A double stands in for the real Browser.
const browserDouble = {} as Browser;
const chromium = { launch: async () => browserDouble };

describe("browser runtime loader", () => {
  test("accepts Bun's named CommonJS exports", () => {
    expect(playwrightRuntimeFromModule({ chromium })).toEqual({ chromium });
  });

  test("accepts Node ESM's default CommonJS export", () => {
    expect(playwrightRuntimeFromModule({ default: { chromium } })).toEqual({ chromium });
  });

  test("rejects a module without a launchable Chromium runtime", () => {
    expect(() => playwrightRuntimeFromModule({ default: {} })).toThrow("chromium.launch");
  });
});
