// Hand-written look-alikes that MUST NOT fire, or must fire only as `public`.
// All of it is written here from scratch: nothing is copied from a vendor
// bundle. Values are assembled at runtime so no line is a token-shaped literal.
//
// A negative that no pattern could ever reach proves nothing, so most of these
// sit right at a pattern's or a filter's boundary: one character short of a
// floor, the false-positive list doing its job on a real-shaped token, a JWT
// with the right header and the wrong issuer.

import { page } from "./contexts";
import type { Case } from "./cases";
import { mixedRun, runOf, seededRng, supabaseJwt, type Rng } from "./generators";

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT = "0123456789";
const HEX = "0123456789abcdef";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = LOWER + UPPER + DIGIT;

const URL = "https://acme.test/dashboard";

/** FNV-1a, same as cases.ts: each negative draws from its own id's RNG. */
function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const neg = (id: string, build: (r: Rng) => string, extra: Partial<Case> = {}): Case => ({
  id: `neg:${id}`,
  url: URL,
  html: build(seededRng(seedOf(`neg:${id}`))),
  expect: [],
  ...extra,
});

const hex32 = (r: Rng) => runOf(r, HEX, 32);
const hex64 = (r: Rng) => runOf(r, HEX, 64);
const uuid = (r: Rng) => [8, 4, 4, 4, 12].map((n) => runOf(r, HEX, n)).join("-");
const b64url = (s: string) => Buffer.from(s).toString("base64url");

/** Base64-looking filler with a `/` every 20 chars, so it holds no 30-run of its own. */
const b64Filler = (r: Rng, n: number) =>
  Array.from({ length: Math.ceil(n / 21) }, () => runOf(r, ALNUM, 20)).join("/").slice(0, n);

