// #1654: schema/organization reports which contact channels the page shows:
// structured ContactPoint telephone/email, visible mailto:/tel: links and a
// contact form, kept distinct. Informational only; it never asks anyone to
// publish contact details.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { organizationSchemaRule } from "../src/schema/organization";
import type { RuleContext } from "../src/types";

const BASE = "http://127.0.0.1:8765/contact";

function run(html: string, statusCode = 200) {
  const ctx = {
    page: { url: BASE, html, statusCode, loadTime: 0, headers: {} },
    parsed: parsePage(html, BASE),
    options: {},
  } as unknown as RuleContext;
  const checks = organizationSchemaRule.run(ctx).checks as Array<{
    name: string;
    status: string;
    message: string;
    items?: Array<{ id: string; label?: string }>;
  }>;
  const c = checks.find((x) => x.name === "organization-contact-channels");
  const ch: Record<string, string> = {};
  for (const i of c?.items ?? []) ch[i.id] = i.label ?? "";
  return { checks, c, ch };
}

const page = (head: string, body = "<h1>t</h1>") =>
  `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${body}</body></html>`;
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const org = (extra: Record<string, unknown> = {}) => ({
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Acme",
  url: BASE,
  ...extra,
});

describe("schema/organization contact channels (#1654)", () => {
  test("nested ContactPoint telephone is a structured telephone, not an email or a link", () => {
    const r = run(page(ld(org({ contactPoint: { "@type": "ContactPoint", telephone: "+44 20 7946 0000", contactType: "sales" } }))));
    expect(r.ch["structured-telephone"]).toBe("present (json-ld)");
    expect(r.ch["structured-email"]).toBe("absent");
    expect(r.ch["tel-link"]).toBe("absent");
    expect(r.ch["contact-form"]).toBe("absent");
  });

  test("nested ContactPoint email", () => {
    const r = run(page(ld(org({ contactPoint: [{ "@type": "ContactPoint", email: "help@example.test" }] }))));
    expect(r.ch["structured-email"]).toBe("present (json-ld)");
    expect(r.ch["structured-telephone"]).toBe("absent");
  });

  test("a ContactPoint linked by @id reads like a nested one", () => {
    const nested = run(page(ld(org({ contactPoint: { "@type": "ContactPoint", telephone: "+44 20 7946 0000" } }))));
    const linked = run(
      page(
        ld({
          "@graph": [
            org({ "@id": `${BASE}#org`, contactPoint: { "@id": `${BASE}#cp` } }),
            { "@type": "ContactPoint", "@id": `${BASE}#cp`, telephone: "+44 20 7946 0000" },
          ],
        }),
      ),
    );
    expect(linked.ch).toEqual(nested.ch);
  });

  test("only usable mailto: and tel: links are link channels, not structured ones", () => {
    const r = run(page(ld(org()), '<a href="mailto:help@example.test">Email</a> <a href="tel:+442079460000">Call</a>'));
    expect(r.ch["mailto-link"]).toBe("present (html)");
    expect(r.ch["tel-link"]).toBe("present (html)");
    expect(r.ch["structured-telephone"]).toBe("absent");
    expect(r.c?.message).toBe("Contact channels observed on this page: mailto-link, tel-link");
  });

  test("an empty mailto: is not a usable channel", () => {
    const r = run(page(ld(org()), '<a href="mailto:">Email</a>'));
    expect(r.ch["mailto-link"]).toBe("absent");
  });

  test("a page with only a form reports the form alone", () => {
    const r = run(page("", '<form action="/send" method="post"><input name="email" type="email"><textarea name="m"></textarea></form>'));
    expect(r.ch["contact-form"]).toBe("present (html)");
    expect(r.c?.message).toBe("Contact channels observed on this page: contact form only");
    expect(JSON.stringify(r.c)).not.toMatch(/must|should|required/i);
  });

  test("a search form and a login form are not contact forms", () => {
    const r = run(
      page(
        ld(org()),
        '<form role="search"><input type="text"></form><form><input type="email"><input type="password"></form>',
      ),
    );
    expect(r.ch["contact-form"]).toBe("absent");
    expect(r.c?.message).toBe("Contact channels observed on this page: none");
  });

  test("a truncated read leaves unobserved channels unknown and keeps observed ones", () => {
    const html = `<!doctype html><html><head>${ld(org({ contactPoint: { "@type": "ContactPoint", telephone: "+1 555 0100" } }))}</head><body><a href="mailto:a@example.test">x</a><p>cut`;
    const r = run(html);
    expect(r.ch["structured-telephone"]).toBe("present (json-ld)");
    expect(r.ch["mailto-link"]).toBe("present (html)");
    expect(r.ch["structured-email"]).toBe("unknown (incomplete-read)");
    expect(r.ch["contact-form"]).toBe("unknown (incomplete-read)");
  });

  test("a failed read with nothing observed is unknown, never none", () => {
    const r = run(page(ld(org())), 503);
    expect(r.c?.message).toBe("Contact channels on this page: unknown (incomplete read)");
  });

  test("nothing is emitted for a page with no organization, shop or contact signal", () => {
    expect(run(page("")).c).toBeUndefined();
  });

  test("existing organization checks are unchanged and nothing warns from the new check", () => {
    const withContact = run(page(ld(org({ contactPoint: { "@type": "ContactPoint", telephone: "1" } }))));
    const rest = withContact.checks.filter((c) => c.name !== "organization-contact-channels");
    expect(rest.map((c) => c.name)).toEqual(["organization-required", "organization-logo", "organization-social"]);
    expect(withContact.c?.status).toBe("info");
  });
});
