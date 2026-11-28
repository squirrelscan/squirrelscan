import type { Detector, TechCategory, TechFingerprint } from "../types";

import { inScript, resourceAttr, scriptSrc } from "./helpers";

// Batch 1 of the port from the MIT-licensed Wappalyzer snapshot (#2422): HTTPArchive/wappalyzer at commit
// aff18efaf, the last revision before the data was relicensed (see THIRD_PARTY_NOTICES.md). Only the signals a
// logged-out audit can read from static markup were taken: `scriptSrc`, `html`, `meta`. Every pattern was rewritten
// to this package's rules, none is copied:
//  - a script host ends at a URL boundary (`/`, `?`, `#`, a port or the end), so `cdn.example.com.evil.test` or
//    `cdn.example.comx` is no match; a file name ends at `?`, `#` or the end, so `lib.js.map` is none either;
//  - a vendor domain is matched with at most four sub-domain labels, each at most 63 characters;
//  - no generic literal (`highcharts.*\.js`, `kakao`, `zip\.co`) stands alone; a library file name is exact;
//  - `js`, `dom`, `cookies`, `dns`, `xhr`, `css` and `robots` signals are dropped: they need a rendered page.
// Each fingerprint was read off a live site that loads it (listed in the pull request for #2422). No `icon` is set:
// badges render name-only until icons are sourced.

const SCHEME = String.raw`(?:https?:)?\/\/`;
const PORT = String.raw`(?::\d{1,5})?`;
/** Zero to four sub-domain labels in front of a vendor domain. */
const ANY_SUB = String.raw`(?:[a-z0-9-]{1,63}\.){0,4}`;
// One to four sub-domain labels, the first never `www`: that is the vendor's own marketing site, whose scripts say
// nothing about the page that loads them.
const SOME_SUB = String.raw`(?!www\.)(?:[a-z0-9-]{1,63}\.){1,4}`;
// A path pattern for a library file served from the site's own host or any CDN: an optional origin, then the file.
const ANY_ORIGIN = String.raw`(?:(?:https?:)?\/\/[^\/"'\s]{1,200})?\/(?:[^"'\s?#]{0,200}\/)?`;

/** A script on `host` (a regex source for the host name only) or any path under it. Ends at the host boundary. */
function onHost(host: string): string {
  return String.raw`${SCHEME}${host}${PORT}(?=[\/?#]|$)`;
}

/** A script file on `host`: `path` is a regex source for the path, which must end the URL (`?` and `#` allowed after). */
function fileOn(host: string, path: string): string {
  return String.raw`${SCHEME}${host}${PORT}${path}(?=[?#]|$)`;
}

/** A vendor domain, with any sub-domain in front: `cdn.vendor.com`, `a.b.vendor.com`, `vendor.com`. */
const domain = (d: string): string => `${ANY_SUB}${d}`;
/** A vendor domain that always has a sub-domain in front: `cdn.vendor.com`, never the bare `vendor.com`. */
const subdomain = (d: string): string => `${SOME_SUB}${d}`;

interface Spec {
  id: string;
  name: string;
  category: TechCategory;
  website: string;
  /** Script URL patterns, each as built by `onHost` / `fileOn` (or a literal path pattern). */
  urls: string[];
  /** Stylesheet and preload `link` patterns, for a vendor whose static markup names it only that way. */
  links?: string[];
  extra?: Detector[];
  confidence?: TechFingerprint["confidence"];
  versionPattern?: RegExp;
}

/** The longest literal every match of a URL pattern contains: the gate (`requires`) of its inline-loader detector. */
function literalOf(urlSource: string): string {
  const stripped = urlSource
    .replaceAll(/\(\?[=!][^)]*\)/g, "\0") // lookaheads
    .replaceAll(/\((?:\?:)?[^()]*\)/g, "\0") // groups (alternations, sub-domain labels, optional parts)
    .replaceAll(/\[[^\]]*\]/g, "\0") // character classes
    .replaceAll(/\\([./])/g, "$1")
    .replaceAll(/\{\d+(?:,\d+)?\}|[?*+^$]/g, "\0");
  const best = stripped
    .split(/[^A-Za-z0-9._-]+/)
    .map((piece) => piece.replace(/^\.+|\.+$/g, ""))
    .reduce((a, b) => (b.length > a.length ? b : a), "");
  if (best.length < 3)
    throw new Error(`no literal to gate the loader pattern ${urlSource}`);
  return best;
}

