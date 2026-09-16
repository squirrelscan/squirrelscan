// Embedding contexts: the places a credential actually turns up on a crawled
// page. Each one wraps a generated value into realistic HTML or JS and says
// where the rule should report it.
//
// `location` is the rule-level location, i.e. AFTER the rule's dedup-by-value.
// scanPageForSecrets scans the serialized document as `html` and then each
// inline script again as `inline-script`, so a value inside a script is found
// twice; the rule keeps the last record, which is the `inline-script` one. The
// double scan itself is pinned in the test file as a known defect.

import type { ReportedLocation } from "../../../src/security/leaked-secrets";
import type { Generated, Tier } from "./generators";

export type Location = ReportedLocation;

export interface Embedded {
  html: string;
  /** External scripts the page references, keyed by URL. */
  scripts?: Array<{ url: string; content: string }>;
}

export interface Context {
  id: string;
  location: Location;
  /** Which generator tiers this context can carry. */
  accepts: Tier[];
  /**
   * A context whose OWN syntax is a FAST pattern (`Authorization: "Bearer …"`)
   * claims any `keyed` value before the context tier sees it. The expected
   * finding for keyed values is then this pattern, not the value's own.
   */
  claims?: string;
  embed: (value: Generated, keyName: string) => Embedded;
}

const toEnvName = (keyName: string) =>
  keyName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const toKebab = (keyName: string) => keyName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** A JSON entry for the value under `keyName`, or the assignment's own entry. */
const jsonEntry = (v: Generated, keyName: string, tier: Tier) =>
  tier === "assignment" ? v.text : `${JSON.stringify(keyName)}:${JSON.stringify(v.text)}`;

// Text an object literal in a script can hold. Both halves go through
// JSON.stringify: a `prefixed` value can carry a newline (PEM bodies), and a
// quoted key is what an embedded config blob writes anyway.
const jsEntry = jsonEntry;

// The encodings of #360. Each hides the value from a byte-level scan while a
// browser reads it perfectly well.

/** What an HTML serializer writes for text inside a double-quoted attribute. */
const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A JS string body with every alphanumeric written as an escape, alternating
 * `\uXXXX` and `\xXX` so both forms are exercised. The input is the inside of
 * a JSON string, so its own escapes (`\n` in a PEM body) are left alone.
 */
const escapeJsBody = (s: string) => {
  let i = 0;
  return s.replace(/[A-Za-z0-9]/g, (c) => {
    const code = c.charCodeAt(0);
    return i++ % 2 === 0 ? `\\u${code.toString(16).padStart(4, "0")}` : `\\x${code.toString(16).padStart(2, "0")}`;
  });
};

/** A JSON entry whose value is written with JS escapes. */
const escapedEntry = (v: Generated, keyName: string, tier: Tier) => {
  const entry = jsonEntry(v, keyName, tier);
  // The entry is `"key":"value"`; escape the value's body only.
  const sep = entry.indexOf('":"');
  if (sep === -1) return entry;
  return `${entry.slice(0, sep + 3)}${escapeJsBody(entry.slice(sep + 3, -1))}"`;
};

/** A config object as the page's bootstrap hands it to the client: base64 JSON. */
const b64Config = (v: Generated, keyName: string, tier: Tier) =>
  Buffer.from(`{"session":null,"config":{${jsonEntry(v, keyName, tier)},"locale":"en","flags":["beta"]}}`).toString("base64");

export function page(head: string, body: string): string {
  return [
    "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<title>Acme Dashboard</title>",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<link rel=\"stylesheet\" href=\"/static/css/app.3f2a1c.css\">",
    head,
    "</head><body><header><nav><a href=\"/\">Home</a><a href=\"/pricing\">Pricing</a></nav></header>",
    "<main><h1>Welcome back</h1><p>Your workspace is ready.</p>",
    body,
    "</main><footer><p>&copy; 2026 Acme, Inc.</p></footer></body></html>",
  ].join("\n");
}

