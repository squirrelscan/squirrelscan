// Negatives synthesised from the shapes the detector fired on across the
// cloud audit history for 776 real sites (masked values only were pulled;
// every value here is re-synthesised, none is a real one). Today the detector
// fires on nearly all of them, so they are `knownGap` negatives: current
// behaviour = fires, desired = silent (or public-tier at most).
//
// Two families:
// - keyword tier false positives: the brand word is ordinary English or a
//   product name every Cloudflare-fronted or LinkedIn-sharing page contains,
//   and any SHA/UUID/SRI hash nearby is "a credential";
// - prefix patterns with no left boundary: `re_` inside `_Care_Dry…`,
//   `[0-9]{8,10}:` matching the tail of a UUID, `sk` opening a chunk id.

import { page } from "./contexts";
import type { Case, Expectation } from "./cases";
import { runOf, seededRng, supabaseJwt, type Rng } from "./generators";

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT = "0123456789";
const HEX = "0123456789abcdef";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = LOWER + UPPER + DIGIT;

function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const URL = "https://shop.acme.test/";
const inl = (loc: Expectation["location"], pattern: string, check: Expectation["check"] = "medium"): Expectation => ({ pattern, check, location: loc });

const rw = (id: string, build: (r: Rng) => string, expect: Expectation[], knownGap?: string, extra: Partial<Case> = {}): Case => ({
  id: `real:${id}`,
  url: URL,
  html: build(seededRng(seedOf(`real:${id}`))),
  expect,
  knownGap,
  ...extra,
});

const uuid = (r: Rng) => [8, 4, 4, 4, 12].map((n) => runOf(r, HEX, n)).join("-");
const sri = (r: Rng) => Buffer.from(Array.from({ length: 64 }, () => Math.floor(r() * 256))).toString("base64");


