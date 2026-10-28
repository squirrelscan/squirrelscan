import { describe, expect, test } from "bun:test";
import { detectTechnologies } from "../src/detect";
import type { TechDetectInput } from "../src/types";

function input(partial: Partial<TechDetectInput>): TechDetectInput {
  return { url: "https://example.com/", headers: {}, html: "", ...partial };
}

function ids(i: TechDetectInput): string[] {
  return detectTechnologies(i).map((t) => t.id);
}

const IDS = ["lovable", "base44", "replit", "v0", "supabase", "clerk", "firebase"];

// A blog post that talks about every product, with code samples shown escaped in
// <pre>, and hosts written as prose. None of it is the product running.
const BLOG = `<!doctype html><html><head><title>Lovable vs Base44 vs Replit vs v0</title>
<meta name="author" content="Jane Writer"><meta name="generator" content="WordPress 6.5">
<meta name="twitter:site" content="@janewrites"></head><body>
<p>We compared Lovable, Base44, Replit and v0.app. Apps land on lovable.app, base44.app or replit.app.</p>
<p>Visit https://my-app.replit.app or https://my-app.base44.app to see one. Supabase and Clerk and Firebase also come up.</p>
<pre>&lt;script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"&gt;&lt;/script&gt;
&lt;script src="https://www.gstatic.com/firebasejs/9.13.0/firebase-app-compat.js"&gt;&lt;/script&gt;
const supabase = createClient(url, key) // https://your-project.supabase.co</pre>
<p>Use data-clerk-publishable-key in your layout. The localStorage key is not base44_token.</p>
</body></html>`;

