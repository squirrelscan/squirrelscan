// ax/webmcp reports declarative WebMCP tools, flags invalid declarations, and never fails or costs score (#396).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { redactFormAction, scanWebMcpDeclarations, webmcpRule } from "../src/ax/webmcp";
import type { CheckResult, RuleContext } from "../src/types";

async function runAll(body: string, head = ""): Promise<CheckResult[]> {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tools</title>${head}</head><body>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
    wantsItemSelectors: true,
  } as unknown as RuleContext;
  const result = await webmcpRule.run(ctx);
  return result.checks;
}

const byName = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

const VALID = `
<form toolname="search_flights" tooldescription="Search flights between two airports" toolautosubmit>
  <input name="origin" required toolparamdescription="IATA code">
  <input name="destination" required>
  <select name="cabin"><option>economy</option></select>
  <input type="radio" name="trip" value="one"><input type="radio" name="trip" value="return">
  <button type="submit">Go</button>
</form>
<form toolname="subscribe" tooldescription="Subscribe to the newsletter"><input type="email" name="email"></form>`;

describe("ax/webmcp declarative tools", () => {
  test("valid tools are reported with details and the schema passes", async () => {
    const checks = await runAll(VALID);
    const tools = byName(checks, "webmcp-declarative-tools");
    expect(tools?.status).toBe("info");
    expect(tools?.message).toContain("2 declarative WebMCP tools");
    expect(tools?.items?.map((i) => i.id)).toEqual(["search_flights", "subscribe"]);
    expect(tools?.items?.[0]?.selector).toContain("form");
    const details = tools?.details as {
      tools: { name: string; description: string; params: string[]; autosubmit: boolean }[];
      relatedRules: string[];
    };
    expect(details.tools[0]).toEqual({
      name: "search_flights",
      description: "Search flights between two airports",
      params: ["origin", "destination", "cabin", "trip"],
      autosubmit: true,
    });
    expect(details.tools[1]?.autosubmit).toBe(false);
    expect(details.relatedRules).toContain("a11y/button-name");
    expect(details.relatedRules).toContain("perf/cls-hints");
    expect(byName(checks, "webmcp-tool-schema")?.status).toBe("pass");
    expect(byName(checks, "webmcp-forms-without-tools")).toBeUndefined();
    expect(checks.some((c) => c.status === "fail" || c.status === "warn")).toBe(false);
  });
});

describe("ax/webmcp schema validation", () => {
  const kinds = (body: string) =>
    scanWebMcpDeclarations(
      parsePage(`<html><body>${body}</body></html>`, "https://example.com/").document!,
    ).problems.map((p) => p.kind);

  test.each([
    [
      "empty toolname",
      `<form toolname="  " tooldescription="d"><input name="a"></form>`,
      "empty-name",
    ],
    [
      "toolname with a space",
      `<form toolname="book a room" tooldescription="d"><input name="a"></form>`,
      "invalid-name",
    ],
    [
      "toolname over 64 characters",
      `<form toolname="${"a".repeat(65)}" tooldescription="d"><input name="a"></form>`,
      "invalid-name",
    ],
    [
      "missing tooldescription",
      `<form toolname="t"><input name="a"></form>`,
      "missing-description",
    ],
    [
      "blank tooldescription",
      `<form toolname="t" tooldescription=" "><input name="a"></form>`,
      "missing-description",
    ],
    [
      "duplicate toolname",
      `<form toolname="t" tooldescription="d"><input name="a"></form><form toolname="t" tooldescription="d"><input name="b"></form>`,
      "duplicate-name",
    ],
    ["toolname on a div", `<div toolname="t" tooldescription="d"></div>`, "toolname-on-non-form"],
    [
      "required control without a name",
      `<form toolname="t" tooldescription="d"><input required></form>`,
      "unnamed-control",
    ],
    [
      "described control without a name",
      `<form toolname="t" tooldescription="d"><input toolparamdescription="x"></form>`,
      "unnamed-control",
    ],
    [
      "titled select without a name",
      `<form toolname="t" tooldescription="d"><select toolparamtitle="x"></select></form>`,
      "unnamed-control",
    ],
    [
      "same name with conflicting types",
      `<form toolname="t" tooldescription="d"><input name="q" type="text"><input name="q" type="number"></form>`,
      "conflicting-param-types",
    ],
    [
      "radio and checkbox sharing a name",
      `<form toolname="t" tooldescription="d"><input name="q" type="radio"><input name="q" type="checkbox"></form>`,
      "conflicting-param-types",
    ],
  ])("%s yields a problem", async (_label, body, kind) => {
    expect(kinds(body)).toContain(kind as never);
    const checks = await runAll(body);
    const schema = byName(checks, "webmcp-tool-schema");
    expect(schema?.status).toBe("warn");
    expect(schema?.items?.some((i) => i.id.startsWith(`${kind}:`))).toBe(true);
    expect(checks.some((c) => c.status === "fail")).toBe(false);
  });

  test.each([
    [
      "a checkbox group",
      `<form toolname="t" tooldescription="d"><input type="checkbox" name="c"><input type="checkbox" name="c"></form>`,
    ],
    [
      "a radio group",
      `<form toolname="t" tooldescription="d"><input type="radio" name="c"><input type="radio" name="c"></form>`,
    ],
    [
      "a hidden input with no name beside a named control",
      `<form toolname="t.v-1_x" tooldescription="d"><input type="hidden"><input name="a"></form>`,
    ],
    [
      "an unnamed submit button",
      `<form toolname="t" tooldescription="d"><input name="a"><input type="submit" required></form>`,
    ],
    [
      "a 64 character name",
      `<form toolname="${"a".repeat(64)}" tooldescription="d"><input name="a"></form>`,
    ],
  ])("%s is valid", (_label, body) => {
    expect(kinds(body)).toEqual([]);
  });

  test("a toolname on a non-form with no tool forms still warns", async () => {
    const checks = await runAll(`<div toolname="t"></div>`);
    expect(byName(checks, "webmcp-declarative-tools")?.message).toBe("No declarative WebMCP tools");
    expect(byName(checks, "webmcp-tool-schema")?.status).toBe("warn");
  });

  test("an invalid page names the offending forms with selectors", async () => {
    const checks = await runAll(
      `<form id="bad" toolname="no good" tooldescription="d"><input name="a"></form>`,
    );
    const schema = byName(checks, "webmcp-tool-schema");
    expect(schema?.items).toHaveLength(1);
    expect(schema?.items?.[0]?.selector).toContain("form#bad");
    expect(schema?.details?.additional).toBeUndefined();
  });

  test("a capped problem list records how many problems were left out", async () => {
    const forms = Array.from(
      { length: 55 },
      (_, i) => `<form toolname="bad ${i}" tooldescription="d"><input name="a"></form>`,
    ).join("");
    const schema = byName(await runAll(forms), "webmcp-tool-schema");
    expect(schema?.status).toBe("warn");
    expect(schema?.items).toHaveLength(50);
    expect(schema?.details?.additional).toBe(5);
  });
});

