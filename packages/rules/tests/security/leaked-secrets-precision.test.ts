// security/leaked-secrets — precision of the generic assignments and of
// provider attribution.
//
// Each block pairs the negatives a fix silences with the positive controls it
// must not silence, and every one runs offline from seeded or inline synthetic
// values: nothing here is a real credential, and every value is assembled from
// parts at runtime so no line is a whole token-shaped literal.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import {
  leakedSecretsRule,
  PROVIDER_KEY_PREFIXES,
  scanContent,
  unattributedKeyType,
} from "../../src/security/leaked-secrets";
import type { RuleContext } from "../../src/types";
import { awsKeySuffix, mixedRun, runOf, seededRng } from "./leaked-secrets/generators";

const PAGE_URL = "https://app.acme.test/";
const HEX = "0123456789abcdef";

function ctx(html: string): RuleContext {
  return {
    site: {
      baseUrl: PAGE_URL,
      pages: [{ url: PAGE_URL, statusCode: 200, parsed: parsePage(html, PAGE_URL) }],
      robotsTxt: null,
      sitemaps: null,
      scripts: [],
    },
    options: {},
  } as unknown as RuleContext;
}

/** `[check, type]` for every item the rule reports on a page. */
function reported(html: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const check of leakedSecretsRule.run(ctx(html)).checks) {
    for (const item of check.items ?? []) out.push([check.name, item.id.slice(0, item.id.lastIndexOf(": "))]);
  }
  return out;
}

const script = (js: string) => `<!doctype html><html><body><script>${js}</script></body></html>`;
const body = (html: string) => `<!doctype html><html><body>${html}</body></html>`;

// A synthetic password: random, with digits and symbols, never a word.
const PASSWORD = "K8#m" + "Z2!qX7vP"; // pragma: allowlist secret

describe("generic assignments: labels and expressions are not values", () => {
  test("a JSX label ending in the credential word does not span into the code after it", () => {
    const negatives = [
      `(0,r.jsx)("label",{htmlFor:"pw",children:"Password:"}),(0,r.jsx)("input",{id:"pw",type:"password"})`,
      `e.jsx("span",{children:"Confirm password:"}),e.jsx(Field,{name:"confirm"})`,
      `jsx("label",{children:'Contraseña segura:'}),jsx("input",{id:'a'})`,
    ];
    for (const js of negatives) expect(reported(script(js))).toEqual([]);
  });

  test("a translated password label is not a secret", () => {
    const negatives = [
      `{"auth.password":"Contraseña","auth.title":"Iniciar"}`, // pragma: allowlist secret
      `{password:"Passwort",confirmPassword:"Kennwort"}`, // pragma: allowlist secret
      `{labelPassword:"Wachtwoord"}`, // pragma: allowlist secret
      `{password:"Lösenord"}`, // pragma: allowlist secret
      `{password:"Mot-de-passe"}`, // pragma: allowlist secret
      `{password:"Adgangskode"}`, // pragma: allowlist secret
    ];
    for (const js of negatives) expect(reported(script(js))).toEqual([]);
  });

  test("a template expression standing in for the value is not a secret", () => {
    expect(reported(body(`<input type="password" password="{form.password}">`))).toEqual([]);
    expect(reported(script(`{password:"{{ user.password }}"}`))).toEqual([]);
    expect(reported(script(`{secret_key:"<%= config.secret %>"}`))).toEqual([]);
  });

  test("positive controls: real-shaped assignments beside labels, sampleRate and docs text still report", () => {
    const apiKey = mixedRun(seededRng(5101), 32);
    const pages = [
      // An HTML attribute after a closing quote is an assignment, not a label.
      body(`<x-login value="hello" password="${PASSWORD}"></x-login>`),
      // Real config beside telemetry options.
      script(`Sentry.init({sampleRate:0.25,tracesSampleRate:1});var cfg={sampleRate:1,password:"${PASSWORD}"};`),
      script(`var cfg={sampleRate:0.5,apiKey:"${apiKey}"};`),
      // Documentation prose next to a real assignment.
      body(`<p>Documentation: set the password below before you deploy.</p><script>var c={password:"${PASSWORD}"}</script>`),
      // A label in the same bundle does not hide the real value after it.
      script(`a.jsx("label",{children:"Password:"});var c={password:"${PASSWORD}"};`),
      // One accented letter among digits and symbols is still a password.
      script(`var c={password:"Kä8#mZ2!qX"};`), // pragma: allowlist secret
      // A quote followed by a space closes an earlier string, not a label.
      script(`var c={name: "bob" password: "${PASSWORD}"};`),
    ];
    for (const html of pages) {
      const found = reported(html);
      expect(found.length).toBe(1);
      expect(found[0]![0]).toBe("leaked-secrets-medium");
      expect(found[0]![1]).toMatch(/^Generic (Secret|API Key) Assignment$/);
    }
  });
});

