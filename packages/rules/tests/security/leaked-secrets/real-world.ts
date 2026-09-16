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
import { awsKeySuffix, githubToken, runOf, seededRng, supabaseJwt, type Rng } from "./generators";

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
    page("", `<script>window.__STATE__="%7B%22token%22%3A%22${githubToken(r, ["gh", "p_"].join(""))}%22%7D";</script>`),
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
  rw("prefix-mid-token-ghp", (r) => page("", `<script>var id="foo${githubToken(r, ["gh", "p_"].join(""))}";</script>`), []),
  rw("prefix-mid-token-sk-live", (r) => page("", `<script>var id="x${["s", "k_li", "ve_"].join("")}${runOf(r, ALNUM, 24)}";</script>`), []),
  rw("prefix-mid-token-akia", (r) => page("", `<script>var id="abc${["AK", "IA"].join("")}${awsKeySuffix(r)}";</script>`), []),
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
  rw("cdn-shopify-lookalike-host-is-not-a-shopify-page", (r) =>
    // The page test is a host match, not a substring: neither lookalike
    // makes a 32-hex access_token Shopify's, so it stays a generic leak.
    page(`<link rel="preload" href="https://cdn.shopify.com.evil.test/theme.css" as="style"><script src="https://notcdn.shopify.com/x.js"></script>`, `<a href="https://cdn.shopify.com.evil.test/x">x</a><a href="//cdn.shopify.com.evil.test/y">y</a><script>window.__cfg={access_token:"${runOf(r, HEX, 32)}"};</script>`),
    [inl("inline-script", "Generic Token Assignment")]),
  rw("protocol-relative-cdn-shopify-url-counts", (r) =>
    page(`<script src="//cdn.shopify.com/s/javascripts/x.js"></script>`, `<script>window.__cfg={access_token:"${runOf(r, HEX, 32)}"};</script>`),
    [inl("html", "Shopify Storefront Access Token", "public")], undefined, { mustNotFire: ["Generic Token Assignment"] }),
  rw("sentry-dsn-host-lookalike", (r) =>
    // `sentryXio` for `sentry.io`: the DSN pattern's dots are escaped.
    page("", `<script>Sentry.init({dsn:"https://${runOf(r, HEX, 32)}@o${runOf(r, DIGIT, 6)}.ingest.sentryXio/${runOf(r, DIGIT, 7)}"});</script>`),
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

// Round 5, from the 197-site Product Hunt launch corpus (private #2218).
// Every negative here is a shape the detector fired on across those sites,
// re-synthesised; no value below is a real one, and every one of them is
// chosen to clear the generic entropy floor, so what drops it is the guard
// the case is named for and not an accident of its letters.
export const ROUND_5: Case[] = [
  // 1. A run of `A` is a run of zero bytes in base64: a WebP placeholder, a
  // zlib stream, a PNG. The alphabet's own `/` and `+` give the run a clean
  // left boundary, so only a value position tells it from a token.
  rw("twitter-bearer-run-of-a-in-a-webp-data-uri", (r) =>
    page("", `<script>self.__next_f.push([1,"{\\"blurWidth\\":8,\\"blurDataURL\\":\\"data:image/webp;base64,UklGR${runOf(r, ALNUM, 18)}/${"A".repeat(64)}${runOf(r, ALNUM, 16)}=\\",\\"alt\\":\\"Hero\\"}"])</script>`),
    []),
  rw("twitter-bearer-run-of-a-in-a-binary-base64-blob", (r) =>
    page("", `<script>var wasm="${runOf(r, ALNUM, 40)}+${"A".repeat(180)}${runOf(r, ALNUM, 24)}";</script>`),
    []),
  rw("twitter-bearer-token-in-an-authorization-header", (r) =>
    // The position a real one occupies: after the scheme rather than after a
    // separator. This case is why isInValuePosition has an auth-scheme arm.
    page("", `<script>fetch("https://api.acme.test/v2/tweets",{headers:{Authorization:"Bearer ${"A".repeat(19)}${runOf(r, ALNUM, 12)}%3D${runOf(r, ALNUM, 60)}"}});</script>`),
    [inl("inline-script", "Twitter Bearer Token", "high")]),
  rw("twitter-bearer-token-under-a-key", (r) =>
    page("", `<script>window.__ENV={TWITTER_BEARER_TOKEN:"${"A".repeat(19)}${runOf(r, ALNUM, 12)}%3D${runOf(r, ALNUM, 60)}"};</script>`),
    [inl("inline-script", "Twitter Bearer Token", "high")]),

  // 2. `<8-10 digits>:<35 characters>` is also the shape of a row in a
  // minified decoder table. What separates them is that a token's tail is
  // random and a table's is two digits.
  rw("telegram-shape-on-a-digit-decoder-table", (r) =>
    page("", `<script>var A=new Int32Array(318).fill(-1),t=d("${runOf(r, DIGIT, 8)}:${runOf(r, "24", 35)}");</script>`),
    []),
  rw("telegram-bot-token-still-fires", (r) =>
    page("", `<script>const cfg={telegramBotToken:"${runOf(r, DIGIT, 9)}:${runOf(r, ALNUM + "-_", 35)}"};</script>`),
    [inl("inline-script", "Telegram Bot Token", "high")]),

  // 3. Values a credential word was assigned that no credential could be.
  rw("password-key-with-an-unspaced-i18n-label", () =>
    // Japanese has no spaces, so the whitespace test cannot see the label.
    page("", `<script>const t={ja:{weakPassword:"パスワードは8文字以上にしてください。",emailTaken:"このメールアドレスには既にアカウントがあります。"}};</script>`),
    []),
  rw("password-key-with-a-catalogue-key-value", () =>
    page("", `<script>const E={invalidEmail:"login.err.invalidEmail",password:"login.err.weakPassword"};</script>`), // pragma: allowlist secret
    []),
  rw("password-key-with-a-rooted-route-path", () =>
    page("", `<script>const R={LOGIN:"/auth/login",RESET_PASSWORD:"/account/security/change-password"};</script>`),
    []),
  rw("password-key-with-a-relative-route-key", () =>
    page("", `<script>class C{FORGOT_PASSWORD="auth/auth/forgot_password";RESET_PASSWORD="auth/auth/reset_password"}</script>`), // pragma: allowlist secret
    []),
  rw("password-key-with-a-redaction-placeholder", () =>
    page("", `<script>function scrub(a){const r=a.auth?.ciLogin;return r&&typeof r=="object"&&"password"in r&&(r.password="(redacted)"),a}</script>`),
    []),
  // Next.js's URL sanitiser, which the old build reported on seven of the
  // 197 sites. It needs no new rule: isPercentEncodedLabel reads `%filtered%`
  // as the label it is. Pinned so that stays true.
  rw("password-key-with-a-framework-filtered-value", () =>
    page("", `<script>function sanitize(u){const t=new URL(u);t.password="%filtered%";return t.toString()}</script>`),
    []),
  rw("password-assignment-still-fires", (r) =>
    page("", `<script>window.__ENV={DB_PASSWORD:"${runOf(r, ALNUM + "!#", 24)}"};</script>`),
    [inl("inline-script", "Generic Secret Assignment")]),

  // 4. A credential word in a ternary branch reads as a key character for
  // character: `'password' : 'emailLink'`, `? "Reset Password" : "…"`. What
  // tells them apart is what opens the quoted string the word sits in.
  rw("password-in-a-ternary-branch", () =>
    page("", `<script>function m(q){return q["emailSignInMethod"] === "password" ?\n      "password" :\n      "emailLink"}</script>`),
    []),
  rw("autocomplete-password-ternary-on-an-input", () =>
    // React's `autoComplete={isNew ? "new-password" : "current-password"}`,
    // which every sign-up form in a bundled app carries.
    page("", `<script>const f=(l,b,x)=>y.jsx("input",{type:"password",value:b,onChange:x,autoComplete:l?"new-password":"current-password"});</script>`), // pragma: allowlist secret
    []),
  rw("password-as-the-last-word-of-a-ternary-label", (r) =>
    page("", `<script>const T=e=>e.startsWith("/reset-password")?"Reset Password":"${runOf(r, ALNUM, 12)}";</script>`),
    []),

  // 5. `DO` plus twenty uppercase characters is also a font CDN path segment.
  rw("digitalocean-spaces-shape-in-a-font-path", (r) =>
    page(`<style>@font-face{font-family:"Satoshi";src:url("https://fonts.acme-cdn.test/third-party-assets/fontshare/wf/${runOf(r, UPPER + DIGIT, 32)}/DO${runOf(r, UPPER + DIGIT, 30)}/${runOf(r, UPPER + DIGIT, 32)}.woff2")}</style>`, ""),
    []),
  rw("digitalocean-spaces-key-still-fires", (r) =>
    page("", `<script>window.__ENV={DO_SPACES_KEY:"DO${runOf(r, UPPER + DIGIT, 22)}"};</script>`),
    [inl("inline-script", "DigitalOcean Spaces Key")]),

  // 6. The key id in a presigned S3 URL is the public half of the signature,
  // which means the signature and the expiry have to be there beside it.
  rw("aws-key-id-in-a-presigned-url-is-informational", (r) =>
    page("", `<script>self.__next_f.push([1,"{\\"href\\":\\"https://acme-downloads.s3.amazonaws.test/x.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256\\u0026X-Amz-Credential=${["AK", "IA"].join("")}${awsKeySuffix(r)}%2F20260916%2Fus-east-1%2Fs3%2Faws4_request\\u0026X-Amz-Date=20260916T023448Z\\u0026X-Amz-Expires=86400\\u0026X-Amz-SignedHeaders=host\\u0026X-Amz-Signature=${runOf(r, HEX, 64)}\\"}"])</script>`),
    [inl("inline-script", "AWS Access Key ID", "info")]),
  rw("aws-key-id-under-a-key-still-reports", (r) =>
    page("", `<script>window.__ENV={AWS_ACCESS_KEY_ID:"${["AK", "IA"].join("")}${awsKeySuffix(r)}"};</script>`),
    [inl("inline-script", "AWS Access Key ID", "high")]),

  // 7. Public client keys the generic tiers were reporting as leaks.
  rw("amplitude-browser-key-under-its-own-name", (r) =>
    page("", `<script>var AMPLITUDE_KEY="${runOf(r, HEX, 32)}";amplitude.init(AMPLITUDE_KEY);</script>`),
    [inl("inline-script", "Amplitude API Key", "public")]),
  rw("amplitude-browser-key-under-a-build-time-env-name", (r) =>
    page("", `<script>const env={MODE:"production",VITE_AMPLITUDE_API_KEY:"${runOf(r, HEX, 32)}",VITE_APP_URL:"https://app.acme.test"};</script>`),
    [inl("inline-script", "Amplitude API Key", "public")]),
  rw("supabase-publishable-key-is-public", (r) =>
    page("", `<script>const h={apikey:"${["sb", "_publish", "able_"].join("")}${runOf(r, ALNUM + "-_", 28)}","Content-Type":"application/json"};</script>`),
    [inl("inline-script", "Supabase Publishable Key", "public")]),
  rw("supabase-secret-key-is-a-leak", (r) =>
    page("", `<script>const h={apikey:"${["sb", "_sec", "ret_"].join("")}${runOf(r, ALNUM + "-_", 28)}"};</script>`),
    [inl("inline-script", "Supabase Secret Key", "high")]),

  // 8. A `data-*` credential attribute on a `<script src>` is that loader's
  // own configuration, read out of the DOM by the vendor's script.
  rw("vendor-widget-data-api-key-on-a-script-tag", (r) =>
    page("", `<script async src="https://app.vendorwidget.test/w.js" data-vendorwidget="true" data-api-key="vw_${runOf(r, HEX, 32)}"></script>`),
    [inl("html", "Third-party Widget Key", "public")]),
  rw("data-api-key-on-a-plain-element-is-still-a-leak", (r) =>
    page("", `<div id="app" data-env="production" data-api-key="${runOf(r, ALNUM, 32)}"></div>`),
    [inl("html", "Generic API Key Assignment")]),

  // 9. A connection string carrying no credentials has none to leak.
  rw("docs-connection-strings-without-credentials", () =>
    page("", `<pre class="snippet"><code>DATABASE_URL=postgresql://…\nREDIS_URL=redis://…\nMONGO_URL=mongodb+srv://user:</code></pre>`),
    []),
  rw("connection-string-with-a-password-still-reports", (r) =>
    page("", `<script>const url="mysql://app_user:${runOf(r, ALNUM, 18)}@db.internal:3306/prod";</script>`),
    [inl("inline-script", "MySQL Connection String", "high")]),

  // Round 5, second pass: the shapes the first version of two of these guards
  // silenced. A guard that looks in one place and concludes "no credential"
  // when it finds none there is the bug these pin.

  // 1. A driver takes the password from the query string as readily as from
  // the authority, and a userinfo colon can be percent-encoded.
  rw("connection-string-with-the-password-in-the-query-still-reports", (r) =>
    page("", `<script>const url="postgresql://app@db.internal:5432/prod?sslmode=require&password=${runOf(r, ALNUM, 20)}";</script>`),
    [inl("inline-script", "PostgreSQL Connection String", "high")]),
  rw("jdbc-connection-string-with-the-password-in-the-query-still-reports", (r) =>
    page("", `<script>const url="jdbc:mysql://db.internal:3306/prod?user=app&password=${runOf(r, ALNUM, 20)}";</script>`),
    [inl("inline-script", "MySQL Connection String", "high")]),
  rw("connection-string-with-a-percent-encoded-userinfo-colon-still-reports", (r) =>
    page("", `<script>const url="mongodb://app%3A${runOf(r, ALNUM, 18)}@cluster0.${runOf(r, LOWER, 5)}.mongodb.test/prod";</script>`),
    [inl("inline-script", "MongoDB Connection String", "high")]),

  // 2. An absolute URL under a credential key is often the credential itself:
  // a webhook endpoint is a bearer token in URL form.
  rw("teams-incoming-webhook-url-under-a-secret-key-still-reports", (r) =>
    page("", `<script>const cfg={webhookSecret:"https://acme.webhook.office.test/webhookb2/${uuid(r)}@${uuid(r)}/IncomingWebhook/${runOf(r, HEX, 32)}/${uuid(r)}"};</script>`), // pragma: allowlist secret
    [inl("inline-script", "Generic Secret Assignment")]),
  rw("zapier-catch-hook-url-under-a-secret-key-still-reports", (r) =>
    page("", `<script>const cfg={secret:"https://hooks.zapier.test/hooks/catch/${runOf(r, DIGIT, 7)}/${runOf(r, ALNUM, 8)}/"};</script>`), // pragma: allowlist secret
    [inl("inline-script", "Generic Secret Assignment")]),

  // 3. A first-party bundle's `data-api-key` is the site's own key in the
  // site's own markup: nothing about that says public.
  rw("data-api-key-on-a-first-party-script-is-still-a-leak", (r) =>
    page("", `<script src="/assets/app.js" data-api-key="${runOf(r, ALNUM, 32)}"></script>`),
    [inl("html", "Generic API Key Assignment")]),
  rw("data-api-key-on-a-relative-script-is-still-a-leak", (r) =>
    page("", `<script src="app.js" data-api-key="${runOf(r, ALNUM, 32)}"></script>`),
    [inl("html", "Generic API Key Assignment")]),

  // 4. A credential-shaped query name with no signature and no expiry beside
  // it is not a presigned URL.
  rw("aws-key-id-in-a-bare-credential-query-parameter-still-reports", (r) =>
    page("", `<script>var u="https://acme-downloads.s3.amazonaws.test/x.zip?X-Amz-Credential=${["AK", "IA"].join("")}${awsKeySuffix(r)}";</script>`),
    [inl("inline-script", "AWS Access Key ID", "high")]),
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
