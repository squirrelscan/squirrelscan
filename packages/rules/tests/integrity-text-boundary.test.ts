import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
import { detectPageSignals } from "../src/integrity/signals";
import { brandImpersonationRule } from "../src/integrity/brand-impersonation";
import { fakeAuthOverlayRule } from "../src/integrity/fake-auth-overlay";
import type { RuleContext } from "../src/types";

// pub#696, the reporter's regression test as filed (first four tests), plus the
// cases the fix must not change (below the divider).

const url = "https://example.com/";
const overlay = '<iframe id="google-auth" srcdoc="" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999"></iframe>';
const link = '<a href="https://credential-fixture.invalid/signin">Sign in with Google</a>';
function context(body: string): RuleContext {
  const html = `<!doctype html><html><head><title>Applicability fixture</title></head><body><main><h1>Applicability fixture</h1>${body}</main></body></html>`;
  const parsed = parsePage(html, url);
  return { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} };
}

test("control: whitespace-separated correlated signals produce two failures", () => {
  const ctx = context(` ${overlay}${link}`);
  expect([...detectPageSignals(ctx)].sort()).toEqual(["brand-impersonation", "fake-auth-overlay"]);
  expect(brandImpersonationRule.run(ctx).checks[0]?.status).toBe("fail");
  expect(fakeAuthOverlayRule.run(ctx).checks[0]?.status).toBe("fail");
});

test("regression: removing inter-element whitespace preserves correlated signals", () => {
  const ctx = context(`${overlay}${link}`);
  expect([...detectPageSignals(ctx)].sort()).toEqual(["brand-impersonation", "fake-auth-overlay"]);
  expect(brandImpersonationRule.run(ctx).checks[0]?.status).toBe("fail");
  expect(fakeAuthOverlayRule.run(ctx).checks[0]?.status).toBe("fail");
});

test("control: a lone overlay remains info", () => {
  const ctx = context(` ${overlay}`);
  expect([...detectPageSignals(ctx)]).toEqual(["fake-auth-overlay"]);
  expect(fakeAuthOverlayRule.run(ctx).checks[0]?.status).toBe("info");
  expect(brandImpersonationRule.run(ctx).checks).toEqual([]);
});

test("control: an ordinary iframe has no compromise signal", () => {
  const ctx = context(' <iframe title="Ordinary content" srcdoc="" style="width:300px;height:150px"></iframe>');
  expect([...detectPageSignals(ctx)]).toEqual([]);
  expect(fakeAuthOverlayRule.run(ctx).checks).toEqual([]);
  expect(brandImpersonationRule.run(ctx).checks).toEqual([]);
});

// ── what the fix must not change ────────────────────────────────────

test("a compact, legitimate Sign in with Google link is not impersonation", () => {
  const ctx = context('<a href="https://accounts.google.com/o/oauth2/auth">Sign in with Google</a>');
  expect(detectPageSignals(ctx).has("brand-impersonation")).toBe(false);
  expect(brandImpersonationRule.run(ctx).checks).toEqual([]);
});

test("a compact off-brand link with no overlay is a lone signal: info", () => {
  const ctx = context(link);
  expect([...detectPageSignals(ctx)]).toEqual(["brand-impersonation"]);
  expect(brandImpersonationRule.run(ctx).checks[0]?.status).toBe("info");
});

test("a self-hosted sign-in link is spared, glued or not", () => {
  for (const sep of ["", " "]) {
    const ctx = context(`${sep}<a href="https://app.example.com/login">Sign in with Google</a>`);
    expect(detectPageSignals(ctx).has("brand-impersonation")).toBe(false);
  }
});

test("a brand mention with no credential control is still not impersonation", () => {
  const ctx = context("<p>We integrate with Google Calendar.</p><p>Read our guide.</p>");
  expect(detectPageSignals(ctx).has("brand-impersonation")).toBe(false);
});

test("an off-self iframe overlay is corroborated by glued auth copy", () => {
  // The iframe branch needs page-level auth copy when the frame carries no
  // auth-suggestive id; `<h1>Welcome</h1><p>Sign in</p>` used to read
  // "welcomesign in" and miss it.
  const frame =
    '<iframe src="https://frames.invalid/x" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999"></iframe>';
  for (const sep of ["", " "]) {
    const ctx = context(`${frame}${sep}<p>Sign in to continue</p>`);
    expect(detectPageSignals(ctx).has("fake-auth-overlay")).toBe(true);
  }
});
