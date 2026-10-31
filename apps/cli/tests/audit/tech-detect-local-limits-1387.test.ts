// #1387: the local tech scan reads bundles whole (8 MB by default); the cloud payload keeps its
// small caps. `[tech_detect] bundle_bytes` sets the per-bundle cap for both.

import type { Config } from "@squirrelscan/config";

import { describe, expect, test } from "bun:test";

import { localTechBundleLimits, techBundleLimits } from "../../src/audit/cloud";

const MB = 1024 * 1024;
const cfg = (bundleBytes?: number) =>
  ({
    tech_detect:
      bundleBytes === undefined ? undefined : { bundle_bytes: bundleBytes },
  }) as unknown as Config;

describe("tech-detect limits (#1387)", () => {
  test("unset: the local scan reads 8 MB a bundle, the cloud payload 64 KB", () => {
    expect(localTechBundleLimits(cfg()).bundleBytes).toBe(8 * MB);
    expect(techBundleLimits(cfg()).bundleBytes).toBe(64 * 1024);
  });

  test("the local page and audit budgets are far above the cloud ones", () => {
    const local = localTechBundleLimits(cfg());
    const cloud = techBundleLimits(cfg());
    expect(local.pageBytes).toBeGreaterThan(cloud.pageBytes * 8);
    expect(local.auditBytes).toBeGreaterThan(cloud.auditBytes * 8);
  });

  test("bundle_bytes sets both, up to 8 MB and beyond", () => {
    expect(localTechBundleLimits(cfg(8 * MB)).bundleBytes).toBe(8 * MB);
    expect(techBundleLimits(cfg(8 * MB)).bundleBytes).toBe(8 * MB);
    expect(localTechBundleLimits(cfg(0)).bundleBytes).toBe(0);
  });
});
