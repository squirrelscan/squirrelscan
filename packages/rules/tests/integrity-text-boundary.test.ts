import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
import { detectBrandImpersonation, detectPageSignals } from "../src/integrity/signals";
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

// pub#749 review: whitespace and invisible characters inside the control's own
// label, and links whose only cue is "verify" or "continue with".

test("whitespace or an invisible character inside the label cannot split the cue", () => {
  for (const label of [
    "Sign in with\nGoogle",
    "Sign in  with Google",
    "Sign in&nbsp;with Google",
    "Sign in with<br>Google",
    "Sign in with<span> </span>Google",
    "Sign​ in with Google",
    "Sign in with Goo­gle",
  ]) {
    const ctx = context(`<a href="https://credential-fixture.invalid/signin">${label}</a>`);
    expect([...detectPageSignals(ctx)]).toContain("brand-impersonation");
  }
});

test("a link labelled only verify or continue with is not a credential affordance by itself", () => {
  for (const anchor of [
    '<a href="https://blog.example.org/post">Verify your Google account</a>',
    '<a href="https://help.example.org/kb">Continue with Microsoft account</a>',
  ]) {
    const ctx = context(` ${anchor}`);
    expect(detectPageSignals(ctx).has("brand-impersonation")).toBe(false);
    expect(brandImpersonationRule.run(ctx).checks).toEqual([]);
  }
});

test("an invisible operator or combining joiner inside the label cannot split the cue either", () => {
  for (const label of ["Sign in with Goo\u2063gle", "Sign in with Goo\u034fgle"]) {
    const ctx = context(`<a href="https://credential-fixture.invalid/signin">${label}</a>`);
    expect([...detectPageSignals(ctx)]).toContain("brand-impersonation");
  }
});

test("nested unclosed anchors stay near linear (n, 2n, 4n)", () => {
  // The parser nests an unclosed <a> inside the next, so every anchor holds
  // the rest of the page. Reading each label in full again grew with the
  // square of their number: 2,000 took 1.5 to 3.6 s, past the rule's time
  // budget, so junk anchors could hide a real signal. Now about 150 ms.
  const elapsed = (count: number) => {
    const ctx = context(`${'<a href="https://x.invalid/">x'.repeat(count)}`);
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 2; run++) {
      const started = performance.now();
      detectBrandImpersonation(ctx);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  expect(elapsed(500)).toBeLessThan(400);
  expect(elapsed(1_000)).toBeLessThan(700);
  expect(elapsed(2_000)).toBeLessThan(1_200);
});