export const REAL_WORLD: Case[] = [
  // 1. Sanity on chunk ids and base64 fragments (346 hits / 74 sites).
  rw("sanity-webpack-chunk-id", (r) =>
    page(`<script src="/_next/static/chunks/sk${runOf(r, ALNUM, 40)}.js" defer></script>`, `<script>self.__CHUNKS__=["sk${runOf(r, ALNUM, 36)}","main"];</script>`),
    []),
  rw("sanity-base64-image-fragment", (r) =>
    page("", `<img alt="" src="data:image/webp;base64,UklGRsk${runOf(r, ALNUM, 40)}/${runOf(r, ALNUM, 20)}+${runOf(r, ALNUM, 20)}==">`),
    []),

  // 2. LinkedIn: share link + Shopify web-pixel-manager script URL (187 / 44).
  rw("linkedin-share-link-plus-shopify-wpm-script", (r) =>
    page(
      `<script src="/cdn/wpm/b${runOf(r, HEX, 12)}w${runOf(r, HEX, 12)}p${runOf(r, HEX, 8)}m${runOf(r, HEX, 12)}.js" async></script>`,
      `<a href="https://www.linkedin.com/shareArticle?mini=true&url=https%3A%2F%2Fshop.acme.test%2F" rel="noopener">Share on LinkedIn</a>` +
        `<div data-section-id="${runOf(r, ALNUM, 16)}" data-block-id="${runOf(r, HEX, 16)}"></div>` +
        // The web-pixel bootstrap: a minified member assignment of a 16-char
        // shop hash, which the key-context gate deliberately lets through.
        `<script>(function(){var w={};w.s="${runOf(r, HEX, 16)}";w.u="/cdn/wpm/b${runOf(r, HEX, 12)}w${runOf(r, HEX, 12)}m.js";window.__wpm=w})();</script>`,
    ),
    // Reported at `html`, not `inline-script`: the keyword is in the anchor,
    // outside the script, so only the whole-document scan has the window.
    []),

  // 3. Cloudflare: every Cloudflare-fronted page has the word + SRI / nonce.
  rw("cloudflare-fronted-page-sri-and-challenge", (r) =>
    page(
      `<script src="https://cdnjs.cloudflare.com/ajax/libs/lib/1.0.0/lib.min.js" integrity="sha512-${sri(r)}" crossorigin="anonymous"></script>` +
        `<script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/${runOf(r, HEX, 16)}/main.js"></script>`,
      `<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${runOf(r, HEX, 40)}">[email protected]</a>` +
        `<script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script>` +
        `<form id="hs-form-${runOf(r, ALNUM + "-", 40)}"></form>` +
        // The challenge bootstrap: minified member assignments of 40-char
        // nonces, which the key-context gate deliberately lets through.
        `<script>(function(){var e={};e.k="${runOf(r, ALNUM, 40)}";e.r="${runOf(r, HEX, 16)}";window._cf_chl_opt=e})();</script>`,
    ),
    []),

  // 4. Ordinary-word keywords + a hash in an unrelated attribute.
  rw("together-in-prose-plus-sha256-attr", (r) =>
    page("", `<p>Bring your team together with shared workspaces.</p><div data-asset-hash="${runOf(r, HEX, 64)}"></div>`),
    []),
  rw("segment-in-prose-plus-hash-attr", (r) =>
    page("", `<p>Each segment of the journey is tracked.</p><div data-segment-id="${runOf(r, ALNUM, 32)}"></div>`),
    []),
  rw("heroku-in-prose-plus-uuid-attr", (r) =>
    page("", `<p>Deployed on Heroku.</p><div data-heroku-dyno="${uuid(r)}"></div>`),
    // `data-heroku-dyno` carries the keyword, but as one word among others,
    // which names something about Heroku and not a credential (#357).
    []),
  rw("mistral-in-prose-plus-cryptojs-salted-blob", (r) =>
    page("", `<p>A cold mistral blew in from the north.</p><script>var enc="${Buffer.from("Salted__" + runOf(r, ALNUM, 40)).toString("base64")}";</script>`),
    []),
  rw("datadog-in-prose-plus-md5-attr", (r) =>
    page("", `<p>Monitored with Datadog.</p><img src="/img/logo.png?v=${runOf(r, HEX, 32)}" alt="" data-dd-privacy="mask">`),
    []),

  // 5. Telegram: `[0-9]{8,10}:` matches the TAIL of a UUID in a Webflow id path.
  rw("telegram-uuid-pair-in-webflow-id-path", (r) =>
    page("", `<div data-w-id="${uuid(r)}" data-wf-item-id-path="${runOf(r, HEX, 8)}-${runOf(r, HEX, 4)}-${runOf(r, HEX, 4)}-${runOf(r, HEX, 4)}-a0d${runOf(r, DIGIT, 9)}:${runOf(r, HEX, 8)}-${runOf(r, HEX, 4)}-${runOf(r, HEX, 4)}-${runOf(r, HEX, 4)}-${runOf(r, HEX, 12)}"></div>`),
    []),

  // 6. Resend: `re_` inside `_Care_Dry…` in an image filename.
  rw("resend-mid-token-in-image-filename", (r) =>
    page("", `<img src="/cdn/shop/files/${runOf(r, DIGIT, 12)}_Care_DryCrackedSkinReliefHydratingBalm_ATF_V05_PT1.webp" alt="Balm"><img src="/cdn/shop/files/${runOf(r, DIGIT, 12)}_Care_${runOf(r, ALNUM, 40)}.webp" alt="">`),
    []),

  // 7. Neon: a product slug `neon_alexandra-…`.
  rw("neon-product-slug", () =>
    page("", `<a href="/products/neon_alexandra-limited-edition-gloss-metallic-rose-gold-collection">Neon Alexandra</a>`),
    [inl("html", "Neon Database Token", "high")], "Neon `neon_[\\w-]{32,}` matches any `neon_`-prefixed hyphenated URL slug: the class admits `-` and there is no left or right boundary"),

  // 8. PayPal on Italian / Indonesian words inside long slugs.
  rw("paypal-azione-slug", () =>
    page("", `<a href="/collections/azione-di-prodotti-per-la-verniciatura-industriale-e-professionale">Azione</a><a href="/blog/azilah-dan-kisah-perjalanan-panjang-menuju-kejayaan-keluarga">Azilah</a>`),
    // A path is not a value position (#357).
    []),

  // 9. Generic Secret on i18n strings.
  rw("generic-secret-i18n-strings", () =>
    page("", `<script>window.__i18n__={password:'Password confirmation',passwd:"Enter your password again?",secret:"Keep this secret between us",Password:"Enter your password?",confirmPassword:"Passwords do not match"};</script>`), // pragma: allowlist secret
    // Sentences have spaces and under 3.5 bits/char (#357).
    []),

  // 10. Shopify storefront tokens: public by design, scoping question.
  // 10. Shopify storefront tokens: public by design, and the generic
  // assignments defer to the public context pattern when `shopify` sits
  // within the keyword gap before the value (the shop domain, the header
  // name, the pixel manager's storefront URL).
  rw("shopify-storefront-access-token", (r) =>
    page("", `<script>window.Shopify={shop:"acme.myshopify.com",storefrontAccessToken:"${runOf(r, HEX, 32)}"};fetch("/api/2024-01/graphql.json",{headers:{"X-Shopify-Storefront-Access-Token":"${runOf(r, HEX, 32)}"}});</script>`),
    // The key-named FAST pattern owns the first; the header form is the
    // context tier's.
    [inl("inline-script", "Shopify Storefront Access Token (key)", "public"), inl("inline-script", "Shopify Storefront Access Token", "public")], undefined,
    { mustNotFire: ["Generic Token Assignment"] }),
  rw("shopify-web-pixel-api-key", (r) =>
    page("", `<script src="/cdn/shopifycloud/web-pixels-manager/0.0.1/sandbox.modern.js"></script><script>webPixelsManager.init({"storefrontBaseUrl":"https://acme.myshopify.com","Api-Key":"${runOf(r, HEX, 32)}",storefrontDigest:"${runOf(r, HEX, 40)}"});</script>`),
    [inl("inline-script", "Shopify Storefront Access Token", "public")], undefined,
    { mustNotFire: ["Generic API Key Assignment"] }),
  rw("shopify-access-token-far-from-the-brand-word-stays-generic", (r) =>
    // Without `shopify` within the gap the generic assignment keeps it: a
    // medium warning, which is the tier for an unattributed token.
    page("", `<script>window.__cfg={shop:"acme.myshopify.com",theme:"dawn",locale:"en",currency:"USD",country:"US",access_token:"${runOf(r, HEX, 32)}"};</script>`),
    [inl("inline-script", "Generic Token Assignment")]),

  // Round 2: URL-encoded JSON. The left-boundary guard must read the `2` of
  // `%22` as punctuation in disguise, decoder or no decoder.
  rw("url-encoded-json-stripe-publishable-key", (r) =>
    page("", `<script>window.__STATE__="%7B%22key%22%3A%22${["p", "k_li", "ve_"].join("")}${runOf(r, ALNUM, 24)}%22%2C%22mode%22%3A%22live%22%7D";</script>`),
    [inl("inline-script", "Stripe Publishable Key", "public")]),
  rw("url-encoded-json-github-token", (r) =>
    page("", `<script>window.__STATE__="%7B%22token%22%3A%22${["gh", "p_"].join("")}${runOf(r, ALNUM, 36)}%22%7D";</script>`),
    [inl("inline-script", "GitHub Personal Access Token", "high")]),
  rw("url-encoded-sentence-under-password-key", () =>
    // hotal.co.uk: a URL-encoded i18n sentence under a password key.
    page("", `<script>window.__i18n=\{password:"Password%20must%20be%20at%20least%208%20characters%20and%20be%20confirmed%",passwd:"passwd",Password:"Password"};</script>`.replace("\\{", "{")), // pragma: allowlist secret
    []),

  // 11. Bearer: literal reports, template/concatenation must not.
  rw("bearer-template-and-concat-in-auth-spa", () =>
    page("", "<script>const h1={Authorization:`Bearer ${session.token}`};const h2={Authorization:\"Bearer \"+getToken()};const h3={Authorization:'Bearer '.concat(t)};</script>"),
    []),
  rw("bearer-literal-in-auth-spa", (r) =>
    page("", `<script>const h={Authorization:"Bearer ${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${runOf(r, ALNUM, 40)}.${runOf(r, ALNUM, 30)}"};</script>`),
    // A JWT no pattern recognises is an opaque bearer token: the Bearer
    // match yields only to a JWT finding that actually claimed the value.
    [inl("inline-script", "Bearer Token")]),
  rw("bearer-literal-opaque-token-in-auth-spa", (r) =>
    page("", `<script>const h={Authorization:"Bearer ${runOf(r, ALNUM, 40)}"};</script>`),
    [inl("inline-script", "Bearer Token")]),

  // 12. AIza lands in the public tier, never high.
  rw("aiza-is-public-not-high", (r) =>
    page("", `<script>firebase.initializeApp({apiKey:"${["AI", "za"].join("")}Sy${runOf(r, ALNUM + "-_", 33)}",authDomain:"acme.firebaseapp.com"});</script>`),
    [inl("inline-script", "Google API Key (browser)", "public")], undefined, { mustNotFire: ["Generic API Key Assignment"] }),

  // Boundary probes, one per prefix family: the prefix mid-token.
  rw("prefix-mid-token-ghp", (r) => page("", `<script>var id="foo${["gh", "p_"].join("")}${runOf(r, ALNUM, 36)}";</script>`), []),
  rw("prefix-mid-token-sk-live", (r) => page("", `<script>var id="x${["s", "k_li", "ve_"].join("")}${runOf(r, ALNUM, 24)}";</script>`), []),
  rw("prefix-mid-token-akia", (r) => page("", `<script>var id="abc${["AK", "IA"].join("")}${runOf(r, UPPER + DIGIT, 16).replace(/DO/g, "DQ")}";</script>`), []),
];