/**
 * The loader snippet vendors tell a site to paste, `s.src = "https://host/..."` (or `setAttribute("src", ...)`) in an
 * inline script: static markup carries it where it carries no `<script src>`, because the tag is created at run time.
 * Reads the body of a real `<script>` only, so prose and a code sample in `<pre>` are no evidence.
 */
function inlineLoader(urlSource: string): Detector {
  const atEnd = urlSource
    .replace(String.raw`(?=[?#]|$)`, String.raw`(?=[?#"'\x60])`)
    .replace(String.raw`(?=[\/?#]|$)`, String.raw`(?=[\/?#"'\x60])`);
  return inScript(
    String.raw`(?:\.src\s{0,8}=|setAttribute\s{0,8}\(\s{0,8}["']src["']\s{0,8},)\s{0,8}["'\x60]${atEnd}`,
    literalOf(urlSource)
  );
}

function fingerprint(spec: Spec): TechFingerprint {
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    website: spec.website,
    detectors: [
      ...spec.urls.flatMap((url) => scriptSrc(url)),
      ...spec.urls.map((url) => inlineLoader(url)),
      ...(spec.links ?? []).map((url) =>
        resourceAttr("link", "href|src|data-src", url)
      ),
      ...(spec.extra ?? []),
    ],
    confidence: spec.confidence,
    versionPattern: spec.versionPattern,
  };
}

