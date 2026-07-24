// security/form-captcha — FormShield (our own product) is invisible,
// site-wide protection with no per-form widget markup (#696). Dogfooding
// find: a FormShield-protected contact form was flagged "without CAPTCHA"
// on every page because the rule only knew about visible widget providers.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { formCaptchaRule } from "../src/security/form-captcha";
import type { RuleContext } from "../src/types";

function ctx(html: string): RuleContext {
  const url = "https://example.com/contact";
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
}

function page(headHtml: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><title>t</title>${headHtml}</head><body>${bodyHtml}</body></html>`;
}

const CONTACT_FORM = `<form id="contact-form" action="/submit">
  <input type="text" name="name">
  <textarea name="message"></textarea>
  <button type="submit">Send</button>
</form>`;

function formCaptchaCheck(checks: ReturnType<typeof formCaptchaRule.run>["checks"]) {
  return checks.find((c) => c.name === "form-captcha");
}

describe("security/form-captcha — FormShield detection", () => {
  test("#696: FormShield beacon script → public form counts as protected", () => {
    const html = page(
      `<script async src="https://api.formshield.dev/js/formshield.js" data-fs-project-key="fs_pub_live_abc" data-fs-action="pageview" data-fs-mode="pageload"></script>`,
      CONTACT_FORM,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("FormShield beacon proxied under a different host, keyed via data-fs-project-key", () => {
    const html = page(
      `<script async src="/assets/beacon.js" data-fs-project-key="fs_pub_live_abc"></script>`,
      CONTACT_FORM,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("FormShield covers ALL public forms on a multi-form page (unlike the generic single-form heuristic)", () => {
    const html = page(
      `<script src="https://api.formshield.dev/js/formshield.js" data-fs-project-key="fs_pub_live_abc"></script>`,
      `${CONTACT_FORM}
      <form id="newsletter" action="/subscribe"><input type="email" name="email"><button>Subscribe</button></form>`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("true positive preserved: no FormShield, no CAPTCHA → still flagged", () => {
    const html = page("", CONTACT_FORM);
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
    expect(formCaptchaCheck(checks)?.message).toContain("without CAPTCHA");
  });

  test("unrelated script src containing 'formshield' as a substring only (not the real host) still flags", () => {
    const html = page(
      `<script src="https://example.com/not-formshield.dev-related.js"></script>`,
      CONTACT_FORM,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
  });

  test("review regression: full beacon path on a NON-formshield host does not count as protection", () => {
    const html = page(
      `<script src="https://evil.example/formshield.dev/js/formshield.js"></script>`,
      CONTACT_FORM,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
  });
});

describe("security/form-captcha — explicit-render Turnstile/CAPTCHA loaders (#1173)", () => {
  test("#1173: perspectivesintopractice.com/contact repro — preload link + explicit-render container, no script[src]/iframe/.cf-turnstile → pass", () => {
    const html = page(
      `<link rel="preload" as="script" href="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit">`,
      `<form id="contact-form" action="/submit">
        <input type="text" name="name">
        <textarea name="message"></textarea>
        <div id="turnstile-widget"></div>
        <button type="submit">Send</button>
      </form>`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("modulepreload link to a CAPTCHA provider script counts as a page-level signal", () => {
    const html = page(
      `<link rel="modulepreload" href="https://www.google.com/recaptcha/releases/abc/recaptcha__en.js">`,
      CONTACT_FORM,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("prefetch link to a CAPTCHA provider script counts as a page-level signal", () => {
    const html = page(`<link rel="prefetch" href="https://hcaptcha.com/1/api.js">`, CONTACT_FORM);
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("preload link without as=script does NOT count (not a script loader)", () => {
    const html = page(
      `<link rel="preload" as="style" href="https://challenges.cloudflare.com/turnstile/v0/api.css">`,
      CONTACT_FORM,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
  });

  test("explicit-render container id (turnstile) with no script/iframe/class at all → pass", () => {
    const html = page(
      "",
      `<form id="contact-form" action="/submit">
        <input type="text" name="name">
        <textarea name="message"></textarea>
        <div class="my-turnstile-container"></div>
        <button type="submit">Send</button>
      </form>`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("g-recaptcha explicit-render container id (not the .g-recaptcha class) → pass", () => {
    const html = page("", `${CONTACT_FORM}<div id="g-recaptcha-container"></div>`);
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("h-captcha and frc-captcha explicit-render container tokens are also detected", () => {
    for (const token of ["h-captcha-widget", "frc-captcha-box"]) {
      const html = page("", `${CONTACT_FORM}<div id="${token}"></div>`);
      const { checks } = formCaptchaRule.run(ctx(html));
      expect(formCaptchaCheck(checks)?.status).toBe("pass");
    }
  });

  test("bare 'captcha' token WITH a container hint word (widget/container/box) counts as a page-level signal", () => {
    const html = page("", `${CONTACT_FORM}<div id="captcha-widget"></div>`);
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("false-positive guard: bare 'captcha' token WITHOUT a container hint (e.g. help text link) does NOT match", () => {
    const html = page(
      "",
      `${CONTACT_FORM}<a id="captcha-help-text" href="/faq#captcha">What's a CAPTCHA?</a>`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
  });

  test("false-positive guard: 'recaptcha' as a substring of an unrelated id does not match provider tokens", () => {
    // "notrecaptcha" is not the same delimited token as "recaptcha" or "g-recaptcha"
    const html = page("", `${CONTACT_FORM}<div id="notrecaptcha-info"></div>`);
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
  });

  test("review finding #1 (confirmed): bare 'captcha' and a hint word on SEPARATE, unrelated attributes of the same element must NOT match — an FAQ link with an unrelated 'footer-widget' styling class must still warn", () => {
    const html = page(
      "",
      `${CONTACT_FORM}<a id="captcha-help-text" class="footer-widget">What is a CAPTCHA?</a>`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
  });

  test("review round 2 finding (confirmed): heading anchor slug auto-generated from prose ABOUT Turnstile does not count as a mount point", () => {
    // e.g. rehype-slug turning "Cloudflare Turnstile vs reCAPTCHA" into <h2 id="...">
    const html = page(
      "",
      `${CONTACT_FORM}<h2 id="cloudflare-turnstile-vs-recaptcha">Cloudflare Turnstile vs reCAPTCHA</h2>`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
  });

  test("review round 2 finding (confirmed): a physical-turnstile counter div WITH text content is not a CAPTCHA mount point", () => {
    const html = page(
      "",
      `${CONTACT_FORM}<div id="turnstile-status" class="turnstile-counter-widget">3 people through</div>`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
  });

  test("the same turnstile-status/turnstile-counter-widget markup with NO text content is still a valid mount point (emptiness, not the id name, is what's gated)", () => {
    const html = page(
      "",
      `${CONTACT_FORM}<div id="turnstile-status" class="turnstile-counter-widget"></div>`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("bare 'captcha' + hint word DO count when they form a single hyphen-delimited compound (captcha-widget)", () => {
    const html = page("", `${CONTACT_FORM}<div id="captcha-widget"></div>`);
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("bare 'captcha' + hint word compound also matches camelCase (captchaBox)", () => {
    const html = page("", `${CONTACT_FORM}<div id="captchaBox"></div>`);
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("review finding #2 (confirmed): explicit-render container nested inside an EXCLUDED nav-search form does not protect an unrelated public contact form", () => {
    const html = page(
      "",
      `<form id="nav-search" action="/search">
        <input type="text" name="q">
        <div id="turnstile-widget"></div>
      </form>
      ${CONTACT_FORM}`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
    expect(formCaptchaCheck(checks)?.items).toEqual([{ id: "#contact-form" }]);
  });

  test("assumeProtected loosening: page-level signal + one PUBLIC form protects it even with an extra nav search form present", () => {
    const html = page(
      `<link rel="preload" as="script" href="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit">`,
      `<form id="nav-search" action="/search"><input type="text" name="q"></form>
      <div id="turnstile-widget"></div>
      ${CONTACT_FORM}`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("modulepreload/prefetch links with a combined rel token list are still detected (rel is a token list, not an exact string)", () => {
    const html = page(
      `<link rel="preload modulepreload" as="script" href="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit">`,
      CONTACT_FORM,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("pass");
  });

  test("codex review regression: a CAPTCHA belonging to a DIFFERENT form (login) is not credited to an unrelated public contact form", () => {
    const html = page(
      "",
      `<form id="login-form" action="/login">
        <input type="text" name="user">
        <input type="password" name="pass">
        <div class="g-recaptcha"></div>
      </form>
      ${CONTACT_FORM}`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
    expect(formCaptchaCheck(checks)?.items).toEqual([{ id: "#contact-form" }]);
  });

  test("true positive preserved: two genuinely unprotected public forms still flag, page-level signal does not blanket-cover multiple public forms", () => {
    const html = page(
      "",
      `${CONTACT_FORM}
      <form id="newsletter" action="/subscribe"><input type="email" name="email"><button>Subscribe</button></form>`,
    );
    const { checks } = formCaptchaRule.run(ctx(html));
    expect(formCaptchaCheck(checks)?.status).toBe("warn");
    expect(formCaptchaCheck(checks)?.items?.length).toBe(2);
  });
});
