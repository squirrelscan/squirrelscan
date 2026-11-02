// #1418: the brand-impersonation exemptions name the brand's sign-in hosts, not every host under `google.com` or
// `microsoft.com`: user-content hosts (Sites, Forms, Docs, Apps Script, redirectors, proxies) and tenant-owned B2C hosts
// do not make a "Sign in with Google/Microsoft" control look legitimate. Synthetic page and identifiers.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { BRAND_SPECS } from "../src/integrity/brand-specs";
import { detectBrandImpersonation } from "../src/integrity/signals";
import type { RuleContext } from "../src/types";

const url = "https://shop.example/";

function brand(label: string, href: string, pageUrl = url): string | null {
  const html = `<!doctype html><html><head><title>Account</title></head><body><main><h1>Account</h1><a href="${href}">${label}</a></main></body></html>`;
  const parsed = parsePage(html, pageUrl);
  const ctx = { page: { url: pageUrl, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
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
      "https://myaccount.google.com/security",
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

describe("how a host is matched", () => {
  test("case, a port, a scheme-relative or backslash form and tabs inside the URL do not change a genuine host", () => {
    for (const href of [
      "HTTPS://ACCOUNTS.GOOGLE.COM/o/oauth2/v2/auth",
      "https://accounts.google.com:8443/o/oauth2/v2/auth",
      "//accounts.google.com/o/oauth2/v2/auth",
      String.raw`https:\\accounts.google.com\o\oauth2`, // two backslashes read as `//`, and a backslash in the path as a `/`
      "https://accounts.goo\tgle.com/o/oauth2",
    ]) {
      expect(google(href), href).toBeNull();
    }
  });
  test("a backslash form that names another host is judged by the host it names", () => {
    expect(google(String.raw`https:\\credential-fixture.invalid\accounts.google.com`)).toBe("Google");
    expect(google(String.raw`https:\\accounts.google.com@credential-fixture.invalid\x`)).toBe("Google");
  });
  test("the dot boundary: a host that only ends with a listed host's text is not it", () => {
    for (const href of ["https://evilaccounts.google.com/", "https://notaccounts.youtube.com/", "https://xmyaccount.google.com/"]) {
      expect(google(href), href).toBe("Google");
    }
    for (const href of ["https://xlogin.live.com/", "https://evillogin.microsoftonline.de/", "https://notaccount.live.com/", "https://fakeaccount.microsoft.com/"]) {
      expect(microsoft(href), href).toBe("Microsoft");
    }
    expect(brand("Log in to Calendly", "https://evilcalendly.com/login")).toBe("Calendly");
    expect(brand("Log in to Calendly", "https://calendly.com/login")).toBeNull();
    expect(brand("Log in to Calendly", "https://app.calendly.com/login")).toBeNull(); // a subdomain of a listed host is the host
  });
  test("userinfo names the host after the @, not before it", () => {
    // The userinfo with a password is built from parts so no line of this file is a whole credential URL.
    const withPassword = `https://${["accounts.google.com", "pw"].join(":")}@credential-fixture.invalid/`;
    for (const href of ["https://accounts.google.com@credential-fixture.invalid/", withPassword]) {
      expect(google(href), href).toBe("Google");
    }
  });
  test("a trailing-dot host is not the listed host (unchanged from before: it is judged as another host)", () => {
    expect(google("https://accounts.google.com./o/oauth2")).toBe("Google");
  });
  test("a look-alike label is reported: homograph, extra label, hyphen", () => {
    for (const href of ["https://accounts.g\u043e\u043egle.com/", "https://accounts.google.com.credential-fixture.invalid/", "https://accounts-google.com/", "https://login-live.com/"]) {
      expect(brand("Sign in with Google", href) ?? brand("Sign in with Microsoft", href), href).not.toBeNull();
    }
  });
  test("a page on a user-content host is the same site as the other hosts of its domain (unchanged: a known limit)", () => {
    // `isSelfOrSameSite`: sites.google.com and docs.google.com share a registrable domain, so a page hosted on the first whose
    // "Sign in with Google" goes to the second is the site's own surface and is spared; the same for forms.microsoft.com.
    expect(brand("Sign in with Google", "https://docs.google.com/forms/d/e/abc/viewform", "https://sites.google.com/view/anything")).toBeNull();
    expect(brand("Sign in with Microsoft", "https://answers.microsoft.com/x", "https://forms.microsoft.com/r/abc")).toBeNull();
    // while the same link from a page on another domain is reported
    expect(brand("Sign in with Google", "https://docs.google.com/forms/d/e/abc/viewform")).toBe("Google");
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
      "https://login.microsoftonline.de/common/oauth2/authorize",
      "https://login.chinacloudapi.cn/common/oauth2/authorize",
      "https://login.partner.microsoftonline.cn/common/oauth2/authorize",
      "https://account.live.com/Account/Home",
      "https://account.microsoft.com/",
    ]) {
      expect(microsoft(href), href).toBeNull();
    }
  });
  test("b2clogin.com and ciamlogin.com are spared for the site's own tenant, on an authorize path only", () => {
    // the page is shop.example: its own tenant is `shop`, or `shop` plus an environment suffix
    for (const href of [
      "https://shop.b2clogin.com/shop.onmicrosoft.com/b2c_1_signin/oauth2/v2.0/authorize?client_id=x",
      "https://shop.b2clogin.com/shop.onmicrosoft.com/oauth2/authorize",
      "https://shop-prod.b2clogin.com/shop.onmicrosoft.com/b2c_1_signin/oauth2/v2.0/authorize",
      "https://shop.ciamlogin.com/shop.onmicrosoft.com/oauth2/v2.0/authorize",
    ]) {
      expect(microsoft(href), href).toBeNull();
    }
    for (const href of [
      "https://tenant.b2clogin.com/tenant.onmicrosoft.com/b2c_1_signin/oauth2/v2.0/authorize?client_id=x", // somebody else's tenant
      "https://evil.b2clogin.com/x/oauth2/v2.0/authorize",
      "https://evil.shop.b2clogin.com/shop.onmicrosoft.com/oauth2/v2.0/authorize", // a deeper label
      "https://shop-login.b2clogin.com/shop.onmicrosoft.com/oauth2/v2.0/authorize", // a suffix an attacker can pick
      "https://tenant.ciamlogin.com/tenant.onmicrosoft.com/oauth2/v2.0/authorize",
      "https://shop.b2clogin.com/",
      "https://shop.b2clogin.com/shop.onmicrosoft.com/b2c_1_signin/page/selfasserted",
      "https://shop.b2clogin.com/oauth2/authorized-not",
      "https://shop.b2clogin.com/x/oauth2/authorizexyz",
      "https://b2clogin.com/oauth2/authorize",
      "https://shop.b2clogin.com.evil.example/oauth2/v2.0/authorize",
      "https://shop.evil.b2clogin.com/shop.onmicrosoft.com/oauth2/v2.0/authorize", // the site's name as the first label, a deeper tenant
      "https://shop.evil.ciamlogin.com/shop.onmicrosoft.com/oauth2/v2.0/authorize",
      "https://shopxprod.b2clogin.com/shop.onmicrosoft.com/oauth2/v2.0/authorize", // the name and a suffix that is not hyphenated
      "https://shop.ciamlogin.com/shop.onmicrosoft.com/page",
    ]) {
      expect(microsoft(href), href).toBe("Microsoft");
    }
  });
  test("a tenant is matched against a site name of at least three letters, and the name is the registrable domain's", () => {
    const authorize = (tenant: string) => `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/oauth2/v2.0/authorize`;
    expect(brand("Sign in with Microsoft", authorize("abc"), "https://abc.com/")).toBeNull(); // three letters: matched
    expect(brand("Sign in with Microsoft", authorize("ab"), "https://ab.com/")).toBe("Microsoft"); // two letters: never spared
    expect(brand("Sign in with Microsoft", authorize("shop"), "https://www.shop.com/")).toBeNull(); // a sub-domain of the site
    expect(brand("Sign in with Microsoft", authorize("www"), "https://www.shop.com/")).toBe("Microsoft");
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
