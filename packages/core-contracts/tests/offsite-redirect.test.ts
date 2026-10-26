// squirrelscan/repo#3480: an entry URL that redirected to another site gets
// one next step. Audit the destination's origin with the exact command, or,
// for a sign-in page, nothing to audit: grading the sign-in host would grade
// the wrong site.

import { describe, expect, test } from "bun:test";

import {
  isSignInHost,
  offSiteRedirectFollowUp,
  SIGN_IN_DOCS_URL,
  SIGN_IN_HOSTS,
} from "../src/offsite-redirect";

describe("isSignInHost", () => {
  test("every listed host, and a tenant of every suffix, is a sign-in host", () => {
    for (const host of SIGN_IN_HOSTS) {
      const sample = host.startsWith(".") ? `team${host}` : host;
      expect(`${sample}: ${isSignInHost(sample)}`).toBe(`${sample}: true`);
    }
  });

  test("a suffix is not its own apex, and a lookalike is not a tenant", () => {
    expect(isSignInHost("cloudflareaccess.com")).toBe(false);
    expect(isSignInHost("evilcloudflareaccess.com")).toBe(false);
    expect(isSignInHost("vercel.com.example.test")).toBe(false);
  });

  test("a sign-in first label counts on a host of three labels or more", () => {
    expect(isSignInHost("login.example.com")).toBe(true);
    expect(isSignInHost("SSO.Example.com:8443")).toBe(true);
    expect(isSignInHost("accounts.example.co.uk")).toBe(true);
    // Two labels is a site called "login", not a sign-in subdomain.
    expect(isSignInHost("login.com")).toBe(false);
    expect(isSignInHost("www.example.com")).toBe(false);
  });
});

describe("offSiteRedirectFollowUp", () => {
  test("a moved site gets the exact command for the destination's origin", () => {
    expect(offSiteRedirectFollowUp("https://www.example.com/en/home?ref=old")).toEqual({
      kind: "audit",
      origin: "https://www.example.com",
      command: "squirrel audit https://www.example.com",
    });
    expect(offSiteRedirectFollowUp("http://example.test:8080/")?.kind).toBe("audit");
  });

  test("a sign-in page gets the docs link and no command", () => {
    const followUp = offSiteRedirectFollowUp(
      "https://team.cloudflareaccess.com/cdn-cgi/access/login/example.com?redirect_url=%2F",
    );
    expect(followUp).toEqual({
      kind: "sign_in",
      origin: "https://team.cloudflareaccess.com",
      docsUrl: SIGN_IN_DOCS_URL,
    });
    expect(followUp).not.toHaveProperty("command");
  });

  test("an origin a shell would read specially is quoted", () => {
    expect(offSiteRedirectFollowUp("http://[::1]:8080/")).toMatchObject({
      command: "squirrel audit 'http://[::1]:8080'",
    });
  });

  test("anything that is not an http(s) URL gets nothing", () => {
    for (const value of ["", "not a url", "javascript:alert(1)", "ftp://example.com/"]) {
      expect(offSiteRedirectFollowUp(value)).toBeNull();
    }
  });
});
