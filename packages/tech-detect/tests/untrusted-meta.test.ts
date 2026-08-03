// `<meta name=…>` is page-controlled, so the auto-extracted meta map is keyed by
// attacker-chosen strings. On a plain `{}` accumulator the `key in out` de-dupe
// guard is satisfied by Object.prototype's own members, which drops those tags
// before any detector sees them.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src/detect";
import type { TechDetectInput } from "../src/types";

const FINGERPRINTS = [
  {
    id: "proto-canary",
    name: "Proto Canary",
    category: "cms" as const,
    detectors: [{ type: "meta" as const, name: "constructor", pattern: /canary/ }],
  },
];

function input(html: string): TechDetectInput {
  return { url: "https://hostile.test/", html, headers: {} };
}

describe("tech-detect meta extraction over untrusted names", () => {
  test("a meta tag named after a prototype member still reaches its detector", () => {
    const detected = detectTechnologies(
      input('<meta name="constructor" content="canary">'),
      FINGERPRINTS
    );
    expect(detected.map((d) => d.id)).toEqual(["proto-canary"]);
  });

  test("hostile meta names do not touch the global prototype", () => {
    const before = Object.getOwnPropertyNames(Object.prototype);
    detectTechnologies(
      input(
        '<meta name="__proto__" content="polluted"><meta name="constructor" content="polluted">' +
          '<meta name="prototype" content="polluted"><meta name="generator" content="WordPress">'
      )
    );
    const added = Object.getOwnPropertyNames(Object.prototype).filter(
      (key) => !before.includes(key)
    );
    for (const key of added) delete (Object.prototype as Record<string, unknown>)[key];
    expect(added).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("a caller-supplied meta map is still honoured", () => {
    const detected = detectTechnologies(
      { ...input("<html></html>"), meta: { constructor: "canary" } },
      FINGERPRINTS
    );
    expect(detected.map((d) => d.id)).toEqual(["proto-canary"]);
  });
});