// Round 3, from the full 383-file real corpus.
export const ROUND_3: Case[] = [
  // 1. Shopify's own boot JSON and theme code.
  rw("shopify-features-boot-json", (r) =>
    page("", `<script id="shopify-features" type="application/json">{"accessToken":"${runOf(r, HEX, 32)}","betas":["rich-media-storefront-analytics"],"domain":"acme.myshopify.com","predictiveSearch":true,"shopId":${runOf(r, DIGIT, 8)},"locale":"en"}</script>`),
    // The inline pass is handed the script's open tag, so it classifies the
    // value public exactly as the document pass does; the rule keeps the
    // last of two identical public records, the inline one.
    [inl("inline-script", "Shopify Storefront Access Token", "public")], undefined, { mustNotFire: ["Generic Token Assignment"] }),
  rw("storefront-access-token-key-anywhere", (r) =>
    page("", `<script>window.theme={settings:{currency:"USD"},"storefrontAccessToken":"${runOf(r, HEX, 32)}"};// Storefront Access Token\nvar t="${runOf(r, HEX, 32)}";</script>`),
    [inl("inline-script", "Shopify Storefront Access Token (key)", "public")], undefined, { mustNotFire: ["Generic Token Assignment"] }),
  rw("access-token-on-a-cdn-shopify-page", (r) =>
    page(`<link rel="preload" href="https://cdn.shopify.com/s/files/1/0001/theme.css" as="style">`, `<script>window.__cfg={theme:"dawn",locale:"en",currency:"USD",country:"US",access_token:"${runOf(r, HEX, 32)}"};</script>`),
    // `html` for the same reason: cdn.shopify.com is in the head, not in
    // the script text.
    [inl("html", "Shopify Storefront Access Token", "public")], undefined, { mustNotFire: ["Generic Token Assignment"] }),

  // 3. A brand as the parent key or the tag name.
  rw("raygun-parent-object", (r) =>
    page("", `<script>window.__cfg={raygun:{enabled:!0,apiKey:"${runOf(r, DIGIT, 1)}${runOf(r, ALNUM, 27)}"}};</script>`),
    [inl("inline-script", "Raygun API Key", "public")], undefined, { mustNotFire: ["Generic API Key Assignment"] }),
  rw("builder-component-tag", (r) =>
    page("", `<builder-component model="page" api-key="${runOf(r, HEX, 32)}"></builder-component>`),
    [inl("html", "Builder.io API Key", "public")], undefined, { mustNotFire: ["Generic API Key Assignment"] }),
  rw("intercom-settings-object", (r) =>
    page("", `<script>window.intercomSettings={api_base:"https://api-iam.intercom.io",app_id:"${runOf(r, LOWER + DIGIT, 8)}",access_token:"${runOf(r, ALNUM, 24)}"};</script>`),
    [inl("inline-script", "Intercom App ID", "public")], undefined, { mustNotFire: ["Generic Token Assignment"] }),
  rw("brand-parent-does-not-claim-a-secret-or-auth-token", (r) =>
    // Only an API key or an access token is an SDK's client credential; a
    // password, secret or auth token under a brand parent is still a leak.
    page("", `<script>window.__cfg={sentry:{dsn:"https://x@o1.ingest.sentry.io/1",authToken:"${runOf(r, ALNUM, 32)}"},hotjar:{secret:"${runOf(r, ALNUM, 24)}"}};</script>`),
    [inl("inline-script", "Generic Token Assignment"), inl("inline-script", "Generic Secret Assignment")], undefined,
    { mustNotFire: ["Sentry Client Key", "Hotjar Site ID"] }),
  rw("credential-in-a-query-string-is-not-a-path", (r) =>
    page("", `<a href="/login?password=${runOf(r, ALNUM, 16)}&next=%2F">go</a><script>u=new URL("https://api.acme.test/x?api_key=${runOf(r, ALNUM, 24)}")</script>`),
    // The href query carries no quotes so the generic pattern cannot match
    // it; the script URL's `api_key=…` has no quote either. What must NOT
    // happen is the path rule eating a quoted one after a `?`.
    []),
  rw("quoted-credential-after-a-query-mark-in-an-href", (r) =>
    // Single quotes inside the attribute: the parser normalises attribute
    // quoting to double quotes and would entity-encode an inner `"`.
    page("", `<a href="/login?secret='${runOf(r, ALNUM, 24)}'">go</a>`),
    [inl("html", "Generic Secret Assignment")]),
  rw("two-hs256-jwts-only-the-claimed-one-yields", (r) =>
    // A Supabase anon JWT is public; a DIFFERENT HS256 JWT in a Bearer
    // header shares its head and must still report as a bearer token.
    page("", `<script>const s=createClient("https://${runOf(r, LOWER, 20)}.supabase.co",${JSON.stringify(supabaseJwt(r, "anon"))});const h={Authorization:"Bearer ${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${runOf(r, ALNUM, 40)}.${runOf(r, ALNUM, 30)}"};</script>`),
    [inl("inline-script", "Supabase Anon Key", "public"), inl("inline-script", "Bearer Token")]),
  rw("public-username-inside-a-database-url-does-not-hide-it", (r) => {
    const token = runOf(r, HEX, 32);
    // (`mixpanel.init("…")` as a call argument is not a value position, a
    // documented gap; the token is assigned under the brand instead.)
    return page("", `<script>window.mixpanel={token:"${token}"};const db="postgres://${token}:${runOf(r, ALNUM, 16)}@db.internal:5432/prod";</script>`);
  },
    // The connection string is claimed first and CONTAINS the token, so the
    // token's own finding is the overlap dedup's duplicate: what must hold is
    // that the database URL reports.
    [inl("inline-script", "PostgreSQL Connection String", "high")]),
  rw("brand-far-from-the-key-stays-generic", (r) =>
    page("", `<script>/* raygun */ var a=1,b=2,c=3,d=4,e=5,f=6,g=7,h=8,i=9,j=10;window.__cfg={apiKey:"${runOf(r, DIGIT, 1)}${runOf(r, ALNUM, 27)}"};</script>`),
    [inl("inline-script", "Generic API Key Assignment")]),

  // 4. The tail of a URL is not an assignment.
  rw("generic-match-inside-a-url-path", (r) =>
    page("", `<img src="https://cdn.shopify.com/s/files/1/0001/products/Access_Token_${runOf(r, ALNUM, 24)}.png" alt=""><a href="/docs/api_key=${runOf(r, ALNUM, 24)}">docs</a><div style="background:url(/img/secret_key=${runOf(r, ALNUM, 24)})"></div>`),
    []),

  // Round 4 (full-rule run over the corpus): WordPress oEmbed nonce, a
  // meta description that mentions "access", and a fourth real leak.
  rw("wordpress-oembed-data-secret-nonce", (r) =>
    page("", `<blockquote class="wp-embedded-content" data-secret="${runOf(r, ALNUM, 10)}"><a href="https://blog.acme.test/post/">A post</a></blockquote><iframe class="wp-embedded-content" sandbox="allow-scripts" security="restricted" src="https://blog.acme.test/post/embed/#?secret=${runOf(r, ALNUM, 10)}" data-secret="${runOf(r, ALNUM, 10)}"></iframe>`),
    []),
  rw("meta-description-mentioning-access", () =>
    page(`<meta name="description" content="Discover handcrafted necklaces and accessories designed for style, focus, and confidence. Every piece stands out."><meta property="og:description" content="Access to our token program is by invitation.">`, ""),
    []),
  rw("ga4-api-secret-assignment", (r) =>
    // packomic: a Measurement Protocol API secret inlined next to the id.
    page("", `<script>const GA4_MEASUREMENT_ID = 'G-${runOf(r, UPPER + DIGIT, 10)}';const GA4_API_SECRET = '${runOf(r, ALNUM + "-_", 22)}';</script>`),
    [inl("inline-script", "Generic Secret Assignment")]),

  // 5. Real leaks that must keep reporting.
  rw("rsc-flight-payload-bearer-jwt", (r) =>
    page("", `<script>self.__next_f.push([1,"3:[\\"$\\",\\"div\\",null,{\\"x-vercel-sc-headers\\":\\"{\\\\\\"Authorization\\\\\\":\\\\\\"Bearer ${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${runOf(r, ALNUM, 60)}.${runOf(r, ALNUM, 43)}\\\\\\"}\\"}]\\n"])</script>`),
    [inl("inline-script", "Bearer Token")]),
  rw("fetch-header-literal-first-party-api", (r) =>
    page("", `<script>async function load(){const r=await fetch("https://api.successvisa.test/v1/applications",{headers:{"Content-Type":"application/json","Authorization":"Bearer ${runOf(r, ALNUM, 48)}"}});return r.json()}</script>`),
    [inl("inline-script", "Bearer Token")]),
  rw("screaming-snake-env-dump-with-turnstile-test-key", (r) =>
    page("", `<script>window.__ENV__={NODE_ENV:"production",ENCRYPTED_STORAGE_SECRET_KEY:"${runOf(r, ALNUM, 32)}",TURNSTILE_SITE_KEY:"1x00000000000000000000AA",API_URL:"https://api.louisedutka.test"};</script>`),
    [inl("inline-script", "Generic Secret Assignment")]),
];

export const DEDUP_CASES: Case[] = (() => {
  const r = seededRng(seedOf("dedup"));
  const dsn = `https://${runOf(r, HEX, 32)}@o${runOf(r, DIGIT, 6)}.ingest.sentry.io/${runOf(r, DIGIT, 7)}`;
  const pk = `pk.${Buffer.from(JSON.stringify({ u: "theme-shop", a: `cm${runOf(r, LOWER + DIGIT, 24)}` })).toString("base64url").replace(/[-_]/g, "x")}.${runOf(r, ALNUM, 22)}`;
  const bundle = `!function(){Sentry.init({dsn:"${dsn}"});window.__m="${pk}";Sentry.setTag("dsn","${dsn}");Sentry.init({dsn:"${dsn}"})}();`;
  return [
    {
      id: "dedup:shared-theme-bundle-one-finding-per-distinct-value",
      url: URL,
      html: page(`<script src="/theme.js"></script>`, ""),
      scripts: [{ url: "https://shop.acme.test/theme.js", content: bundle }],
      // The DSN appears three times in one bundle; one finding for it, one for the Mapbox token.
      expect: [inl("external-script", "Sentry DSN", "public"), inl("external-script", "Mapbox Access Token", "public")],
    },
  ];
})();