describe("connection strings: documentation placeholders are not credentials", () => {
  test("a placeholder password reports nothing", () => {
    const negatives = [
      `<pre><code>postgresql://username:password@host:5432/dbname</code></pre>`, // pragma: allowlist secret
      `<code>postgres://user:pass@localhost:5432/app</code>`, // pragma: allowlist secret
      `<code>mysql://root:\${DB_PASSWORD}@db:3306/shop</code>`,
      `<code>redis://default:****@cache:6379</code>`,
      `<code>mongodb+srv://app:your_password@cluster0.mongo.acme.test/db</code>`, // pragma: allowlist secret
      `<code>postgresql://app@host/db?password=YOUR_PASSWORD</code>`,
    ];
    for (const html of negatives) expect(reported(body(html))).toEqual([]);
  });

  test("a real-looking password under a placeholder host or database is kept, at medium", () => {
    const secret = mixedRun(seededRng(5102), 18);
    const found = reported(body(`<code>postgresql://admin:${secret}@host:5432/dbname</code>`));
    expect(found).toEqual([["leaked-secrets-medium", "PostgreSQL Connection String"]]);
    const raw = scanContent(`postgresql://admin:${secret}@host:5432/dbname`, "html");
    expect(raw[0]?.extra).toEqual({ placeholder: "host" });
  });

  test("positive controls: a deployed connection string stays high", () => {
    const secret = mixedRun(seededRng(5103), 18);
    // A symbol-only password is not a mask.
    expect(reported(body(`<pre>postgres://app:!!!!----@db.internal.acme.test:5432/app</pre>`))).toEqual([ // pragma: allowlist secret
      ["leaked-secrets-high", "PostgreSQL Connection String"],
    ]);
    expect(reported(body(`<pre>DATABASE_URL=postgres://app:${secret}@db.internal.acme.test:5432/app</pre>`))).toEqual([
      ["leaked-secrets-high", "PostgreSQL Connection String"],
    ]);
    // A placeholder in the authority does not hide a real query password.
    expect(reported(body(`<pre>postgresql://app:password@db.acme.test/app?password=${secret}</pre>`))).toEqual([ // pragma: allowlist secret
      ["leaked-secrets-high", "PostgreSQL Connection String"],
    ]);
  });
});

describe("provider tokens: a substring of a longer value is not the provider's token", () => {
  const r = seededRng(5201);
  const mailgunBody = mixedRun(r, 32);
  const twilioBody = runOf(r, HEX, 32);
  const awsKey = "AKIA" + awsKeySuffix(r); // pragma: allowlist secret

  test("a provider shape continued by more token characters is not reported", () => {
    const negatives = [
      script(`var asset={id:"key-${mailgunBody}${mixedRun(r, 12)}"};`),
      script(`var asset={id:"AC${twilioBody}${runOf(r, HEX, 16)}"};`),
      script(`var build={ref:"${awsKey}QRSTUV"};`),
    ];
    for (const html of negatives) expect(reported(html)).toEqual([]);
  });

  test("a provider shape glued to a _ or - suffix stays reviewable, unattributed, at medium", () => {
    const unknown = unattributedKeyType();
    for (const [js, resembles] of [
      [`var env={id:"${awsKey}_PROD"};`, "AWS Access Key ID"],
      [`var css={cls:"key-${mailgunBody}-active"};`, "Mailgun API Key"],
    ] as const) {
      expect(reported(script(js))).toEqual([["leaked-secrets-medium", unknown]]);
      const raw = scanContent(js, "inline-script");
      expect(raw[0]?.extra).toEqual({ provider: "unknown", resembles });
    }
  });

  test("positive controls: the same shapes delimited on both sides still report", () => {
    expect(reported(script(`var c={k:"key-${mailgunBody}"};`))).toEqual([["leaked-secrets-high", "Mailgun API Key"]]);
    expect(reported(script(`var c={sid:"AC${twilioBody}"};`))).toEqual([["leaked-secrets-high", "Twilio Account SID"]]);
    expect(reported(script(`var c={id:"${awsKey}"};`))).toEqual([["leaked-secrets-high", "AWS Access Key ID"]]);
  });
});