describe("vibe-coding builder and BaaS fingerprints", () => {
  test("a blog post that only mentions the products matches none of them", () => {
    const found = ids(input({ html: BLOG })).filter((id) => IDS.includes(id));
    expect(found).toEqual([]);
  });

  test("a bare page matches none of them", () => {
    const html = `<!doctype html><html><head><title>Hi</title></head><body><h1>Hi</h1></body></html>`;
    expect(ids(input({ html })).filter((id) => IDS.includes(id))).toEqual([]);
  });

  describe("lovable", () => {
    test("Vite template head (author + twitter:site + badge)", () => {
      const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8" />
<title>Front-end Dev Portfolio</title><meta name="author" content="Lovable" />
<meta name="twitter:site" content="@Lovable" /></head><body><div id="root"></div></body></html>`;
      expect(ids(input({ html }))).toContain("lovable");
    });

    test("TanStack Start head with only the twitter:site default", () => {
      const html = `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>Game</title><meta name="author" content="Some Studio"/><meta name="twitter:site" content="@Lovable"/></head><body></body></html>`;
      expect(ids(input({ html }))).toContain("lovable");
    });

    test("hosted artifact script", () => {
      const src = "/__l5e/events.b21a279f52bb8621.js";
      const html = `<script defer src="${src}" data-artifact-kind="dwl_content_hash"></script>`;
      expect(ids(input({ html, scripts: [{ url: src }] }))).toContain("lovable");
    });

    test("legacy gptengineer script", () => {
      const src = "https://cdn.gpteng.co/gptengineer.js";
      const html = `<script src="${src}" type="module"></script>`;
      expect(ids(input({ html, scripts: [{ url: src }] }))).toContain("lovable");
    });

    test("uploaded social image bucket", () => {
      const html = `<meta property="og:image" content="https://storage.googleapis.com/gpt-engineer-file-uploads/abc/social-images/x.webp">`;
      expect(ids(input({ html }))).toContain("lovable");
    });

    test("near-miss: someone else's author and twitter handle", () => {
      const html = `<meta name="author" content="Lovable Bakery Co"><meta name="twitter:site" content="@lovablebakery">`;
      expect(ids(input({ html }))).not.toContain("lovable");
    });
  });

  describe("base44", () => {
    test("published app: inline auth shim and app-log beacon", () => {
      const html = `<html><head><script>var TOKEN_KEY = 'base44_access_token';</script>
<script type="module">fetch(\`/api/app-logs/6a607ab7c371d1470d78d44d/log-user-in-app/\${pageName}\`)</script></head></html>`;
      expect(ids(input({ html }))).toContain("base44");
    });

    test("base44.app host", () => {
      expect(ids(input({ url: "https://my-tool.base44.app/" }))).toContain("base44");
    });

    test("near-miss: a look-alike host and a page that links to one", () => {
      expect(ids(input({ url: "https://base44.app.example.com/" }))).not.toContain("base44");
      const html = `<a href="https://my-tool.base44.app/">demo</a>`;
      expect(ids(input({ html }))).not.toContain("base44");
    });
  });

  describe("replit", () => {
    test("deployed host", () => {
      expect(ids(input({ url: "https://my-app.replit.app/" }))).toContain("replit");
      expect(ids(input({ url: "https://x.y.kirk.replit.dev/u/someone" }))).toContain("replit");
      expect(ids(input({ url: "https://old-app.user.repl.co/" }))).toContain("replit");
    });

    test("dev banner script and platform static path", () => {
      const src = "https://replit.com/public/js/replit-dev-banner.js";
      expect(ids(input({ html: `<script src="${src}"></script>`, scripts: [{ url: src }] }))).toContain(
        "replit",
      );
      const html = `<style>@font-face{src:url("/__replco/static/fonts/ReplitDiatypeVariable.woff2")}</style>`;
      expect(ids(input({ html }))).toContain("replit");
    });

    test("near-miss: a look-alike host, and replit.com itself without the markers", () => {
      expect(ids(input({ url: "https://replit.app.evil.example/" }))).not.toContain("replit");
      expect(ids(input({ url: "https://notreplit.app/" }))).not.toContain("replit");
    });
  });

  describe("v0", () => {
    test("generator meta", () => {
      const html = `<head><title>x</title><meta name="generator" content="v0.app"/></head>`;
      expect(ids(input({ html }))).toContain("v0");
      expect(ids(input({ meta: { generator: "v0.dev" } }))).toContain("v0");
    });

    test("near-miss: another generator that contains v0", () => {
      expect(ids(input({ meta: { generator: "Hugo v0.123.0" } }))).not.toContain("v0");
    });
  });

  describe("supabase", () => {
    const ref = "abcdefghijklmnopqrst";

    test("storage image in an attribute", () => {
      const html = `<img src="https://${ref}.supabase.co/storage/v1/object/public/avatars/u1.jpg" alt="">`;
      expect(ids(input({ html }))).toContain("supabase");
    });

    test("next/image proxy URL (encoded)", () => {
      const u = `https%3A%2F%2F${ref}.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Fb%2Fx.png`;
      expect(ids(input({ html: `<img src="/_next/image?url=${u}&w=640&q=75">` }))).toContain(
        "supabase",
      );
    });

    test("inline client config and the CDN client build", () => {
      const inline = `<script>const sb = supabase.createClient('https://${ref}.supabase.co', 'anon')</script>`;
      expect(ids(input({ html: inline }))).toContain("supabase");
      const cdn = `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>`;
      expect(ids(input({ html: cdn }))).toContain("supabase");
    });

    test("near-miss: placeholder project in prose and a non-ref subdomain", () => {
      const html = `<p>Set it to https://your-project.supabase.co/storage/v1 in .env</p><a href="https://status.supabase.co/">status</a>`;
      expect(ids(input({ html }))).not.toContain("supabase");
    });
  });

  describe("clerk", () => {
    test("clerk-js script tag with a custom frontend API host", () => {
      const src = "https://clerk.example.com/npm/@clerk/clerk-js@6/dist/clerk.browser.js";
      const html = `<script src="${src}" data-clerk-js-script="true" async crossorigin="anonymous" data-clerk-publishable-key="pk_live_Y2xlcmsuZXhhbXBsZS5jb20k"></script>`;
      const found = detectTechnologies(input({ html, scripts: [{ url: src }] })).find(
        (t) => t.id === "clerk",
      );
      expect(found).toBeDefined();
      expect(found?.version).toBe("6");
    });

    test("dev instance host", () => {
      const src = "https://sunny-owl-12.clerk.accounts.dev/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
      expect(ids(input({ html: "", scripts: [{ url: src }] }))).toContain("clerk");
    });

    test("near-miss: Clerk named as a vendor, an unrelated clerk script", () => {
      const html = `<p>Our clerk.js helper and the Clerk docs.</p><script src="/assets/clerk-widget.js"></script>`;
      expect(ids(input({ html, scripts: [{ url: "/assets/clerk-widget.js" }] }))).not.toContain(
        "clerk",
      );
    });
  });

  describe("firebase", () => {
    test("gstatic SDK script with version", () => {
      const src = "https://www.gstatic.com/firebasejs/9.13.0/firebase-app-compat.js";
      const found = detectTechnologies(
        input({ html: `<script src="${src}"></script>`, scripts: [{ url: src }] }),
      ).find((t) => t.id === "firebase");
      expect(found?.version).toBe("9.13.0");
    });

    test("Hosting reserved init script and inline web config", () => {
      const src = "/__/firebase/init.js";
      expect(ids(input({ html: `<script src="${src}"></script>`, scripts: [{ url: src }] }))).toContain(
        "firebase",
      );
      const cfg = `<script>const firebaseConfig = { apiKey: "x", authDomain: "my-app-1234.firebaseapp.com", projectId: "my-app-1234" };</script>`;
      expect(ids(input({ html: cfg }))).toContain("firebase");
    });

    test("firebase hosting host alone is Hosting, not the SDK", () => {
      const found = ids(input({ url: "https://my-app-1234.web.app/", html: "<p>hi</p>" }));
      expect(found).toContain("firebase-hosting");
      expect(found).not.toContain("firebase");
    });

    test("near-miss: prose and a link to the console", () => {
      const html = `<p>Create a Firebase project, then add firebaseapp.com to your allowlist.</p><a href="https://console.firebase.google.com/">console</a>`;
      expect(ids(input({ html }))).not.toContain("firebase");
    });
  });
});
