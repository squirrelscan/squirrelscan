// repo#3880: ax/agent-tasks, scripted deterministic agent task checks.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import type { SiteMetadata } from "@squirrelscan/core-contracts";

import { agentTasksRule } from "../src/ax/agent-tasks";
import type { CheckResult, ParsedPage, RuleContext, SiteData } from "../src/types";

const BASE = "https://shop.test";

function page(path: string, html: string, statusCode = 200): SiteData["pages"][number] {
  const url = `${BASE}${path}`;
  return { url, statusCode, parsed: parsePage(html, url) as ParsedPage };
}

function ctx(pages: SiteData["pages"], options: unknown = {}, siteMetadata?: SiteMetadata): RuleContext {
  return {
    page: pages[0] ? { url: pages[0].url, html: "", statusCode: 200, loadTime: 0, headers: {} } : ({} as never),
    parsed: {} as ParsedPage,
    site: { baseUrl: BASE, pages, robotsTxt: null, sitemaps: null },
    options,
    siteMetadata,
  } as RuleContext;
}

const meta = (siteType: SiteMetadata["siteType"]): SiteMetadata =>
  ({ siteType, confidence: "high", isYMYL: false, isLocalBusiness: false, hasOwnershipVerified: false }) as SiteMetadata;

const run = async (c: RuleContext): Promise<CheckResult[]> => (await agentTasksRule.run(c)).checks;
const by = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name)!;

const home = (extra = "") =>
  page("/", `<html><body><nav><a href="/about">About</a><a href="/contact">Contact</a></nav>${extra}</body></html>`);
const goodContact = page(
  "/contact",
  `<html><body><a href="mailto:hi@shop.test">hi@shop.test</a><a href="tel:+15551234567">+1 555 123 4567</a>
   <form action="/send"><label for="n">Name</label><input id="n" name="n"><label>Email <input name="e"></label><textarea aria-label="Message"></textarea></form></body></html>`,
);

describe("ax/agent-tasks", () => {
  test("find-contact and reach-form pass on a fixture site", async () => {
    const checks = await run(ctx([home(), goodContact]));
    expect(by(checks, "find-contact").value).toBe("pass");
    expect(by(checks, "reach-form").value).toBe("pass");
  });

  test("find-contact names the failing step: no route", async () => {
    const checks = await run(ctx([page("/", "<html><body><a href='/about'>About</a></body></html>")]));
    const c = by(checks, "find-contact");
    expect(c.value).toBe("fail");
    expect((c.details as { step: string }).step).toBe("find-route");
  });

  test("find-contact: a plain-text phone fails at phone-link", async () => {
    const bad = page("/contact", `<html><body><p>Call +1 555 123 4567</p><a href="mailto:a@b.test">mail</a></body></html>`);
    const c = by(await run(ctx([home(), bad])), "find-contact");
    expect((c.details as { step: string }).step).toBe("phone-link");
  });

  test("find-contact: no email and no form fails at email-or-form", async () => {
    const bad = page("/contact", `<html><body><p>Visit us</p></body></html>`);
    const c = by(await run(ctx([home(), bad])), "find-contact");
    expect((c.details as { step: string }).step).toBe("email-or-form");
  });

  test("click budget: a route two clicks away needs maxClicks 2", async () => {
    const h = page("/", `<html><body><a href="/company">Company</a></body></html>`);
    const company = page("/company", `<html><body><a href="/contact">Contact</a></body></html>`);
    expect(by(await run(ctx([h, company, goodContact], { maxClicks: 1 })), "find-contact").value).toBe("fail");
    expect(by(await run(ctx([h, company, goodContact], { maxClicks: 2 })), "find-contact").value).toBe("pass");
  });

  test("a bot wall reports blocked, not fail", async () => {
    const wall = page("/", "<html><body>Just a moment...</body></html>", 403);
    const checks = await run(ctx([wall]));
    expect(by(checks, "find-contact").value).toBe("blocked");
    expect(by(checks, "find-contact").status).toBe("skipped");
  });

  test("reach-form fails on unlabelled fields, login forms and a challenge first", async () => {
    const step = async (html: string) => {
      const c = by(await run(ctx([home(), page("/contact", `<html><body><a href="mailto:a@b.test">m</a>${html}</body></html>`)])), "reach-form");
      return (c.details as { step: string }).step;
    };
    expect(await step(`<form><input name="a" placeholder="Name"></form>`)).toBe("labelled-fields");
    expect(await step(`<form><input aria-label="u"><input type="password" aria-label="p"></form>`)).toBe("no-login");
    expect(await step(`<form><div class="g-recaptcha"></div><input aria-label="Name"></form>`)).toBe("challenge-before-field");
    expect(await step(`<form><input aria-label="Name"><div class="g-recaptcha"></div></form>`)).toBe("done");
    expect(await step(`<p>none</p>`)).toBe("find-form");
  });

  test("find-price is gated by site type and forceable", async () => {
    const pricing = page("/pricing", `<html><body><h1>Pricing</h1><p>Pro $29/mo</p></body></html>`);
    const pages = [home(), pricing];
    expect(by(await run(ctx(pages, {}, meta("blog"))), "find-price").value).toBe("not-applicable");
    expect(by(await run(ctx(pages, {}, meta("saas"))), "find-price").value).toBe("pass");
    expect(by(await run(ctx(pages, { tasks: { "find-price": "on" } }, meta("blog"))), "find-price").value).toBe("pass");
    expect(by(await run(ctx(pages, { tasks: { "find-price": "on" } })), "find-price").value).toBe("pass");
    expect(by(await run(ctx(pages)), "find-price").value).toBe("not-applicable");
  });

  test("find-price fails when the price is not in the served HTML", async () => {
    const pricing = page("/pricing", `<html><body><div id="app"></div></body></html>`);
    const c = by(await run(ctx([home(), pricing], { tasks: { "find-price": "on" } })), "find-price");
    expect(c.value).toBe("fail");
    expect((c.details as { step: string }).step).toBe("price-in-html");
  });

  test("tasks can be forced off", async () => {
    const checks = await run(ctx([home(), goodContact], { tasks: { "find-contact": "off", "reach-form": "off", "find-price": "off" } }));
    expect(checks.every((c) => c.status === "skipped")).toBe(true);
    expect(by(checks, "find-contact").value).toBe("off");
  });

  test("two runs over the same crawl are identical", async () => {
    const c = ctx([home(), goodContact, page("/about", "<html><body><a href='/contact'>c</a></body></html>")]);
    expect(JSON.stringify(await run(c))).toBe(JSON.stringify(await run(c)));
  });

  test("makes no network or LLM call", () => {
    const src = require("node:fs").readFileSync(new URL("../src/ax/agent-tasks.ts", import.meta.url), "utf8") as string;
    expect(src).not.toMatch(/fetch\(|anthropic|openai|\.cloud\b|cloudResults/i);
  });
});
