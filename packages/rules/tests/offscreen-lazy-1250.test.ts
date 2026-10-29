// images/offscreen-lazy counts the above-the-fold budget in content images, not in elements (#1250).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { offscreenLazyRule } from "../src/images/offscreen-lazy";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string, options: object = {}): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Image weight rule repro page for squirrel audits</title></head><body>${body}</body></html>`;
  const url = "https://example.com/hero.html";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options,
  } as unknown as RuleContext;
  const result = offscreenLazyRule.run(ctx);
  if (result instanceof Promise) throw new Error("offscreen-lazy is async");
  return result.checks;
}

const icon = (n: number) => `<img src="small.jpg" width="24" height="24" alt="Icon ${n}">`;

describe("images/offscreen-lazy above-the-fold budget (#1250)", () => {
  test("the reporter's page: four header icons then a hero image raises nothing", () => {
    const checks = run(`<header>${[1, 2, 3, 4].map(icon).join("")}</header>
<main><img src="small.jpg" width="400" height="120" alt="Header image"><h1>Hero after icons</h1><p>Short intro.</p></main>`);
    expect(checks.some((c) => c.name === "offscreen-images-not-lazy")).toBe(false);
    expect(checks[0]?.status).toBe("pass");
  });

  test("the control without the icons gives the same answer", () => {
    const checks = run(
      `<main><img src="small.jpg" width="400" height="120" alt="Header image"></main>`,
    );
    expect(checks.some((c) => c.name === "offscreen-images-not-lazy")).toBe(false);
  });

  test("enough large content images before a late image: it is still reported", () => {
    const content = (n: number) =>
      `<img src="p${n}.jpg" width="800" height="600" alt="Photo ${n}">`;
    const checks = run(
      `<main>${[1, 2, 3].map(content).join("")}<img src="late.jpg" width="800" height="600" alt="Late"></main>`,
    );
    const warn = checks.find((c) => c.name === "offscreen-images-not-lazy");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.map((i) => i.id)).toEqual(["late.jpg"]);
  });

  test("icons before the budget is full do not count as below the fold", () => {
    const checks = run(
      `<main>${icon(1)}<img src="a.jpg" width="800" height="600" alt="A">${icon(2)}<img src="b.jpg" width="800" height="600" alt="B"><img src="c.jpg" width="800" height="600" alt="C"></main>`,
    );
    expect(checks.some((c) => c.name === "offscreen-images-not-lazy")).toBe(false);
  });

  test("images with no declared size count as content, as before", () => {
    const checks = run(
      `<main><img src="1.jpg" alt=""><img src="2.jpg" alt=""><img src="3.jpg" alt=""><img src="4.jpg" alt=""></main>`,
    );
    expect(
      checks.find((c) => c.name === "offscreen-images-not-lazy")?.items?.map((i) => i.id),
    ).toEqual(["4.jpg"]);
  });

  test("above_fold_count still sets the budget", () => {
    const content = (n: number) =>
      `<img src="p${n}.jpg" width="800" height="600" alt="Photo ${n}">`;
    const checks = run(`<main>${[1, 2, 3].map(content).join("")}</main>`, { above_fold_count: 1 });
    expect(
      checks.find((c) => c.name === "offscreen-images-not-lazy")?.items?.map((i) => i.id),
    ).toEqual(["p2.jpg", "p3.jpg"]);
  });
});