describe("provider attribution: an sk_live_ prefix alone does not make a key Stripe's", () => {
  const core = mixedRun(seededRng(5301), 32);
  const stripeShape = "sk_live_" + core; // pragma: allowlist secret
  const unknownType = unattributedKeyType("sk_live_");

  test("a widget key that continues past Stripe's format keeps a qualified, unknown-provider label", () => {
    for (const suffix of ["_acmewidget", "-wgt", "_v2_eu"]) {
      const html = body(
        `<script src="https://widgets.vendor.test/w.js" data-widget-key="${stripeShape}${suffix}"></script>`
      );
      expect(reported(html)).toEqual([["leaked-secrets-medium", unknownType]]);
      const raw = scanContent(`var w={widgetKey:"${stripeShape}${suffix}"};`, "inline-script");
      expect(raw.map((f) => [f.type, f.value])).toEqual([[unknownType, `${stripeShape}${suffix}`]]);
      expect(raw[0]?.extra).toMatchObject({ prefix: "sk_live_", provider: "unknown", resembles: "Stripe Live Key" });
    }
  });

  test("an sk_test_ key with a suffix is qualified the same way", () => {
    const raw = scanContent(`var w={key:"sk_test_${core}_widget"};`, "inline-script");
    expect(raw.map((f) => f.type)).toEqual([unattributedKeyType("sk_test_")]);
  });

  test("positive control: a delimited sk_live_ key is still Stripe's, at high", () => {
    expect(reported(script(`var s={stripeKey:"${stripeShape}"};`))).toEqual([["leaked-secrets-high", "Stripe Live Key"]]);
  });
});

describe("Statsig keys: a server secret is separated from a client SDK key", () => {
  const r = seededRng(5401);
  // Synthetic bodies in the documented prefix shapes, never production values.
  const serverKey = "secret-" + mixedRun(r, 43); // pragma: allowlist secret
  const clientKey = "client-" + mixedRun(r, 43); // pragma: allowlist secret

  test("server and client configuration side by side: the server key leaks, the client key is public", () => {
    const html = script(
      `var statsigConfig={statsig:{serverSideApiKey:"${serverKey}",clientSideApiKey:"${clientKey}"}};`
    );
    expect(reported(html).sort()).toEqual([
      ["leaked-secrets-high", "Statsig Server Secret Key"],
      ["leaked-secrets-public", "Statsig Client SDK Key"],
    ]);
  });

  test("the client key alone does not fail the rule", () => {
    const result = leakedSecretsRule.run(ctx(script(`Statsig.config={statsig:{clientSideApiKey:"${clientKey}"}};`)));
    expect(result.checks.map((c) => c.name).sort()).toEqual(["leaked-secrets", "leaked-secrets-public"]);
  });

  test("an env-style server secret names its provider in the variable", () => {
    const raw = scanContent(`window.__ENV={STATSIG_SERVER_SECRET:"${serverKey}"};`, "inline-script");
    expect(raw.map((f) => [f.type, f.confidence, f.publicByDesign])).toEqual([
      ["Statsig Server Secret Key", "high", false],
    ]);
  });

  test("output separates exposure from untested validity and scope", () => {
    const raw = scanContent(`var c={statsig:{serverSideApiKey:"${serverKey}"}};`, "inline-script");
    expect(raw[0]?.extra).toEqual({
      provider: "Statsig",
      keyKind: "server-secret",
      prefix: "secret-",
      exposure: "present in content served to the browser",
      validity: "not tested",
      scope: "not tested",
    });
    const result = leakedSecretsRule.run(ctx(script(`var c={statsig:{serverSideApiKey:"${serverKey}"}};`)));
    const high = result.checks.find((c) => c.name === "leaked-secrets-high");
    expect(high?.items?.[0]?.meta).toMatchObject({ validity: "not tested", scope: "not tested" });
  });

  test("a secret- prefix without Statsig named in front of the key keeps a qualified, unknown-provider label", () => {
    const unknown = unattributedKeyType("secret-");
    const far = `/* statsig */${"x".repeat(150)};var c={serverSideApiKey:"${serverKey}"};`;
    const pages = [`var c={apiKey:"${serverKey}"};`, far, `var c={apiKey:"${serverKey}"}; /* statsig */`];
    for (const js of pages) {
      const raw = scanContent(js, "inline-script");
      expect(raw.map((f) => [f.type, f.confidence, f.publicByDesign])).toEqual([[unknown, "medium", false]]);
      expect(raw[0]?.extra).toMatchObject({ prefix: "secret-", provider: "unknown", validity: "not tested" });
    }
  });

  test("a client- prefix without Statsig named is left to the generic assignment, unchanged", () => {
    const raw = scanContent(`var c={apiKey:"${clientKey}"};`, "inline-script");
    expect(raw.map((f) => [f.type, f.confidence, f.publicByDesign])).toEqual([
      ["Generic API Key Assignment", "medium", false],
    ]);
  });

  test("every row's shape is anchored and names its prefix", () => {
    for (const row of PROVIDER_KEY_PREFIXES) {
      expect(row.shape.source.startsWith(`^${row.prefix}`)).toBe(true);
      expect(row.shape.source.endsWith("$")).toBe(true);
    }
  });
});