const SPECS: Spec[] = [
  {
    id: "jquery-cdn",
    name: "jQuery CDN",
    category: "cdn",
    website: "https://code.jquery.com/",
    urls: [onHost(String.raw`code\.jquery\.com`)],
  },
  {
    id: "rewardful",
    name: "Rewardful",
    category: "ad-network",
    website: "https://www.getrewardful.com/",
    urls: [onHost(String.raw`r\.wdfl\.co`)],
  },
  {
    id: "contentsquare",
    name: "Contentsquare",
    category: "analytics",
    website: "https://contentsquare.com",
    urls: [onHost(subdomain(String.raw`contentsquare\.net`))],
  },
  {
    id: "clicky",
    name: "Clicky",
    category: "analytics",
    website: "https://clicky.com",
    urls: [onHost(String.raw`static\.getclicky\.com`)],
  },
  {
    id: "elfsight",
    name: "Elfsight",
    category: "widget",
    website: "https://elfsight.com",
    urls: [onHost(subdomain(String.raw`elfsight\.com`))],
  },
  {
    id: "embedly",
    name: "Embedly",
    category: "widget",
    website: "https://embed.ly",
    urls: [onHost(String.raw`cdn\.embedly\.com`)],
  },
  {
    id: "tilda",
    name: "Tilda",
    category: "cms",
    website: "https://tilda.cc",
    urls: [
      onHost(subdomain(String.raw`tildacdn\.(?:com|net|biz)`)),
      onHost(subdomain(String.raw`tilda\.ws`)),
    ],
    links: [
      onHost(subdomain(String.raw`tildacdn\.(?:com|net|biz)`)),
      onHost(subdomain(String.raw`tilda\.ws`)),
    ],
  },
  {
    id: "sharethis",
    name: "ShareThis",
    category: "widget",
    website: "https://sharethis.com",
    urls: [onHost(subdomain(String.raw`sharethis\.com`))],
  },
  {
    id: "ezoic",
    name: "Ezoic",
    category: "ad-network",
    website: "https://www.ezoic.com",
    urls: [
      onHost(String.raw`(?:www\.)?ezojs\.com`),
      onHost(subdomain(String.raw`ezoic\.(?:com|net)`)),
      onHost(subdomain(String.raw`ezodn\.(?:com|net)`)),
    ],
  },
  {
    id: "socket-io",
    name: "Socket.io",
    category: "framework",
    website: "https://socket.io",
    urls: [
      // `/socket.io/socket.io.js` served by the app itself, or `cdn.socket.io/<version>/socket.io.min.js`.
      `${ANY_ORIGIN}socket\\.io(?:\\.slim)?(?:\\.msgpack)?(?:\\.min)?(?:\\.dev)?\\.js(?=[?#]|$)`,
    ],
    confidence: "medium",
  },
  {
    id: "lucky-orange",
    name: "Lucky Orange",
    category: "analytics",
    website: "https://www.luckyorange.com",
    urls: [onHost(subdomain(String.raw`luckyorange\.com`))],
  },
  {
    id: "skimlinks",
    name: "Skimlinks",
    category: "ad-network",
    website: "https://skimlinks.com",
    urls: [onHost(subdomain(String.raw`skimresources\.com`))],
  },
  {
    id: "awin",
    name: "AWIN",
    category: "ad-network",
    website: "https://www.awin.com",
    urls: [onHost(String.raw`(?:www\.)?dwin[12]\.com`)],
  },
  {
    id: "uptimerobot",
    name: "UptimeRobot",
    category: "other",
    website: "https://uptimerobot.com",
    urls: [onHost(subdomain(String.raw`uptimerobot\.com`))],
  },
  {
    id: "leadinfo",
    name: "Leadinfo",
    category: "analytics",
    website: "https://www.leadinfo.com",
    urls: [onHost(String.raw`cdn\.leadinfo\.net`)],
    extra: [
      // The loader snippet passes the script URL to its function as an argument, not as a `src` assignment.
      inScript(
        String.raw`["']${SCHEME}cdn\.leadinfo\.net\/ping\.js["']`,
        "cdn.leadinfo.net"
      ),
    ],
  },
  {
    id: "plaid",
    name: "Plaid",
    category: "payment",
    website: "https://plaid.com",
    urls: [onHost(String.raw`cdn\.plaid\.com`)],
  },
  {
    id: "inspectlet",
    name: "Inspectlet",
    category: "analytics",
    website: "https://www.inspectlet.com",
    urls: [onHost(String.raw`cdn\.inspectlet\.com`)],
    extra: [
      // The marker comment of the embed snippet: the one detector that reads HTML comments.
      {
        type: "html",
        comments: true,
        requires: "Inspectlet Embed Code",
        pattern: /<!-- (?:Begin|End) Inspectlet Embed Code -->/i,
      },
    ],
  },
  {
    id: "mediavine",
    name: "Mediavine",
    category: "ad-network",
    website: "https://www.mediavine.com",
    urls: [onHost(subdomain(String.raw`mediavine\.com`))],
  },
  {
    id: "qualified",
    name: "Qualified",
    category: "chat",
    website: "https://www.qualified.com",
    urls: [onHost(String.raw`js\.qualified\.com`)],
  },
  {
    id: "acuity-scheduling",
    name: "Acuity Scheduling",
    category: "widget",
    website: "https://acuityscheduling.com",
    urls: [onHost(subdomain(String.raw`acuityscheduling\.com`))],
  },
  {
    id: "instant-page",
    name: "Instant.Page",
    category: "other",
    website: "https://instant.page",
    urls: [onHost(String.raw`instant\.page`)],
  },
  {
    id: "amcharts",
    name: "amCharts",
    category: "framework",
    website: "https://www.amcharts.com",
    urls: [
      onHost(String.raw`(?:cdn|www)\.amcharts\.com`),
      // The library file by its own name, from the site or any CDN.
      `${ANY_ORIGIN}amcharts(?:\\.min)?\\.js(?=[?#]|$)`,
    ],
    extra: [
      {
        type: "html",
        requires: "JavaScript chart by amCharts",
        pattern:
          /<svg\b[^>]{0,400}><desc>JavaScript chart by amCharts [\d.]{0,20}/i,
      },
    ],
    versionPattern: /<desc>JavaScript chart by amCharts (\d[\d.]{0,20})/i,
  },
  {
    id: "albacross",
    name: "Albacross",
    category: "analytics",
    website: "https://albacross.com",
    urls: [onHost(subdomain(String.raw`albacross\.com`))],
  },
  {
    id: "branch",
    name: "Branch",
    category: "analytics",
    website: "https://branch.io",
    urls: [
      onHost(String.raw`cdn\.branch\.io`),
      // The Branch web SDK loader, which carries its version: `<key>.app.link/_r?sdk=web2.78.0`.
      String.raw`${SCHEME}${ANY_SUB}app\.link\/_r\?sdk=web\d`,
    ],
    versionPattern: /\bapp\.link\/_r\?sdk=web(\d[\d.]{0,20})/i,
  },
  {
    id: "moengage",
    name: "MoEngage",
    category: "analytics",
    website: "https://www.moengage.com",
    urls: [onHost(String.raw`cdn\.moengage\.(?:com|io|net)`)],
  },
  {
    id: "adthrive",
    name: "AdThrive",
    category: "ad-network",
    website: "https://www.adthrive.com",
    urls: [onHost(String.raw`ads\.adthrive\.com`)],
    extra: [
      // The site config of the ads script: `window.adthrive.host = 'ads.adthrive.com'`.
      inScript(
        String.raw`\badthrive\.host\s{0,8}=\s{0,8}["']ads\.adthrive\.com["']`,
        "adthrive.host"
      ),
    ],
  },
  {
    id: "ethicalads",
    name: "EthicalAds",
    category: "ad-network",
    website: "https://www.ethicalads.io",
    urls: [onHost(String.raw`media\.ethicalads\.io`)],
  },
  {
    id: "manychat",
    name: "ManyChat",
    category: "chat",
    website: "https://manychat.com",
    urls: [onHost(String.raw`widget\.manychat\.com`)],
  },
  {
    id: "provide-support",
    name: "Provide Support",
    category: "chat",
    website: "https://www.providesupport.com",
    urls: [onHost(subdomain(String.raw`providesupport\.com`))],
  },
  {
    id: "ketch",
    name: "Ketch",
    category: "security",
    website: "https://www.ketch.com",
    urls: [onHost(subdomain(String.raw`ketchcdn\.com`))],
  },
  {
    id: "pingdom",
    name: "Pingdom",
    category: "analytics",
    website: "https://www.pingdom.com",
    urls: [onHost(subdomain(String.raw`pingdom\.net`))],
  },
  {
    id: "6sense",
    name: "6sense",
    category: "analytics",
    website: "https://6sense.com",
    urls: [onHost(subdomain(String.raw`6sc\.co`))],
  },
  {
    id: "digistore24",
    name: "Digistore24",
    category: "ad-network",
    website: "https://www.digistore24.com",
    urls: [
      onHost(String.raw`www\.digistore24\.com`),
      `${ANY_ORIGIN}digistore\\/digistore\\.js(?=[?#]|$)`,
    ],
  },
  {
    id: "clutch",
    name: "Clutch",
    category: "widget",
    website: "https://clutch.co",
    urls: [onHost(String.raw`widget\.clutch\.co`)],
  },
  {
    id: "jouwweb",
    name: "JouwWeb",
    category: "cms",
    website: "https://www.jouwweb.nl",
    urls: [
      onHost(subdomain(String.raw`jwwb\.nl`)),
      onHost(subdomain(String.raw`jouwweb\.nl`)),
    ],
  },
  {
    id: "gravitec",
    name: "Gravitec",
    category: "widget",
    website: "https://gravitec.net",
    urls: [onHost(String.raw`(?:cdn|id)\.gravitec\.(?:media|net)`)],
  },
  {
    id: "bamboohr",
    name: "BambooHR",
    category: "widget",
    website: "https://www.bamboohr.com",
    // The careers-page embed of a company's own BambooHR sub-domain.
    urls: [
      fileOn(subdomain(String.raw`bamboohr\.com`), String.raw`\/js\/embed\.js`),
    ],
  },
  {
    id: "fundraise-up",
    name: "Fundraise Up",
    category: "payment",
    website: "https://fundraiseup.com",
    urls: [onHost(subdomain(String.raw`fundraiseup\.com`))],
  },
  {
    id: "highcharts",
    name: "Highcharts",
    category: "framework",
    website: "https://www.highcharts.com",
    urls: [
      onHost(String.raw`code\.highcharts\.com`),
      // The library file by its own name (also `highcharts.src.js`), from the site or any CDN.
      `${ANY_ORIGIN}highcharts(?:\\.src)?(?:\\.min)?\\.js(?=[?#]|$)`,
    ],
    extra: [
      {
        type: "html",
        requires: "Created with Highcharts",
        pattern: /<svg\b[^>]{0,400}><desc>Created with Highcharts [\d.]{0,20}/i,
      },
    ],
    // One capture group: the CDN path `code.highcharts.com/[stock/]11.2.0/`, or the version in the SVG description.
    versionPattern:
      /(?<=\bcode\.highcharts\.com\/(?:(?:stock|maps|gantt)\/)?|<desc>Created with Highcharts )(\d{1,3}(?:\.\d{1,4}){1,3})(?=[/<\s])/i,
  },
  {
    id: "viral-loops",
    name: "Viral Loops",
    category: "widget",
    website: "https://viral-loops.com",
    urls: [onHost(String.raw`app\.viral-loops\.com`)],
  },
  {
    id: "fullcontact",
    name: "FullContact",
    category: "analytics",
    website: "https://www.fullcontact.com",
    urls: [onHost(String.raw`tags\.fullcontact\.com`)],
    extra: [
      // A publisher config naming the tag as JSON: `"sdkUrl":"https:\/\/tags.fullcontact.com\/anon\/fullcontact.js"`.
      inScript(
        String.raw`["']sdkUrl["']\s{0,8}:\s{0,8}["']https?:\\?\/\\?\/tags\.fullcontact\.com\\?\/`,
        "tags.fullcontact.com"
      ),
    ],
  },
  {
    id: "getsocial",
    name: "GetSocial",
    category: "widget",
    website: "https://getsocial.io",
    urls: [onHost(String.raw`api\.at\.getsocial\.io`)],
  },
  {
    id: "quantum-metric",
    name: "Quantum Metric",
    category: "analytics",
    website: "https://www.quantummetric.com",
    urls: [onHost(String.raw`cdn\.quantummetric\.com`)],
  },
  {
    id: "exoclick",
    name: "ExoClick",
    category: "ad-network",
    website: "https://www.exoclick.com",
    urls: [onHost(subdomain(String.raw`exoclick\.com`))],
    extra: [{ type: "meta", name: "exoclick-site-verification", pattern: /^/ }],
  },
  {
    id: "nextdoor-ads",
    name: "Nextdoor Ads",
    category: "ad-network",
    website: "https://business.nextdoor.com",
    urls: [onHost(String.raw`ads\.nextdoor\.com`)],
  },
  {
    id: "refersion",
    name: "Refersion",
    category: "ad-network",
    website: "https://www.refersion.com",
    urls: [onHost(subdomain(String.raw`refersion\.com`))],
  },
  {
    id: "tabby",
    name: "Tabby",
    category: "payment",
    website: "https://tabby.ai",
    urls: [onHost(String.raw`checkout\.tabby\.ai`)],
  },
  {
    id: "zip-pay",
    name: "Zip",
    category: "payment",
    website: "https://www.zip.co",
    urls: [
      onHost(String.raw`widgets\.quadpay\.com`),
      onHost(String.raw`static\.zipmoney\.com\.au`),
      onHost(String.raw`(?:widgets|static)\.zip\.co`),
    ],
  },
  {
    id: "ada",
    name: "Ada",
    category: "chat",
    website: "https://www.ada.cx",
    urls: [onHost(subdomain(String.raw`ada\.support`))],
  },
  {
    id: "octane-ai",
    name: "Octane AI",
    category: "widget",
    website: "https://www.octaneai.com",
    urls: [onHost(subdomain(String.raw`octaneai\.com`))],
    extra: [
      // The same Shopify script list: `"http:\/\/octaneai.com\/<id>\/shopify.js"`.
      inScript(
        String.raw`["']https?:\\?\/\\?\/(?:[a-z0-9-]{1,63}\.){0,3}octaneai\.com\\?\/`,
        "octaneai.com"
      ),
    ],
  },
  {
    id: "tencent-waterproof-wall",
    name: "Tencent Waterproof Wall",
    category: "security",
    website: "https://007.qq.com",
    urls: [
      fileOn(
        String.raw`(?:ssl|turing)\.captcha\.(?:qq|qcloud)\.com`,
        String.raw`\/TCaptcha(?:-global)?\.js`
      ),
    ],
  },
  {
    id: "birdeye",
    name: "Birdeye",
    category: "widget",
    website: "https://birdeye.com",
    urls: [
      onHost(subdomain(String.raw`birdeye\.com`)),
      `${SCHEME}(?:www\\.)?birdeye\\.com${PORT}\\/embed\\/`,
    ],
  },
  {
    id: "nudgify",
    name: "Nudgify",
    category: "widget",
    website: "https://www.nudgify.com",
    urls: [
      onHost(subdomain(String.raw`nudgify\.com`)),
      fileOn(
        String.raw`cdn\.convertize\.com`,
        String.raw`\/nudgify-shopify\.js`
      ),
    ],
  },
  {
    id: "postscript",
    name: "Postscript",
    category: "widget",
    website: "https://www.postscript.io",
    urls: [onHost(String.raw`sdk\.postscript\.io`)],
    extra: [
      // A Shopify theme lists its app scripts as strings, with escaped slashes: `"https:\/\/sdk.postscript.io\/..."`.
      inScript(
        String.raw`["']https?:\\?\/\\?\/sdk\.postscript\.io\\?\/`,
        "sdk.postscript.io"
      ),
    ],
  },
  {
    id: "valuecommerce",
    name: "ValueCommerce",
    category: "ad-network",
    website: "https://www.valuecommerce.co.jp",
    urls: [onHost(subdomain(String.raw`valuecommerce\.com`))],
  },
  {
    id: "junip",
    name: "Junip",
    category: "widget",
    website: "https://junip.co",
    urls: [onHost(subdomain(String.raw`juniphq\.com`))],
    extra: [
      // The review-widget app block of a Shopify theme: `data-star-template-url="https://api.juniphq.com/images/..."`.
      {
        type: "html",
        requires: "api.juniphq.com",
        pattern:
          /<[a-z][a-z0-9-]{0,30}\s(?:[^>]{0,400}\s)?data-star-template-url\s*=\s*["']https:\/\/api\.juniphq\.com\//i,
      },
    ],
  },
  {
    id: "attentive",
    name: "Attentive",
    category: "widget",
    website: "https://www.attentive.com",
    urls: [onHost(subdomain(String.raw`attn\.tv`))],
  },
  {
    id: "embedsocial",
    name: "EmbedSocial",
    category: "widget",
    website: "https://embedsocial.com",
    urls: [`${SCHEME}(?:www\\.)?embedsocial\\.com${PORT}\\/embedscript\\/`],
  },
  {
    id: "getsitecontrol",
    name: "Getsitecontrol",
    category: "widget",
    website: "https://getsitecontrol.com",
    urls: [onHost(subdomain(String.raw`getsitecontrol\.com`))],
  },
  {
    id: "hello-bar",
    name: "Hello Bar",
    category: "widget",
    website: "https://www.hellobar.com",
    urls: [onHost(subdomain(String.raw`hellobar\.com`))],
  },
  {
    id: "interact",
    name: "Interact",
    category: "widget",
    website: "https://www.tryinteract.com",
    urls: [onHost(subdomain(String.raw`tryinteract\.com`))],
  },
  {
    id: "bugherd",
    name: "BugHerd",
    category: "widget",
    website: "https://bugherd.com",
    urls: [
      fileOn(String.raw`www\.bugherd\.com`, String.raw`\/sidebar(?:v2)?\.js`),
    ],
  },
  {
    id: "marker-io",
    name: "Marker.io",
    category: "widget",
    website: "https://marker.io",
    urls: [onHost(String.raw`edge\.marker\.io`)],
  },
  {
    id: "optimonk",
    name: "OptiMonk",
    category: "widget",
    website: "https://www.optimonk.com",
    urls: [onHost(subdomain(String.raw`optimonk\.com`))],
  },
  {
    id: "qualtrics",
    name: "Qualtrics",
    category: "widget",
    website: "https://www.qualtrics.com",
    urls: [onHost(subdomain(String.raw`qualtrics\.com`))],
    extra: [
      // The Site Intercept snippet passes the engine URL to its starter: `<zone>.siteintercept.qualtrics.com/SIE/?Q_ZID=`.
      inScript(
        String.raw`["']${SCHEME}[a-z0-9-]{1,63}\.siteintercept\.qualtrics\.com\/(?:SIE|WRSiteInterceptEngine)\/\?Q_ZID=`,
        "siteintercept.qualtrics.com"
      ),
    ],
  },
  {
    id: "bambuser",
    name: "Bambuser",
    category: "video",
    website: "https://bambuser.com",
    urls: [onHost(subdomain(String.raw`bambuser\.com`))],
  },
  {
    id: "conveythis",
    name: "ConveyThis",
    category: "widget",
    website: "https://www.conveythis.com",
    urls: [onHost(String.raw`cdn\.conveythis\.com`)],
  },
  {
    id: "fast-bundle",
    name: "Fast Bundle",
    category: "widget",
    website: "https://fastbundle.co",
    urls: [onHost(String.raw`api\.fastbundle\.co`)],
    extra: [
      // The theme snippet: `const apiURL = 'https://api.fastbundle.co'`.
      inScript(
        String.raw`\b(?:apiURL|newBaseUrl)\s{0,8}=\s{0,8}["']https:\/\/(?:api|sdk)\.fastbundle\.co["']`,
        "fastbundle.co"
      ),
    ],
  },
  {
    id: "getyourguide",
    name: "GetYourGuide",
    category: "widget",
    website: "https://partner.getyourguide.com",
    urls: [onHost(subdomain(String.raw`getyourguide\.com`))],
  },
  {
    id: "kakao",
    name: "Kakao",
    category: "other",
    website: "https://developers.kakao.com",
    urls: [
      // The JavaScript SDK, from Kakao's developer site or its CDN.
      String.raw`${SCHEME}developers\.kakao\.com${PORT}\/sdk\/`,
      String.raw`${SCHEME}t1\.kakaocdn\.net${PORT}\/kakao_js_sdk\/`,
    ],
  },
  {
    id: "maxmind",
    name: "MaxMind",
    category: "other",
    website: "https://www.maxmind.com",
    urls: [
      onHost(String.raw`(?:device|js)\.maxmind\.com`),
      onHost(String.raw`geoip-js\.com`),
    ],
    // `geoip-js.com/js/apis/geoip2/v2.1/geoip2.js`, also served from `js.maxmind.com`.
    versionPattern:
      /\b(?:geoip-js|js\.maxmind)\.com\/(?:[^"'\s?#]{0,100}\/)?v(\d[\d.]{0,10})\//i,
  },
  {
    id: "searchanise",
    name: "Searchanise",
    category: "widget",
    website: "https://start.searchanise.com",
    urls: [
      onHost(domain(String.raw`searchanise(?:-[a-z0-9]{1,20}\.kxcdn)?\.com`)),
    ],
  },
  {
    id: "smile-io",
    name: "Smile",
    category: "widget",
    website: "https://smile.io",
    urls: [
      onHost(subdomain(String.raw`smile\.io`)),
      onHost(subdomain(String.raw`sweettooth\.io`)),
    ],
  },
];

export const WAPPALYZER_MIT_FINGERPRINTS: TechFingerprint[] =
  SPECS.map(fingerprint);
