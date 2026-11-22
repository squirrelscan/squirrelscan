// security/form-captcha: a public form guarded by a honeypot field (a hidden
// decoy input with tabindex="-1" and autocomplete="off") reports as info that
// names the honeypot, not as an unprotected-form warning (#2228).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { RuleContext } from "../src/types";

import { formCaptchaRule } from "../src/security/form-captcha";

function ctx(html: string): RuleContext {
  const url = "https://example.com/contact";
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
}

function page(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${bodyHtml}</body></html>`;
}

function contactForm(extra: string, id = "contact-form"): string {
  return `<form id="${id}" action="/submit">
  <input type="text" name="name">
  <textarea name="message"></textarea>
  ${extra}
  <button type="submit">Send</button>
</form>`;
}

async function check(html: string) {
  const { checks } = await formCaptchaRule.run(ctx(html));
  return checks.find((c) => c.name === "form-captcha");
}

const OFFSCREEN_HONEYPOT = `<input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px">`;

describe("security/form-captcha: honeypot fields (#2228)", () => {
  test("off-screen tabindex=-1 autocomplete=off input -> info naming the honeypot", async () => {
    const result = await check(page(contactForm(OFFSCREEN_HONEYPOT)));
    expect(result?.status).toBe("info");
    expect(result?.message).toContain("honeypot");
    expect(result?.items).toEqual([{ id: "#contact-form" }]);
  });

  test("decoy inside an off-screen wrapper counts", async () => {
    const result = await check(
      page(
        contactForm(
          `<div style="position: absolute; left: -5000px;" aria-hidden="true"><input type="text" name="b_123" tabindex="-1" autocomplete="off" value=""></div>`
        )
      )
    );
    expect(result?.status).toBe("info");
  });

  test.each([
    [
      "display:none",
      `<input name="url" tabindex="-1" autocomplete="off" style="display:none">`,
    ],
    [
      "hidden attribute",
      `<input name="url" tabindex="-1" autocomplete="off" hidden>`,
    ],
    [
      "hidden class on wrapper",
      `<p class="visually-hidden"><input name="url" tabindex="-1" autocomplete="off"></p>`,
    ],
    [
      "honeypot name token",
      `<input name="hp_field" tabindex="-1" autocomplete="off">`,
    ],
  ])("hidden signal: %s", async (_label, field) => {
    expect((await check(page(contactForm(field))))?.status).toBe("info");
  });

  test("no protection signal at all still warns as before", async () => {
    const result = await check(page(contactForm("")));
    expect(result?.status).toBe("warn");
    expect(result?.message).toContain(
      "without detectable client-side CAPTCHA markup"
    );
    expect(result?.details).toBeUndefined();
  });

  test.each([
    ["visible field", `<input name="code" tabindex="-1" autocomplete="off">`],
    [
      "missing tabindex",
      `<input name="url" autocomplete="off" style="position:absolute;left:-9999px">`,
    ],
    [
      "missing autocomplete=off",
      `<input name="url" tabindex="-1" style="position:absolute;left:-9999px">`,
    ],
    [
      "type=hidden token field",
      `<input type="hidden" name="hp_token" tabindex="-1" autocomplete="off">`,
    ],
    ["hidden only via the form itself", ""],
  ])("not a honeypot (%s): still warns", async (label, field) => {
    const html =
      label === "hidden only via the form itself"
        ? page(
            `<form id="contact-form" style="display:none" action="/submit"><textarea name="message"></textarea><input name="x" tabindex="-1" autocomplete="off"></form>`
          )
        : page(contactForm(field));
    expect((await check(html))?.status).toBe("warn");
  });

  test("mixed page: only the form without a honeypot is warned about", async () => {
    const result = await check(
      page(
        contactForm(OFFSCREEN_HONEYPOT) +
          `<form id="newsletter" action="/subscribe"><input type="email" name="email"><button>Go</button></form>`
      )
    );
    expect(result?.status).toBe("warn");
    expect(result?.items).toEqual([{ id: "#newsletter" }]);
    expect(result?.details).toEqual({ honeypotForms: ["#contact-form"] });
  });

  test("a CAPTCHA widget still passes when a honeypot is also present", async () => {
    const result = await check(
      page(
        contactForm(
          `${OFFSCREEN_HONEYPOT}<div class="cf-turnstile" data-sitekey="0x4AAAAAAAAAAAAAAAAAAA"></div>`
        )
      )
    );
    expect(result?.status).toBe("pass");
  });
});
