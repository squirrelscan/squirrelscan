// A rule that declares a per-page gate can never be fanned across a template cluster: whether a
// page is soft-404, noindex or (pub#841) classified contact or legal is per page, and a gated
// representative would otherwise hand its skip to healthy members.

import { describe, expect, test } from "bun:test";

import { loadAllRules } from "@squirrelscan/rules";

import { fannableRules } from "../src/template-fanout";

const template = [...loadAllRules().values()].find((r) => r.meta.verdictScope === "template")!;
const withMeta = (id: string, extra: Record<string, unknown>) => ({
  ...template,
  meta: { ...template.meta, id, ...extra },
});

describe("fannableRules", () => {
  test("a template-scoped rule with no gate is fannable", () => {
    expect(fannableRules([withMeta("plugin/plain", {})]).map((r) => r.meta.id)).toEqual(["plugin/plain"]);
  });

  test.each([
    ["skipOnSoft404", { skipOnSoft404: true }],
    ["skipOnNoindex", { skipOnNoindex: true }],
    ["skipOnPageType", { skipOnPageType: ["contact"] }],
  ])("%s disqualifies a template-scoped rule", (_name, extra) => {
    expect(fannableRules([withMeta("plugin/gated", extra)])).toEqual([]);
  });

  test("an empty skipOnPageType list gates nothing", () => {
    expect(fannableRules([withMeta("plugin/empty", { skipOnPageType: [] })]).length).toBe(1);
  });

  test("a page-scoped rule is never fannable", () => {
    expect(fannableRules([withMeta("plugin/page", { verdictScope: "page" })])).toEqual([]);
  });
});