describe("ax/webmcp pages without WebMCP", () => {
  test("a plain form is informational only", async () => {
    const checks = await runAll(`<form action="/search"><input name="q"></form>`);
    expect(byName(checks, "webmcp-declarative-tools")?.status).toBe("info");
    expect(byName(checks, "webmcp-declarative-tools")?.message).toBe("No declarative WebMCP tools");
    const forms = byName(checks, "webmcp-forms-without-tools");
    expect(forms?.status).toBe("info");
    expect(forms?.items).toHaveLength(1);
    expect(byName(checks, "webmcp-tool-schema")).toBeUndefined();
    expect(checks.every((c) => c.status === "info")).toBe(true);
  });

  test("a form action label drops the query string and fragment", async () => {
    const checks = await runAll(
      `<form action="/reset?token=abc123&email=a%40b.com#step2"><input name="q"></form>` +
        `<form action="?session=xyz"><input name="q"></form>`,
    );
    const items = byName(checks, "webmcp-forms-without-tools")?.items;
    expect(items?.[0]?.label).toBe("form posting to /reset");
    expect(items?.[1]?.label).toBe("form");
    expect(JSON.stringify(items)).not.toContain("abc123");
    expect(JSON.stringify(items)).not.toContain("xyz");
  });

  test("a form action label drops credentials in the URL authority", async () => {
    const checks = await runAll(
      `<form action="https://svc_admin:Xk9pL2mQ7vR4tY8w@api.example.com/submit"><input name="q"></form>` +
        `<form action="//deploy:ghp_secret123@hooks.example.com/in"><input name="q"></form>` +
        `<form action="https://user:pa/ss@host.example.com/x"><input name="q"></form>`,
    );
    const items = byName(checks, "webmcp-forms-without-tools")?.items;
    expect(items?.[0]?.label).toBe("form posting to https://api.example.com/submit");
    expect(items?.[1]?.label).toBe("form posting to //hooks.example.com/in");
    expect(items?.[2]?.label).toBe("form posting to https://host.example.com/x");
    for (const secret of ["svc_admin", "Xk9pL2mQ7vR4tY8w", "ghp_secret123", "deploy", "pa/ss"]) {
      expect(JSON.stringify(items)).not.toContain(secret);
    }
  });

  test("redactFormAction keeps a normal path, host:port and an @ in the path", () => {
    expect(redactFormAction("/users/@me")).toBe("/users/@me");
    expect(redactFormAction("https://h.example.com:8080/@me")).toBe(
      "https://h.example.com:8080/@me",
    );
    expect(redactFormAction(" ht\ttps://u:p@h.example.com/a?t=1#f")).toBe(
      "https://h.example.com/a",
    );
    expect(redactFormAction("https:/u:p@h.example.com/x")).toBe("https:/h.example.com/x");
    expect(redactFormAction("https:\\\\u:p@h.example.com\\x")).toBe("https:\\\\h.example.com\\x");
  });

  test("a form with only hidden inputs or buttons is not listed", async () => {
    const checks = await runAll(
      `<form><input type="hidden" name="csrf"><button>Go</button></form>`,
    );
    expect(byName(checks, "webmcp-forms-without-tools")).toBeUndefined();
  });

  test("a page with no forms reports no tools and nothing else", async () => {
    const checks = await runAll(`<p>Hello</p>`);
    expect(checks.map((c) => c.name)).toEqual(["webmcp-declarative-tools"]);
    expect(checks[0]?.status).toBe("info");
  });

  test("no parsed document is skipped", async () => {
    const result = await webmcpRule.run({
      page: { url: "https://example.com/", headers: {} },
      parsed: { document: null },
      options: {},
    } as unknown as RuleContext);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.status).toBe("skipped");
  });
});

