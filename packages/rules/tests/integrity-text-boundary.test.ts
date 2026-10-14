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

test("a label padded past the length cap is still read", () => {
  // Padding glued straight onto the cue, with no space, hides it on main too:
  // that is the hidden-decoy case, tracked separately.
  const padding = "pad ".repeat(100);
  for (const anchor of [
    `<a href="https://credential-fixture.invalid/signin"><style>/*${padding}*/</style>Sign in with Google</a>`,
    `<a href="https://credential-fixture.invalid/signin"><svg><title>${padding}</title></svg>Sign in with Google</a>`,
    `<a href="https://credential-fixture.invalid/signin">Sign in with Google <span class="sr-only">${padding}</span></a>`,
  ]) {
    expect([...detectPageSignals(context(anchor))]).toContain("brand-impersonation");
  }
});

test("nested unclosed anchors cost no more than reading their text", () => {
  // The parser nests an unclosed <a> inside the next, so every anchor holds
  // the rest of the page and reading each label is quadratic however it is
  // done. Reading each one in full twice more took 2,000 of them from about
  // 150 ms to 1.5 to 3.6 s, past the rule's time budget. Measured against a
  // bare textContent loop over the same anchors, so both see the same load.
  const ctx = context(`${'<a href="https://x.invalid/">x'.repeat(2_000)}`);
  const doc = ctx.parsed.document!;
  const best = (run: () => void) => {
    let fastest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 2; i++) {
      const started = performance.now();
      run();
      fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
  };
  const baseline = best(() => {
    for (const a of doc.querySelectorAll("a[href]")) void a.textContent;
  });
  const detector = best(() => {
    detectBrandImpersonation(ctx);
  });
  expect(detector).toBeLessThan(3 * baseline + 100);
});