export const NEGATIVES: Case[] = [
  neg("gtm-and-ga-ids", (r) =>
    page(
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-${runOf(r, UPPER + DIGIT, 10)}');</script>`,
      `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-${runOf(r, UPPER + DIGIT, 7)}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`,
    ),
  ),

  neg(
    "stripe-publishable-live",
    (r) => page("", `<script>const stripe=Stripe(${JSON.stringify(["p", "k_li", "ve_"].join("") + runOf(r, ALNUM, 24))});</script>`),
    { expect: [{ pattern: "Stripe Publishable Key", check: "public", location: "inline-script" }] },
  ),

  neg("stripe-publishable-test", (r) =>
    page("", `<script>const stripe=Stripe(${JSON.stringify(["p", "k_te", "st_"].join("") + runOf(r, ALNUM, 24))});</script>`),
  ),

  neg(
    "stripe-publishable-test-under-apikey",
    (r) =>
      page("", `<script>const cfg={apiKey:${JSON.stringify(["p", "k_te", "st_"].join("") + runOf(r, ALNUM, 24))},locale:"en"};</script>`),
    {
      // No Stripe pattern knows `pk_test_`, so the generic assignment gets it.
      expect: [{ pattern: "Generic API Key Assignment", check: "medium", location: "inline-script" }],
      knownGap: "Stripe `pk_test_` (public, test mode) has no pattern; under `apiKey:` the generic assignment reports a medium warning for it",
    },
  ),

  neg(
    "google-maps-browser-key",
    (r) =>
      page(
        `<script src="https://maps.googleapis.com/maps/api/js?key=${["AI", "za"].join("") + runOf(r, ALNUM + "-_", 35)}&libraries=places" async defer></script>`,
        "",
      ),
    { expect: [{ pattern: "Google API Key (browser)", check: "public", location: "html" }] },
  ),

  neg(
    "sentry-dsn",
    (r) =>
      page(
        "",
        `<script>Sentry.init({dsn:"https://${hex32(r)}@o${runOf(r, DIGIT, 6)}.ingest.sentry.io/${runOf(r, DIGIT, 7)}",tracesSampleRate:0.1});</script>`,
      ),
    { expect: [{ pattern: "Sentry DSN", check: "public", location: "inline-script" }] },
  ),

  neg(
    "posthog-project-key",
    (r) => page("", `<script>posthog.init(${JSON.stringify(["ph", "c_"].join("") + runOf(r, ALNUM, 43))},{api_host:"https://us.i.posthog.com"});</script>`),
    { knownGap: "PostHog phc_ project keys are not recognised at all (no pattern); a public-tier info finding would be right" },
  ),

  neg(
    "supabase-anon-jwt",
    (r) =>
      page(
        "",
        `<script>const supabase=createClient("https://${runOf(r, LOWER, 20)}.supabase.co",${JSON.stringify(supabaseJwt(r, "anon"))});</script>`,
      ),
    { expect: [{ pattern: "Supabase Anon Key", check: "public", location: "inline-script" }] },
  ),

  neg(
    "hs256-jwt-from-another-issuer",
    (r) =>
      page(
        "",
        `<script>window.__SESSION__={session:"${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
          JSON.stringify({ iss: "https://auth.acme.test", sub: `usr_${runOf(r, ALNUM, 12)}`, aud: "acme-web", iat: 1700000000, exp: 1700003600 }),
        )}.${runOf(r, ALNUM + "-_", 43)}",expires:1700003600};</script>`,
      ),
    {
      // Same header as every HS256 JWT on the web; the pattern reads nothing
      // past it, so a first-party session token is "a Supabase anon key".
      expect: [{ pattern: "Supabase Anon Key", check: "public", location: "inline-script" }],
      knownGap: "any HS256 JWT with a 100+ char payload is reported as a Supabase anon key: the pattern is the generic HS256 header, not anything Supabase-specific",
    },
  ),

  neg("rs256-jwt-is-not-supabase", (r) =>
    page(
      "",
      `<script>window.__SESSION__={session:"${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${mixedRun(r, 160, ALNUM + "-_")}.${mixedRun(r, 86, ALNUM + "-_")}",expires:1700000000};</script>`,
    ),
  ),

  neg(
    "base64-image-data-uri",
    (r) =>
      // Base64 is 62/64 alphanumeric, so a run of 30+ without `+` or `/` shows
      // up every few hundred characters and `sk` opens one every ~4 KB. The
      // run is placed deliberately here rather than left to the RNG.
      page(
        "",
        `<img alt="chart" src="data:image/png;base64,iVBORw0KGgo${"A".repeat(24)}${b64Filler(r, 1500)}/sk${runOf(r, ALNUM, 34)}/${b64Filler(r, 1500)}${"A".repeat(30)}${b64Filler(r, 400)}==">`,
      ),
    // Sanity needs the brand word within reach now (#357); no page of
    // images carries it.
  ),

  neg("release-checksums-with-brand-prose", (r) =>
    page(
      "",
      `<p>The 2.3 release wires the Twilio, Segment and Datadog integrations together and ships the Cloudflare adapter.</p>` +
        `<table><tr><td>acme-2.3.0-linux-x64.tar.gz</td><td><code>${hex64(r)}</code></td></tr>` +
        `<tr><td>acme-2.3.0-darwin-arm64.tar.gz</td><td><code>${hex64(r)}</code></td></tr></table>` +
        `<pre>sha256: ${hex64(r)}\nmd5: ${hex32(r)}</pre>` +
        `<script>window.__RELEASE__={version:"2.3.0",assets:[{name:"linux",sha256:"${hex64(r)}",checksum:"${hex32(r)}"},{name:"darwin",sha256:"${hex64(r)}"}],commit:"${runOf(r, HEX, 40)}"}</script>`,
    ),
  ),

  neg("chunk-hashes-at-the-bare-shape-floors", (r) =>
    // 32- and 64-hex asset hashes right where Segment/Together would match,
    // under keys that name a digest or a file rather than a credential.
    page(
      `<script src="/_next/static/chunks/2443-${runOf(r, HEX, 16)}.js" defer></script>`,
      `<script>self.__BUILD_MANIFEST={"/segment":["static/chunks/pages/segment-${hex32(r)}.js"],together:{integrity:"sha256-${hex64(r)}",etag:"${hex32(r)}",file:"${hex64(r)}.js"}};</script>`,
    ),
  ),

  neg("uuids-as-request-ids", (r) =>
    page(
      "",
      `<script>window.__REQ__={requestId:"${uuid(r)}",traceId:"${uuid(r)}",herokuAppName:"acme-web",pineconeIndex:"docs-v2",region:"eu"};</script>` +
        `<a href="https://postmarkapp.example/status" data-request-id="${uuid(r)}">Email status</a>`,
    ),
  ),

  neg("bearer-19-char-literal-then-interpolation", () =>
    // One under the Bearer pattern's 20-char floor. The template form and the
    // concatenation form are how real code writes the header.
    page(
      "",
      "<script>async function api(path,token){return fetch(path,{headers:{Authorization:`Bearer ${token}`,Accept:\"application/json\"}})}" +
        'function legacy(t){return {Authorization:"Bearer "+t}}' +
        'function prefixed(t){return {Authorization:"Bearer acme_v2_0123456789"+t}}</script>',
    ),
  ),

  neg("identifier-value-under-a-credential-key", () =>
    // Under `segmentKey`, in a Segment window, an UNQUOTED identifier: only
    // the identifier filter stands between this and a finding. (Quoted, the
    // same string is a literal assigned as a secret and reports; see the
    // probes in cases.ts.)
    page(
      "",
      `<script>var cfg={segmentKey:segmentAnalyticsMiddlewareFactoryInstance,onCloudflareChallengeCompletedCallbackHandlerFn:handleAuthenticationRedirectAfterLoginSuccessCallback};</script>`,
    ),
  ),

  neg(
    "sk-prefixed-identifier",
    () =>
      page(
        "",
        `<script>function skeletonLoaderComponentFactoryInstance42(){return null}window.skeletonLoaderComponentFactoryInstance42=skeletonLoaderComponentFactoryInstance42;</script>`,
      ),
  ),

  neg(
    "sk-prefixed-css-class",
    () =>
      page("", `<div class="card skeletonLoaderShimmerAnimatedRowVariant sk-loading"><span class="skeleton-row"></span></div>`),
  ),

  neg("sk-prefixed-class-one-under-the-floor", () =>
    // `sk` + 29 alphanumerics: the same shape one character short.
    page("", `<div class="skeletonLoaderShimmerAnimated"></div>`),
  ),

  neg("env-reference-not-literal", () =>
    page(
      "",
      `<script>const cfg={secret:process.env.SECRET,apiKey:process.env.API_KEY,accessToken:process.env.ACCESS_TOKEN??undefined,apiKeyName:SERVICE_API_KEY_WITH_A_LONG_IDENTIFIER};</script>`,
    ),
  ),

  neg("password-seven-chars", (r) =>
    // One under the generic secret pattern's 8-char floor; the empty string is
    // the other end of the same edge.
    page("", `<script>const form={username:"",password:"",remember:false};const seed={password:"${runOf(r, ALNUM, 7)}"};</script>`), // pragma: allowlist secret
  ),

  neg(
    "password-eight-random-chars",
    // The entropy floor scales with length (#357): eight distinct characters
    // is 3 bits/char, which is all eight characters can have, and it passes.
    (r) => page("", `<script>const seed={password:"${runOf(r, ALNUM, 8)}"};</script>`), // pragma: allowlist secret
    { expect: [{ pattern: "Generic Secret Assignment", check: "medium", location: "inline-script" }] },
  ),

  neg("password-eight-chars-of-two-letters", () =>
    // The same length with no entropy is a placeholder.
    page("", `<script>const seed={password:"aabbaabb"};</script>`), // pragma: allowlist secret
  ),

  neg(
    "password-changeme-is-a-weak-credential-not-a-placeholder",
    // A deliberate choice: `changeme` clears the length-scaled floor (2.75 of
    // a possible 2.5 at eight characters). It is as often a real default
    // credential as a placeholder, and silencing it would hide the former.
    () => page("", `<script>const seed={password:"changeme"};</script>`), // pragma: allowlist secret
    { expect: [{ pattern: "Generic Secret Assignment", check: "medium", location: "inline-script" }] },
  ),

  neg("quoted-instruction-string-under-a-credential-key", () =>
    // Quoted and under a credential key, but made of words with no digit:
    // the identifier heuristic still applies and drops it.
    page("", `<script>window.__CFG__={cloudflare:{token:"paste_your_cloudflare_api_token_here_now"}};</script>`),
  ),

  neg(
    "password-sixteen-random-chars",
    (r) => page("", `<script>const seed={password:"${runOf(r, ALNUM, 16)}"};</script>`), // pragma: allowlist secret
    { expect: [{ pattern: "Generic Secret Assignment", check: "medium", location: "inline-script" }] },
  ),

  neg("placeholder-api-key", () =>
    page("", `<script>const client=new Client({apiKey:"YOUR_API_KEY_GOES_HERE_REPLACE_ME_NOW",timeout:3000});</script>`), // pragma: allowlist secret
  ),

  neg(
    "real-shaped-token-with-an-fp-word-inside-is-kept",
    (r) =>
      // A `ghp_` token of the right length whose random body happens to say
      // `dummy`. The placeholder list is anchored to the value's head and
      // tail now (#357), so a word in the middle of a token is not a verdict.
      page("", `<script>const t={${["gh", "p_"].join("")}:"${["gh", "p_"].join("")}${runOf(r, ALNUM, 12)}dummy${runOf(r, ALNUM, 19)}"};</script>`),
    { expect: [{ pattern: "GitHub Personal Access Token", check: "high", location: "inline-script" }] },
  ),

  neg("placeholder-shaped-token-at-the-head", (r) =>
    // `ghp_dummy…`: the word right after the prefix IS the value.
    page("", `<script>const t={${["gh", "p_"].join("")}:"${["gh", "p_"].join("")}dummy${runOf(r, ALNUM, 31)}"};</script>`),
  ),

  neg("css-class-soup", () =>
    page(
      "",
      `<div class="flex min-h-screen flex-col items-center justify-between p-24 bg-gradient-to-b from-zinc-200 backdrop-blur-2xl dark:border-neutral-800 dark:bg-zinc-800/30 dark:from-inherit lg:static lg:w-auto lg:rounded-xl lg:border lg:bg-gray-200 lg:p-4 lg:dark:bg-zinc-800/30 group-hover:translate-x-1 motion-reduce:transform-none"><span class="sr-only">Loading</span></div>`,
    ),
  ),

  neg(
    "google-oauth-client-id",
    (r) =>
      page(
        "",
        `<script>google.accounts.id.initialize({client_id:"${runOf(r, DIGIT, 12)}-${runOf(r, LOWER + DIGIT, 32)}.apps.googleusercontent.com",callback:onSignIn});</script>`,
      ),
    { expect: [{ pattern: "Google OAuth Client ID", check: "public", location: "inline-script" }] },
  ),

  neg(
    "mapbox-public-token",
    (r) => page("", `<script>mapboxgl.accessToken="pk.${b64url(JSON.stringify({ u: "acme-maps", a: `cm${runOf(r, LOWER + DIGIT, 24)}` })).replace(/[-_]/g, "x")}.${runOf(r, ALNUM, 22)}";new mapboxgl.Map({container:"map"});</script>`),
    { expect: [{ pattern: "Mapbox Access Token", check: "public", location: "inline-script" }] },
  ),

  neg(
    "paypal-client-id-lowercase",
    (r) => page("", `<script>paypal.Buttons({clientId:"AZ${runOf(r, LOWER + DIGIT, 78)}"}).render("#paypal");</script>`),
    { expect: [{ pattern: "PayPal Client ID", check: "public", location: "inline-script" }] },
  ),

  neg(
    "paypal-client-id-mixed-case",
    (r) => page("", `<script>paypal.Buttons({clientId:"AZ${mixedRun(r, 78)}"}).render("#paypal");</script>`),
    {
      knownGap:
        "PayPal `[Aa][Zz][Aa-zZ0-9-_]{60,}`: the class omits uppercase B-Y, so a real mixed-case client id never fires",
    },
  ),
];
