// content/conversion-path: money pages whose only calls to action leave the site.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { conversionPathRule, isMoneyPage } from "../src/content/conversion-path";
import { rules as contentRules } from "../src/content";
import type { ParsedPage, RuleContext } from "../src/types";

async function run(body: string, url = "https://shop.example.com/pricing", types: string[] = []) {
  const html = `<html><head><title>t</title></head><body>${body}</body></html>`;
  const { document } = parseHTML(html);
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document, schemas: { types } } as unknown as ParsedPage,
    options: {},
  };
  return (await conversionPathRule.run(ctx)).checks[0]!;
}

const linkedin = `<main><h1>Pricing</h1>
  <a class="btn btn-primary" href="https://www.linkedin.com/in/founder">Talk to us</a>
  <a class="button" href="https://linkedin.com/in/founder">Request access</a></main>`;

describe("content/conversion-path", () => {
  test("registered in the content category", () => {
    expect(contentRules).toContain(conversionPathRule);
  });

  test("pricing page whose CTAs all go to LinkedIn warns", async () => {
    const check = await run(linkedin);
    expect(check.status).toBe("warn");
    expect(check.value).toBe(2);
  });

  test("a contact form clears it", async () => {
    const check = await run(
      `${linkedin}<form action="/lead"><input name="email"><button>Send</button></form>`,
    );
    expect(check.status).toBe("pass");
  });

  test("a site-search form does not count as a form", async () => {
    const check = await run(`${linkedin}<form role="search"><input type="search" name="q"></form>`);
    expect(check.status).toBe("warn");
  });

  test("mailto and tel clear it", async () => {
    expect((await run(`${linkedin}<a href="mailto:hi@shop.example.com">Mail</a>`)).status).toBe(
      "pass",
    );
    expect((await run(`${linkedin}<a href="tel:+15550100">Call</a>`)).status).toBe("pass");
  });

  test("a link to the contact page clears it", async () => {
    const check = await run(`${linkedin}<nav><a href="/contact">Contact</a></nav>`);
    expect(check.status).toBe("pass");
  });

  test("Calendly CTA is info at most", async () => {
    const check = await run(
      `<main><a class="btn" href="https://calendly.com/acme/demo">Book</a></main>`,
    );
    expect(check.status).toBe("info");
  });

  test("Stripe Checkout CTA is info at most", async () => {
    const check = await run(
      `<main><a class="cta" href="https://buy.stripe.com/abc">Buy</a><a class="btn" href="https://linkedin.com/in/x">Hi</a></main>`,
    );
    expect(check.status).toBe("info");
  });

  test("an on-site CTA is a conversion path", async () => {
    const check = await run(`${linkedin}<a class="btn" href="/signup">Start</a>`);
    expect(check.status).toBe("pass");
  });

  test("a subdomain CTA counts as on-site", async () => {
    const check = await run(
      `<main><a class="btn" href="https://app.example.com/start">Start</a></main>`,
      "https://www.example.com/pricing",
    );
    expect(check.status).toBe("pass");
  });

  test("plain links and chrome buttons are not prominent CTAs", async () => {
    const check = await run(
      `<header><a class="btn" href="https://linkedin.com/in/x">Follow</a></header><main><a href="https://linkedin.com/in/x">me</a></main>`,
    );
    expect(check.status).toBe("pass");
    expect(check.details?.ctaCount).toBe(0);
  });

  test("blog posts and other pages are never flagged", async () => {
    for (const url of [
      "https://shop.example.com/blog/pricing",
      "https://shop.example.com/blog/our-pricing-update",
      "https://shop.example.com/about",
      "https://shop.example.com/",
    ]) {
      expect((await run(linkedin, url)).status).toBe("skipped");
    }
  });

  test("Article schema on a pricing-looking URL is not a money page", async () => {
    expect((await run(linkedin, "https://shop.example.com/pricing", ["BlogPosting"])).status).toBe(
      "skipped",
    );
  });

  test("Product schema makes any page a money page", async () => {
    const check = await run(linkedin, "https://shop.example.com/widget-3000", ["Product"]);
    expect(check.status).toBe("warn");
  });
});

describe("isMoneyPage", () => {
  test.each([
    "https://a.example.com/pricing",
    "https://a.example.com/services/seo",
    "https://a.example.com/products/widget/",
    "https://a.example.com/plans",
  ])("%s", (u) => expect(isMoneyPage(u, [])).toBe(true));

  test.each([
    "https://a.example.com/",
    "https://a.example.com/blog/services/x",
    "https://a.example.com/pricing-guide-2024",
  ])("%s is not", (u) => expect(isMoneyPage(u, [])).toBe(false));
});
