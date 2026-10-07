// content/placeholder-contact: template-default contact details.
//
// Every string here is something a developer docs page prints on purpose, so the
// no-false-positive fixtures carry more weight than the detection cases.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import {
  classifyContactPage,
  findPlaceholderContacts,
  placeholderContactRule,
} from "../src/content/placeholder-contact";
import { rules as contentRules } from "../src/content";
import { loadAllRules } from "../src/loader";
import type { ParsedPage, RuleContext } from "../src/types";

function run(html: string, url = "https://shop.test/about-the-team", pageType?: string) {
  const { document } = parseHTML(html);
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document, pageType } as unknown as ParsedPage,
    options: {},
  };
  return placeholderContactRule.run(ctx).checks;
}

const page = (body: string) => `<html><head><title>t</title></head><body>${body}</body></html>`;
const kinds = (text: string, hrefs: string[] = []) =>
  findPlaceholderContacts(text, hrefs).map((f) => f.kind);

describe("findPlaceholderContacts: emails", () => {
  test.each([
    "info@example.com",
    "sales@example.org",
    "me@test.com",
    "you@yourdomain.com",
    "email@email.com",
    "hello@mail.example.com",
  ])("%s is a placeholder", (email) => {
    expect(kinds(`Write to ${email} today.`)).toEqual(["email"]);
  });

  test("a sentence-ending dot still matches", () => {
    expect(kinds("Email info@example.com.")).toEqual(["email"]);
  });

  test("real and look-alike domains stay clean", () => {
    expect(kinds("hello@acme.io and a@notexample.com and b@example.com.au")).toEqual([]);
    expect(kinds("hello@mytest.com and x@email.com.au")).toEqual([]);
  });

  test("a mailto: target is judged even when the link text is not", () => {
    expect(kinds("Email us", ["mailto:info@example.com?subject=Hi"])).toEqual(["email"]);
    expect(kinds("Email us", ["mailto:team@acme.io"])).toEqual([]);
  });
});

describe("findPlaceholderContacts: phones", () => {
  test.each([
    "(212) 555-0123",
    "555-0100",
    "415.555.0199",
    "+44 7700 900123",
    "+44 (0)7700 900 456",
    "07700 900789",
    "0000000000",
    "000-000-0000",
  ])("%s is reserved or fictional", (phone) => {
    expect(kinds(`Call ${phone} now`)).toEqual(["phone"]);
  });

  test("real numbers stay clean", () => {
    expect(kinds("Call (212) 555-0200 or 555-1234 or +44 7700 901000 or 07911 123456")).toEqual([]);
    expect(kinds("Order 10000000000 shipped")).toEqual([]);
  });

  test("a tel: target is judged", () => {
    expect(kinds("Call us", ["tel:+44-7700-900123"])).toEqual(["phone"]);
    expect(kinds("Call us", ["tel:0000000000"])).toEqual(["phone"]);
  });
});

describe("findPlaceholderContacts: addresses", () => {
  test("template street, locality and zip lines", () => {
    expect(kinds("Visit 123 Main St, Springfield")).toEqual(["address"]);
    expect(kinds("123 Main Street")).toEqual(["address"]);
    expect(kinds("1234 Street Address")).toEqual(["address"]);
    expect(kinds("City, State 12345")).toEqual(["address"]);
  });

  test("real addresses stay clean", () => {
    expect(kinds("1123 Main St and 45 Main Street and Austin, Texas 78701")).toEqual([]);
  });
});

describe("findPlaceholderContacts: social", () => {
  test("placeholder handles and profile URLs", () => {
    expect(kinds("Follow @yourhandle")).toEqual(["social"]);
    expect(kinds("Follow @username")).toEqual(["social"]);
    expect(kinds("Follow us", ["https://facebook.com/yourpage"])).toEqual(["social"]);
    expect(kinds("Follow us", ["https://www.facebook.com/yourpage/"])).toEqual(["social"]);
    expect(kinds("Follow us", ["https://x.com/yourhandle"])).toEqual(["social"]);
    expect(kinds("Follow us", ["https://linkedin.com/company/yourcompany"])).toEqual(["social"]);
  });

  test("an email-shaped handle and real profiles stay clean", () => {
    expect(kinds("Mail jo@username.net or follow @acme", ["https://facebook.com/acme"])).toEqual([]);
  });

  test("handle samples and URL samples merge into one finding", () => {
    const f = findPlaceholderContacts("Follow @yourhandle", ["https://x.com/username"]);
    expect(f).toHaveLength(1);
    expect(f[0]!.count).toBe(2);
  });
});