// The `tier` reaches embed via a closure per case; see cases.ts. To keep each
// context a plain function of (value, keyName) we thread it through a small
// wrapper below.
type Embed = (v: Generated, keyName: string, tier: Tier) => Embedded;

const define = (
  id: string,
  location: Location,
  accepts: Tier[],
  embed: Embed,
  claims?: string,
): Context & { embedTiered: Embed } => ({
  id,
  location,
  accepts,
  claims,
  embedTiered: embed,
  // Default: assume the value's tier is whatever the case says; cases.ts calls
  // embedTiered directly, this is only for ad-hoc use.
  embed: (v, keyName) => embed(v, keyName, "prefixed"),
});

export const CONTEXTS = [
  define("inline-config-object", "inline-script", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page(
      "",
      `<script>window.APP_CONFIG={env:"production",region:"us-east-1",${jsEntry(v, k, t)},features:{billing:true,sso:false}};</script>`,
    ),
  })),

  define("window-env", "inline-script", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page(
      `<script>window.__ENV = {"NODE_ENV":"production","PUBLIC_URL":"https://app.acme.test",${
        t === "assignment" ? v.text : `${JSON.stringify(toEnvName(k))}:${JSON.stringify(v.text)}`
      },"SENTRY_ENV":"prod"};</script>`,
      "",
    ),
  })),

  define("next-data", "inline-script", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page(
      "",
      `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"user":{"id":"u_1","plan":"pro"},"config":{${jsonEntry(v, k, t)},"locale":"en"}},"__N_SSG":true},"page":"/dashboard","query":{},"buildId":"k9Qx2mZ","nextExport":false,"isFallback":false,"gsp":true,"scriptLoader":[]}</script>`,
    ),
  })),

  define("nuxt-payload", "inline-script", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page(
      "",
      `<script>window.__NUXT__=(function(a,b,c){return {layout:"default",data:[{}],fetch:{},error:a,state:{auth:{loggedIn:b}},serverRendered:c,routePath:"/",config:{_app:{basePath:"/",assetsPath:"/_nuxt/",cdnURL:a},public:{${jsEntry(v, k, t)}}}}}(void 0,false,true));</script>`,
    ),
  })),

  define("html-comment", "html", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page(
      "",
      `<!-- deploy 2026-03-04 by ci: ${t === "assignment" ? v.text : `${k}=${v.text}`} (remove before launch) -->`,
    ),
  })),

  define("meta-content", "html", ["prefixed", "keyed"], (v, k) => ({
    html: page(`<meta name="${toKebab(k)}" content="${v.text}">`, ""),
  })),

  define("data-attribute", "html", ["prefixed", "keyed"], (v, k) => ({
    html: page("", `<div id="app" data-env="production" data-${toKebab(k)}="${v.text}"></div>`),
  })),

  // A JSON-LD block carries no credential-named key, so only self-marking
  // values report here: a bare shape under "identifier" is correctly silent.
  define("json-ld", "inline-script", ["prefixed"], (v) => ({
    html: page(
      "",
      `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"https://acme.test","identifier":${JSON.stringify(v.text)},"sameAs":["https://social.example/acme"]}</script>`,
    ),
  })),

  // A webpack build that inlined `process.env.X` into a minified bundle.
  define("external-bundle", "external-script", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page("", `<script src="/static/js/main.7b1e9c.js" defer></script>`),
    scripts: [
      {
        url: "https://app.acme.test/static/js/main.7b1e9c.js",
        content:
          `!function(){"use strict";var e={},n=function(t){return t&&t.__esModule?t.default:t};` +
          `var r={${jsEntry(v, k, t)},endpoint:"https://api.acme.test/v2"};` +
          `e.init=function(){return fetch(r.endpoint+"/session",{credentials:"include"})};n(e).init()}();`,
      },
    ],
  })),

  // fetch() with a header literal. The header is itself the Bearer pattern, so
  // keyed values are reported as a Bearer token rather than under their brand.
  define(
    "fetch-bearer-header",
    "external-script",
    ["prefixed", "keyed"],
    (v, k) => ({
      html: page("", `<script src="/static/js/api-client.a91f03.js"></script>`),
      scripts: [
        {
          url: "https://app.acme.test/static/js/api-client.a91f03.js",
          content:
            `const cfg=${JSON.stringify({ [k]: 1 })};export async function getAccount(){const res=await fetch("https://api.acme.test/v1/account",{` +
            `headers:{"Content-Type":"application/json",Authorization:${JSON.stringify(`Bearer ${v.text}`)}}});` +
            `if(!res.ok)throw new Error("account: "+res.status);return res.json()}`,
        },
      ],
    }),
    "Bearer Token",
  ),

  // A .env file pasted into a <pre> on a docs or status page.
  define("pre-env-dump", "html", ["prefixed", "keyed"], (v, k) => ({
    html: page(
      "",
      `<h2>Runtime configuration</h2><pre>NODE_ENV=production\nPORT=8080\nLOG_LEVEL=info\n${toEnvName(k)}=${v.text}\nFEATURE_FLAGS=beta,sso</pre>`,
    ),
  })),

  // A sourcemap comment whose map URL carries a credential in its query.
  define("sourcemap-comment", "external-script", ["prefixed", "keyed"], (v, k) => ({
    html: page("", `<script src="/static/js/vendor.c04d2e.js"></script>`),
    scripts: [
      {
        url: "https://app.acme.test/static/js/vendor.c04d2e.js",
        content:
          `(function(g){g.__vendor={version:"4.2.1",loaded:Date.now()}})(window);\n` +
          `//# sourceMappingURL=https://maps.acme-cdn.test/vendor.c04d2e.js.map?${encodeURI(k)}=${encodeURI(v.text)}\n`,
      },
    ],
  })),

  // ── Encoded forms (#360) ──────────────────────────────────────────────

  // A JSON state object serialized into an attribute: every quote is `&quot;`.
  define("entity-encoded-attribute", "html", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page(
      "",
      `<div id="app" data-state="${escapeAttr(`{"user":{"id":"u_1","plan":"pro"},"config":{${jsonEntry(v, k, t)},"locale":"en"}}`)}"></div>`,
    ),
  })),

  // A string literal a minifier or an obfuscator wrote with `\u` / `\x`
  // escapes. The serialized HTML is not unescaped, so it reports at the
  // script's own location.
  define("unicode-escaped-script-string", "inline-script", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page("", `<script>window.__CFG__={region:"eu-west-1",${escapedEntry(v, k, t)},debug:false};</script>`),
  })),

  // The whole config as one base64 string in a data attribute, decoded by the
  // app at boot. Read from the serialized document, so `html (base64)`.
  define("base64-data-attribute", "html (base64)", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page("", `<div id="root" data-initial-state="${b64Config(v, k, t)}"></div>`),
  })),

  // The same blob assigned to a global. The inline script is scanned last, so
  // the rule's dedup keeps `inline-script (base64)`.
  define("base64-global", "inline-script (base64)", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page(
      "",
      `<script>window.__CONFIG__="${b64Config(v, k, t)}";window.__CFG=JSON.parse(atob(window.__CONFIG__));</script>`,
    ),
  })),

  // A settings object embedded URL-encoded (a WooCommerce payment-gateway
  // settings blob does this), decoded in place, so the location is the plain
  // one.
  define("url-encoded-data-attribute", "html", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page("", `<div id="checkout" data-settings="${encodeURIComponent(`{"currency":"usd","config":{${jsonEntry(v, k, t)}},"locale":"en"}`)}"></div>`),
  })),
  define("url-encoded-inline-settings", "inline-script", ["prefixed", "keyed", "assignment"], (v, k, t) => ({
    html: page(
      "",
      `<script>var wc_settings=JSON.parse(decodeURIComponent("${encodeURIComponent(`{"currency":"usd","config":{${jsonEntry(v, k, t)}},"locale":"en"}`)}"));</script>`,
    ),
  })),
];

export type ContextDef = (typeof CONTEXTS)[number];
