// #1418: the brand-impersonation exemptions name the brand's sign-in hosts, not every host under `google.com` or
// `microsoft.com`: user-content hosts (Sites, Forms, Docs, Apps Script, redirectors, proxies) and tenant-owned B2C hosts
// do not make a "Sign in with Google/Microsoft" control look legitimate. Synthetic page and identifiers.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { BRAND_SPECS } from "../src/integrity/brand-specs";
import { detectBrandImpersonation } from "../src/integrity/signals";
import type { RuleContext } from "../src/types";

const url = "https://shop.example/";

function brand(label: string, href: string): string | null {
  const html = `<!doctype html><html><head><title>Account</title></head><body><main><h1>Account</h1><a href="${href}">${label}</a></main></body></html>`;
  const parsed = parsePage(html, url);
  const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
  return detectBrandImpersonation(ctx)?.brand ?? null;
}
const google = (href: string): string | null => brand("Sign in with Google", href);
const microsoft = (href: string): string | null => brand("Sign in with Microsoft", href);

describe("Google: only its sign-in hosts spare a sign-in control", () => {
  test("accounts.google.com, accounts.youtube.com and the accounts path of google.com are spared", () => {
    for (const href of [
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
      "https://accounts.google.com/",
      "https://accounts.youtube.com/accounts/SetSID",
      "https://www.google.com/accounts/ServiceLogin",
      "https://google.com/accounts/ServiceLogin?x=1",
    ]) {
      expect(google(href), href).toBeNull();
    }
  });
  test("user-content, redirector, proxy and non-sign-in hosts under google.com are reported", () => {
    for (const href of [
      "https://sites.google.com/view/anything",
      "https://docs.google.com/forms/d/e/abc/viewform",
      "https://script.google.com/macros/s/abc/exec",
      "https://forms.google.com/x",
      "https://drive.google.com/file/d/abc/view",
      "https://groups.google.com/g/x",
      "https://storage.cloud.google.com/bucket/x.html",
      "https://lookerstudio.google.com/reporting/abc",
      "https://colab.research.google.com/drive/abc",
      "https://calendar.google.com/calendar/u/0/r",
      "https://translate.google.com/translate?u=https://evil.example/",
      "https://www.google.com/url?q=https://evil.example/",
      "https://www.google.com/amp/s/evil.example/page",
      "https://www.google.com/search?q=x",
      "https://google.com/",
      "https://sites.google.com/accounts/x",
      "https://docs.google.com/accounts/x",
      "https://www.google.com/accounts-evil/x",
      "https://www.google.com/accountsx",
    ]) {
      expect(google(href), href).toBe("Google");
    }
  });
  test("a look-alike or a deeper label is reported", () => {
    for (const href of [
      "https://accounts.google.com.evil.example/",
      "https://evil-accounts.google.com.example/",
      "https://x.accounts.google.com.evil.example/",
      "https://accountsgoogle.com/",
    ]) {
      expect(google(href), href).toBe("Google");
    }
  });
});

describe("Microsoft: only its sign-in hosts spare a sign-in control", () => {
  test("the Microsoft sign-in hosts are spared", () => {
    for (const href of [
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x",
      "https://login.microsoftonline.us/common/oauth2/authorize",
      "https://login.live.com/oauth20_authorize.srf",
      "https://login.windows.net/common/oauth2/authorize",
      "https://login.microsoft.com/common/oauth2/authorize",
    ]) {
      expect(microsoft(href), href).toBeNull();
    }
  });
  test("b2clogin.com is spared on its authorize paths only", () => {
    expect(microsoft("https://tenant.b2clogin.com/tenant.onmicrosoft.com/b2c_1_signin/oauth2/v2.0/authorize?client_id=x")).toBeNull();
    expect(microsoft("https://tenant.b2clogin.com/tenant.onmicrosoft.com/oauth2/authorize")).toBeNull();
    for (const href of [
      "https://tenant.b2clogin.com/",
      "https://tenant.b2clogin.com/tenant.onmicrosoft.com/b2c_1_signin/page/selfasserted",
      "https://tenant.b2clogin.com/oauth2/authorized-not",
      "https://tenant.b2clogin.com/x/oauth2/authorizexyz",
      "https://b2clogin.com/anything",
      "https://tenant.b2clogin.com.evil.example/oauth2/v2.0/authorize",
    ]) {
      expect(microsoft(href), href).toBe("Microsoft");
    }
  });
  test("forms, answers and other microsoft.com hosts are reported", () => {
    for (const href of [
      "https://forms.microsoft.com/r/abc",
      "https://answers.microsoft.com/en-us/x",
      "https://www.microsoft.com/",
      "https://microsoft.com/en-us/",
      "https://sway.office.com/abc",
      "https://login.microsoftonline.com.evil.example/",
      "https://microsoftonline.com/x",
    ]) {
      expect(microsoft(href), href).toBe("Microsoft");
    }
  });
});

describe("hostile pages stay linear, at 5 MB and at 10 MiB", () => {
  for (const [label, bytes] of [["5 MB", 5_000_000], ["10 MiB", 10 * 1_048_576]] as const) {
    test(`${label} of sign-in links to user-content hosts, then a real one`, () => {
      const unit = '<a href="https://sites.google.com/view/x?q=1">Sign in with Google</a>';
      const body = unit.repeat(Math.ceil(bytes / unit.length));
      const html = `<!doctype html><html><head><title>A</title></head><body><main><h1>A</h1>${body}<a href="https://accounts.google.com/">Sign in with Google</a></main></body></html>`;
      const parsed = parsePage(html, url);
      const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
      const started = performance.now();
      const hit = detectBrandImpersonation(ctx);
      const elapsed = performance.now() - started;
      console.log(`TIMING ${label}: ${elapsed.toFixed(0)} ms`);
      expect(hit?.brand).toBe("Google");
      expect(elapsed).toBeLessThan(6_000);
    }, 120_000);
  }
});

describe("the brand data", () => {
  test("no brand's host list is a registrable domain that hosts user content", () => {
    const hosts = BRAND_SPECS.flatMap((spec) => [spec.brand === "Google" || spec.brand === "Microsoft" ? spec.legitHosts : []].flat());
    for (const bare of ["google.com", "microsoft.com", "live.com", "microsoftonline.com", "youtube.com"]) {
      expect(hosts, bare).not.toContain(bare);
    }
  });
  test("other brands are unchanged", () => {
    const calendly = BRAND_SPECS.find((spec) => spec.brand === "Calendly")!;
    expect(calendly.legitHosts).toEqual(["calendly.com"]);
    expect(
      brand("Sign in to Calendly", "https://calendly.com/login"),
    ).toBeNull();
  });
});