describe("classifyContactPage", () => {
  test("contact and checkout pages are critical", () => {
    expect(classifyContactPage("https://a.test/contact")).toBe("critical");
    expect(classifyContactPage("https://a.test/contact-us/")).toBe("critical");
    expect(classifyContactPage("https://a.test/shop/checkout")).toBe("critical");
    expect(classifyContactPage("https://a.test/x", "contact")).toBe("critical");
  });

  test("documentation paths are docs, everything else standard", () => {
    expect(classifyContactPage("https://a.test/docs/email-setup")).toBe("docs");
    expect(classifyContactPage("https://a.test/developers/api/send")).toBe("docs");
    expect(classifyContactPage("https://a.test/pricing")).toBe("standard");
  });
});

describe("placeholderContactRule", () => {
  test("skipped without a document", () => {
    const ctx = { page: { url: "https://a.test/" }, parsed: {}, options: {} } as unknown as RuleContext;
    const [c] = placeholderContactRule.run(ctx).checks;
    expect(c!.status).toBe("skipped");
  });

  test("skipped without a body", () => {
    const [c] = run("<html></html>");
    expect(c!.status).toBe("skipped");
    expect(c!.skipReason).toBe("no-body");
  });

  test("skipped on a documentation page", () => {
    const [c] = run(page("<p>Use info@example.com</p>"), "https://a.test/docs/mail");
    expect(c!.status).toBe("skipped");
  });

  test("pass on real contact details", () => {
    const [c] = run(page("<p>Call 020 7946 0958 or write to hi@acme.io</p>"), "https://a.test/contact");
    expect(c!.status).toBe("pass");
  });

  test("fail on a contact page", () => {
    const [c] = run(page("<p>Call (212) 555-0123</p>"), "https://a.test/contact");
    expect(c!.status).toBe("fail");
    expect(c!.items?.map((i) => i.id)).toEqual(["phone"]);
    expect(c!.message).toContain("contact or checkout page");
  });

  test("fail on a checkout page, and on schema-detected contact pages", () => {
    expect(run(page("<p>info@example.com</p>"), "https://a.test/checkout")[0]!.status).toBe("fail");
    expect(run(page("<p>info@example.com</p>"), "https://a.test/x", "contact")[0]!.status).toBe("fail");
  });

  test("warn elsewhere", () => {
    const [c] = run(page("<footer>123 Main St</footer><p>Follow @yourhandle</p>"));
    expect(c!.status).toBe("warn");
    expect(c!.items?.map((i) => i.id)).toEqual(["address", "social"]);
  });

  test("a placeholder mailto link is found", () => {
    const [c] = run(page('<a href="mailto:info@example.com">Email us</a>'), "https://a.test/contact");
    expect(c!.status).toBe("fail");
  });

  test("no false positive: a developer docs page showing user@example.com in a code block", () => {
    const html = page(
      `<h1>Sending mail</h1><p>Pass the recipient:</p>
       <pre><code>send({ to: "user@example.com", phone: "555-0123" })</code></pre>
       <p>Or inline <code>info@example.com</code>.</p>
       <div class="language-js"><span>user@example.org</span></div>
       <pre><a href="mailto:user@example.com">x</a></pre>`,
    );
    for (const url of ["https://a.test/blog/sending-mail", "https://a.test/contact"]) {
      expect(run(html, url)[0]!.status).toBe("pass");
    }
  });

  test("a <template> is inert", () => {
    expect(run(page("<template><p>info@example.com</p></template>"))[0]!.status).toBe("pass");
  });

  test("is registered once, in the loader's content group", () => {
    expect(contentRules).toContain(placeholderContactRule);
    expect(loadAllRules().get("content/placeholder-contact")).toBe(placeholderContactRule);
  });
});