describe("ax/webmcp imperative API", () => {
  test("an inline registerTool call is detected", async () => {
    const checks = await runAll(`<script>navigator.modelContext.registerTool({name:"x"})</script>`);
    const c = byName(checks, "webmcp-imperative");
    expect(c?.status).toBe("info");
    expect(c?.message).toContain("not validated");
  });

  test("an inline provideContext call is detected", async () => {
    const checks = await runAll(
      `<script type="module">navigator.modelContext.provideContext({tools:[]})</script>`,
    );
    expect(byName(checks, "webmcp-imperative")?.status).toBe("info");
  });

  test("an external script is not scanned", async () => {
    const checks = await runAll(
      `<script src="/tools.js">navigator.modelContext.registerTool({})</script>`,
    );
    expect(byName(checks, "webmcp-imperative")).toBeUndefined();
  });

  test("JSON script types and unrelated mentions are ignored", async () => {
    expect(
      (
        await runAll(`<script type="application/json">navigator.modelContext.registerTool</script>`)
      ).some((c) => c.name === "webmcp-imperative"),
    ).toBe(false);
    expect(
      (await runAll(`<script>navigator.modelContext</script>`)).some(
        (c) => c.name === "webmcp-imperative",
      ),
    ).toBe(false);
  });
});

describe("ax/webmcp challenge on a tool form", () => {
  const tool = (inner: string) =>
    `<form toolname="contact" tooldescription="Send a message"><input name="m">${inner}</form>`;

  test.each([
    ["reCAPTCHA", `<div class="g-recaptcha" data-sitekey="k"></div>`],
    ["hCaptcha", `<div class="h-captcha" data-sitekey="k"></div>`],
    ["Friendly Captcha", `<div class="frc-captcha" data-sitekey="k"></div>`],
    ["Turnstile", `<div class="cf-turnstile" data-sitekey="k"></div>`],
  ])("a visible %s widget is reported", async (provider, widget) => {
    const c = byName(await runAll(tool(widget)), "webmcp-tool-form-challenge");
    expect(c?.status).toBe("info");
    expect(c?.message).toContain("security/form-captcha");
    expect(c?.message).toContain("invisible or agent-tolerant");
    expect(c?.items?.[0]?.label).toContain(provider);
  });

  test.each([
    ["invisible reCAPTCHA widget", `<div class="g-recaptcha" data-size="invisible"></div>`],
    ["invisible hCaptcha widget", `<div class="h-captcha" data-size="invisible"></div>`],
    ["reCAPTCHA bound to the button", `<button class="g-recaptcha" data-sitekey="k">Send</button>`],
    [
      "interaction-only Turnstile",
      `<div class="cf-turnstile" data-appearance="interaction-only"></div>`,
    ],
  ])("an %s is not reported", async (_label, widget) => {
    expect(byName(await runAll(tool(widget)), "webmcp-tool-form-challenge")).toBeUndefined();
  });

  test("a challenge on a form that is not a tool is not reported", async () => {
    const checks = await runAll(`<form><input name="m"><div class="g-recaptcha"></div></form>`);
    expect(byName(checks, "webmcp-tool-form-challenge")).toBeUndefined();
  });
});

describe("ax/webmcp is never a failure", () => {
  test("no check across every shape is fail", async () => {
    const bodies = [
      VALID,
      `<form toolname="" ><input required></form><div toolname="x"></div>`,
      `<form><input name="q"></form>`,
      `<script>navigator.modelContext.registerTool({})</script>`,
      `<form toolname="t" tooldescription="d"><div class="g-recaptcha"></div><input name="a"></form>`,
      ``,
    ];
    for (const body of bodies) {
      for (const c of await runAll(body)) expect(c.status).not.toBe("fail");
    }
  });
});
