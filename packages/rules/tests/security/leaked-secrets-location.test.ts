// security/leaked-secrets: every item says how long its value is and where it
// sits (#1230). Values are synthetic and built at runtime; the value itself
// never appears in the output, only its masked id.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { leakedSecretsRule, scanPageForSecrets } from "../../src/security/leaked-secrets";
import type { CheckItem, RuleContext } from "../../src/types";
import { mixedRun, seededRng } from "./leaked-secrets/generators";

const PAGE = "https://app.acme.test/";
const STRIPE = "sk_" + "live_";

function ctx(html: string, scripts: Array<{ url: string; content: string }> = []): RuleContext {
  return {
    site: {
      baseUrl: PAGE,
      pages: [{ url: PAGE, statusCode: 200, parsed: parsePage(html, PAGE) }],
      robotsTxt: null,
      sitemaps: null,
      scripts: scripts.map((s) => ({ ...s, status: 200, error: null, contentType: "application/javascript", sizeBytes: s.content.length, sourcePages: [PAGE] })),
    },
    options: {},
  } as unknown as RuleContext;
}

function items(html: string, scripts: Array<{ url: string; content: string }> = []): CheckItem[] {
  const result = leakedSecretsRule.run(ctx(html, scripts));
  const checks = (result as { checks: Array<{ items?: CheckItem[] }> }).checks;
  return checks.flatMap((c) => c.items ?? []);
}

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe("meta.length", () => {
  test("a 32-character and a 200-character value are told apart", () => {
    const r = seededRng(1230);
    const short = mixedRun(r, 32);
    const long = mixedRun(r, 200);
    const a = items(page(`<script>var c={apiKey:"${short}"};</script>`));
    const b = items(page(`<script>var c={apiKey:"${long}"};</script>`));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    // The masked ids have the same shape; the length is what differs.
    expect(a[0]!.id.length).toBe(b[0]!.id.length);
    expect(a[0]!.meta?.length).toBe(`apiKey:"${short}"`.length);
    expect(b[0]!.meta?.length).toBe(`apiKey:"${long}"`.length);
  });

  test("equals the length of the matched value for a prefixed token", () => {
    const key = STRIPE + mixedRun(seededRng(1), 24);
    expect(items(page(`<script>var k="${key}";</script>`))[0]?.meta?.length).toBe(key.length);
  });
});

describe("meta.offset points at the first character of the match", () => {
  const r = seededRng(1231);
  const key = STRIPE + mixedRun(r, 24);
  const generic = mixedRun(r, 40);

  test("in an external script", () => {
    const body = `${"/* padding */\n".repeat(50)}var a=1;var k="${key}";\nvar c={apiKey:"${generic}"};`;
    const found = items(page(""), [{ url: "https://app.acme.test/app.js", content: body }]);
    const stripe = found.find((i) => i.id.startsWith("Stripe Live Key"));
    const assigned = found.find((i) => i.id.startsWith("Generic API Key Assignment"));
    expect(body.slice(stripe!.meta!.offset as number, (stripe!.meta!.offset as number) + (stripe!.meta!.length as number))).toBe(key);
    const at = assigned!.meta!.offset as number;
    expect(body.slice(at, at + (assigned!.meta!.length as number))).toBe(`apiKey:"${generic}"`);
    expect(stripe!.meta).not.toHaveProperty("scriptIndex");
  });

  test("in an inline script, with the script's index", () => {
    const first = `var a = 1;`;
    const second = `\n// header\nvar k = "${key}";\n`;
    const html = page(`<script>${first}</script><script src="/x.js"></script><script type="text/plain" id="n">${second}</script>`);
    const found = scanPageForSecrets(parsePage(html, PAGE).document!, PAGE).filter((f) => f.location === "inline-script");
    expect(found).toHaveLength(1);
    const f = found[0]!;
    // `src` scripts are not inline scripts, so the second inline script is index 1.
    expect(f.scriptIndex).toBe(1);
    expect(second.slice(f.offset!, f.offset! + f.length)).toBe(key);
    // The same through the rule's items.
    const item = items(html)[0]!;
    expect(item.meta).toMatchObject({ length: key.length, offset: f.offset, scriptIndex: 1 });
  });

  test("in the serialized page for html", () => {
    const html = page(`<p>hello</p><div data-token="${key}"></div>`);
    const doc = parsePage(html, PAGE).document!;
    const f = scanPageForSecrets(doc, PAGE).find((s) => s.location === "html")!;
    const text = doc.toString();
    expect(text.slice(f.offset!, f.offset! + f.length)).toBe(key);
    expect(f.scriptIndex).toBeUndefined();
  });

  test("past escapes that decoding shortens, the offset is still into the served text", () => {
    const body = `var a="&quot;&quot;&quot;&amp;&amp;&lt;&gt;";var k="${key}";`;
    const found = items(page(""), [{ url: "https://app.acme.test/a.js", content: `\\u0041\\u0042 ${body}` }]);
    const content = `\\u0041\\u0042 ${body}`;
    const at = found[0]!.meta!.offset as number;
    expect(content.slice(at, at + key.length)).toBe(key);
  });

  test("a value that only exists decoded has a length and no offset", () => {
    const escaped = [...key].map((c, i) => (i % 2 ? `\\x${c.charCodeAt(0).toString(16)}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)).join("");
    const meta = items(page(""), [{ url: "https://app.acme.test/e.js", content: `var k="${escaped}";` }])[0]!.meta!;
    expect(meta.length).toBe(key.length);
    expect(meta).not.toHaveProperty("offset");
    const blob = Buffer.from(`{"apiKey":"${generic}"}`).toString("base64");
    const decoded = items(page(`<script>window.__C__="${blob}";</script>`))[0]!;
    expect(decoded.meta).toHaveProperty("length");
    expect(decoded.meta).not.toHaveProperty("offset");
  });
});

describe("the value stays masked", () => {
  test("the id is unchanged and the full value appears nowhere in the output", () => {
    const key = STRIPE + mixedRun(seededRng(3), 24);
    const result = leakedSecretsRule.run(ctx(page(`<script>var k="${key}";</script>`)));
    const found = (result as { checks: Array<{ items?: CheckItem[] }> }).checks.flatMap((c) => c.items ?? []);
    expect(found[0]!.id).toBe(`Stripe Live Key: ${key.slice(0, 6)}${"*".repeat(20)}${key.slice(-4)}`);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  test("the decoded structure still rides along beside the location", () => {
    const token = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: "acme", scope: "admin" })).toString("base64url")}.${mixedRun(seededRng(4), 43)}`;
    const meta = items(page(`<script>var t="${token}";</script>`))[0]!.meta!;
    expect(meta).toMatchObject({ issuer: "acme", length: token.length });
    expect(typeof meta.offset).toBe("number");
  });
});
