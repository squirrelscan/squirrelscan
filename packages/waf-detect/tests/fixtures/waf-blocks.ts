// Challenge and block pages as each perimeter provider serves them, and for
// each provider a near-miss: an ordinary page that mentions the vendor, loads
// its script, or carries its CAPTCHA widget, which must never read as blocked.
//
// `how` says where each shape comes from:
//   live    : captured from a real public response on 2026-10-29 (then cut down,
//             hostnames and tokens replaced with placeholders)
//   docs    : the status and header are in the vendor's own documentation, the
//             body is built from the documented behaviour
//   reports : shape reported by site owners in public forums, not seen live
//   recalled: written from memory of the vendor's page, never seen by us
//   constructed: a near-miss built to look like the provider without being its page
// Every token below is a placeholder; none is a real session or key.

import type { WafBlockProvider } from "../../src";

export type Origin = "live" | "docs" | "reports" | "recalled" | "constructed";

export interface Sample {
  name: string;
  how: Origin;
  status: number;
  /** Lower-case header names, as `WafResponse.headers.raw`. */
  headers: Record<string, string>;
  html: string | null;
}

export interface BlockedSample extends Sample {
  provider: WafBlockProvider;
  /** A fragment the reported signal must contain. */
  signal: string;
}

const page = (head: string, body: string) =>
  `<!DOCTYPE html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

/** A few hundred words of ordinary content, so a page is clearly not an interstitial. */
const ARTICLE =
  "<main><h1>How we cut our checkout time in half</h1>" +
  Array.from(
    { length: 12 },
    (_, i) =>
      `<p>Paragraph ${i + 1}. We profiled the checkout flow, removed two blocking requests, cached the shipping quote, and measured the result over a week of real traffic before shipping it to everyone.</p>`,
  ).join("") +
  "</main>";

// ---------------------------------------------------------------- Cloudflare

const CF_MANAGED_CHALLENGE = page(
  '<title>Just a moment...</title><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="robots" content="noindex,nofollow">',
  '<div class="main-wrapper" role="main"><h1 class="zone-name-title h1">example.com</h1><p id="challenge-body-text" class="core-msg spacer">Verifying you are human. This may take a few seconds.</p></div>' +
    "<script>(function(){window._cf_chl_opt={cvId:'3',cZone:'example.com',cType:'managed',cRay:'0000000000000000'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=0000000000000000';document.head.appendChild(a)}());</script>",
);

// Glassdoor and Indeed shaped: a branded page with a large stylesheet, no
// "Just a moment" wording and no challenge script in the first bytes. Only the header says so.
const CF_HEADER_ONLY = page(
  "<title>Security Check</title><style>" +
    "body{margin:0}.center{margin:0 auto;width:800px}".repeat(900) +
    "</style>",
  '<div class="article"><h1>Additional Verification Required</h1><p>Please complete the check below.</p></div>',
);

const CF_BLOCK_PAGE = page(
  '<title>Attention Required! | Cloudflare</title><meta charset="UTF-8"><style>body{margin:0;padding:0}</style>',
  '<div id="cf-wrapper"><div id="cf-error-details" class="p-0"><header class="mx-auto pt-10 lg:pt-6 lg:px-8 w-240 lg:w-full mb-8"><h1 class="inline-block md:block mr-2 md:mb-2 font-light text-60 md:text-3xl text-black-dark leading-tight"><span data-translate="block_headline">Sorry, you have been blocked</span></h1>' +
    '<h2 class="text-gray-600 leading-1.3 text-3xl lg:text-2xl font-light">You are unable to access <span class="behind-ip-address">example.com</span></h2></header>' +
    '<section class="w-240 lg:w-full mx-auto mb-8 lg:px-8"><h2>Why have I been blocked?</h2><p>This website is using a security service to protect itself from online attacks.</p></section>' +
    '<div class="py-8 text-center"><span>Cloudflare Ray ID: <strong class="font-semibold">0000000000000000</strong></span></div></div></div>',
);

const CF_ORIGIN_ERROR = page(
  "<title>example.com | 522: Connection timed out</title>",
  '<div id="cf-wrapper"><div id="cf-error-details"><h1>Connection timed out</h1><p>The initial connection between Cloudflare\'s network and the origin web server timed out.</p>' +
    "<span>Cloudflare Ray ID: <strong>0000000000000000</strong></span></div></div>",
);

const CF_JSD_PAGE = page(
  "<title>Contact</title>",
  "<h1>Contact us</h1><p>Call or write any time.</p><script>var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.head.appendChild(a)</script>",
);

const TURNSTILE_FORM = page(
  "<title>Contact us</title>",
  ARTICLE +
    '<form method="post" action="/contact"><input name="email"><div class="cf-turnstile" data-sitekey="1x00000000000000000000AA"></div><button>Send</button></form>' +
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>',
);

// ------------------------------------------------------------------- Akamai

const akamaiDeny = (reference: string) =>
  '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \nYou don\'t have permission to access "http&#58;&#47;&#47;www&#46;example&#46;com&#47;" on this server.<P>\n' +
  `Reference&#32;&#35;${reference}\n<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;${reference}</P>\n</BODY>\n</HTML>\n`;

const AKAMAI_REF = "18&#46;2b672817&#46;1793241136&#46;8fd212e";

const AKAMAI_ORIGIN_403 =
  "<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>You do not have access to this page. Sign in to continue.</p></body></html>";

const AKAMAI_SUPPORT_ARTICLE = page(
  "<title>Fixing Akamai Access Denied errors</title>",
  "<h1>Fixing Akamai Access Denied errors</h1><p>When a request is denied the page prints a reference number, for example:</p>" +
    "<pre><code>Access Denied\nYou don't have permission to access this server.\nReference #18.2b672817.1793241136.8fd212e</code></pre>" +
    ARTICLE,
);

// ----------------------------------------------------------------- DataDome

const datadome = (type: "c" | "i") =>
  '<html lang="en"><head><title>example.com</title><style>#cmsg{animation: A 1.5s;}@keyframes A{0%{opacity:0;}99%{opacity:0;}100%{opacity:1;}}</style></head><body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p>' +
  `<script data-cfasync="false">var dd={'rt':'${type}','cid':'TESTCID0000000000000000000000','hsh':'TESTHASH0000000000','t':'fe','qp':'','s':48621,'host':'geo.captcha-delivery.com','cookie':'TESTCOOKIE'}</script>` +
  '<script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>';

const DATADOME_TAG_PAGE = page(
  "<title>Shop</title>",
  ARTICLE +
    '<script>window.ddjskey="TESTKEY";window.ddoptions={endpoint:"https://api-js.datadome.co/js/"}</script><script src="https://js.datadome.co/tags.js" async></script>',
);

const DATADOME_LOOKALIKE = page(
  "<title>example.com</title>",
  '<p>Please enable JS</p><script src="https://ct.captcha-delivery.com.attacker.example/c.js"></script>',
);

const DATADOME_QUOTED_ON_LONG_PAGE = page(
  "<title>Bot defence</title>",
  ARTICLE + '<script src="https://ct.captcha-delivery.com/c.js"></script>',
);

// ------------------------------------------------------------------- Kasada

const KASADA_CHALLENGE =
  "<!DOCTYPE html><html><head></head><body><script>window.KPSDK={};KPSDK.now=typeof performance!=='undefined'&&performance.now?performance.now.bind(performance):Date.now.bind(Date);KPSDK.start=KPSDK.now();</script>" +
  '<script src="/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/ips.js?KP_UIDz=TESTTOKEN&amp;x-kpsdk-im=TESTIM"></script></body></html>';

const KASADA_SPARSE_SHELL = page(
  "<title>App</title>",
  '<div id="root"></div><script>window.KPSDK={};KPSDK.start=Date.now();</script><script src="/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/ips.js"></script>' +
    "<h1>Loading</h1>",
);

// -------------------------------------------------------- HUMAN (PerimeterX)

const PX_BLOCK =
  "<!DOCTYPE html> <html lang=\"en\"> <head> <meta charset=\"utf-8\"> <meta name=\"description\" content=\"px-captcha\"> <title>Access to this page has been denied</title> </head> <body> <script> /* PerimeterX assignments */ window._pxVid = ''; window._pxUuid = '00000000-0000-4000-8000-000000000003'; window._pxAppId = 'PXtest0000'; window._pxHostUrl = '/test0000/xhr'; window._pxJsClientSrc = '/test0000/init.js'; var pxCaptchaSrc = '/test0000/captcha/captcha.js?a=c'; </script> <div class=\"px-captcha-container\"><h1>Please verify you are a human</h1></div> </body> </html>";

const PX_SENSOR_PAGE = page(
  "<title>Shop</title>",
  ARTICLE +
    "<script>window._pxAppId='PXtest0000';window._pxJsClientSrc='/test0000/init.js'</script>",
);

const PX_QUOTED = page(
  "<title>Fix: Access to this page has been denied</title>",
  "<h1>Fix: Access to this page has been denied</h1><p>If a site shows this, wait and retry.</p>" +
    ARTICLE,
);

// A site's own restyled HUMAN challenge, served through Cloudflare at 403: the
// title is the site's, the captcha mount point and callback are HUMAN's.
const PX_BRANDED =
  '<!DOCTYPE html><html lang="en-US"><head><meta charset="utf-8"><title>Verify to continue</title><meta name="pxAppId" content="PXtest0000"></head><body><main><h1>It needs a human touch</h1>' +
  '<p>Complete the task and we will get you right back in.</p><div id="px-captcha"></div></main>' +
  "<script>window._pxAppId='PXtest0000';window._pxJsClientSrc='/test0000/init.js';window._pxOnCaptchaSuccess=function(){location.reload()};</script></body></html>";

// ------------------------------------------------------------------ Imperva

const IMPERVA_BLOCK =
  '<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW"></head><body style="margin:0px;height:100%">' +
  '<iframe id="main-iframe" src="/_Incapsula_Resource?CWUDNSAI=24&xinfo=0-0-0&incident_id=1234000280151781213-1234&edet=12" frameborder=0 width="100%" height="100%">' +
  "Request unsuccessful. Incapsula incident ID: 1234000280151781213-1234</iframe></body></html>";

const IMPERVA_PARDON = page(
  "<title>Pardon Our Interruption</title>",
  "<h1>Pardon Our Interruption</h1><p>As you were browsing something about your browser made us think you were a bot. There are a few reasons this might happen:</p><ul><li>You're a power user moving through this website with super-human speed.</li><li>You've disabled JavaScript in your web browser.</li></ul>",
);

const IMPERVA_JS_CHALLENGE =
  '<html><head><META NAME="robots" CONTENT="noindex,nofollow"><script src="/_Incapsula_Resource?SWJIYLWA=00000000000000000000000000000000,11111111111111111111111111111111"></script><body></body></html>';

const IMPERVA_NORMAL_PAGE = page(
  "<title>Home</title>",
  ARTICLE +
    '<script src="/_Incapsula_Resource?SWJIYLWA=00000000000000000000000000000000"></script>',
);

const IMPERVA_QUOTED = page(
  "<title>Reading Imperva block pages</title>",
  "<h1>Reading Imperva block pages</h1><p>A block page ends with a line like this:</p><pre><code>Request unsuccessful. Incapsula incident ID: 1234000280151781213-1234</code></pre>" +
    ARTICLE,
);

// ------------------------------------------------------------------- Sucuri

const SUCURI_BLOCK =
  '<!DOCTYPE html><html lang="en"><head><title>Sucuri WebSite Firewall - Access Denied</title></head><body><div class="content"><h1>Access Denied - Sucuri Website Firewall</h1><p>If you are the website owner, click here to whitelist your IP.</p><p>Block ID: BNP005</p></div></body></html>';

const SUCURI_MENTION = page(
  "<title>Is Sucuri worth it?</title>",
  "<h1>Is Sucuri worth it?</h1><p>The Sucuri WebSite Firewall can show an Access Denied page to visitors it flags.</p>" +
    ARTICLE,
);

// ------------------------------------------------------------------ AWS WAF

const AWS_CHALLENGE_PAGE =
  '<html><head><title></title></head><body><script>window.awsWafCookieDomainList = [];window.gokuProps = {"key":"TESTKEY","iv":"TESTIV","context":"TESTCTX"};</script>' +
  '<script src="https://0000000000000000.0000000000000000.us-east-1.token.awswaf.com/0000000000000000/0000000000000000/challenge.js"></script><noscript><h1>JavaScript is disabled</h1>In order to continue, we need to verify that you\'re not a robot. This requires JavaScript. Enable JavaScript and then reload the page.</noscript></body></html>';

const AWS_SDK_PAGE = page(
  "<title>Sign up</title>",
  ARTICLE +
    '<form id="f"><input name="email"><button>Join</button></form><script src="https://0000000000000000.0000000000000000.us-east-1.token.awswaf.com/0000000000000000/0000000000000000/challenge.js" defer></script><script>AwsWafIntegration.getToken()</script>',
);

const AWS_LOOKALIKE =
  '<html><body><script src="https://0000000000000000.us-east-1.token.awswaf.com.attacker.example/challenge.js"></script></body></html>';

// ----------------------------------------------------------------------- F5

const F5_REJECT =
  "<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.<br><br>Your support ID is: 12345678901234567890<br><br><a href='javascript:history.back();'>[Go Back]</a></body></html>";

const F5_QUOTED = page(
  "<title>BIG-IP ASM: The requested URL was rejected</title>",
  "<h1>Troubleshooting ASM blocks</h1><p>Users see this text:</p><pre><code>The requested URL was rejected. Please consult with your administrator.\nYour support ID is: 12345678901234567890</code></pre>" +
    ARTICLE,
);

// ------------------------------------------------------------------- Vercel

const VERCEL_CHECKPOINT = page(
  "<title>Vercel Security Checkpoint</title><meta charset=utf-8>",
  '<div><h1>We\'re verifying your browser</h1><p>Website owner? <a href="https://vercel.link/security-checkpoint">Click here to fix</a></p></div><script src="/.well-known/vercel/security/static/challenge.v2.min.js"></script>',
);

const VERCEL_BLOG = page(
  "<title>What is the Vercel Security Checkpoint?</title>",
  "<h1>What is the Vercel Security Checkpoint?</h1><p>The Vercel Security Checkpoint is a page that verifies your browser.</p>" +
    ARTICLE,
);

// ---------------------------------------------------------------- Wordfence

const WORDFENCE_BLOCK =
  '<!DOCTYPE html><html><head><title>Your access to this site has been limited</title><meta charset="UTF-8"></head><body><div class="wf-block"><h1>Your access to this site has been limited by the site owner</h1><p>Your access to this service has been limited. (HTTP response code 503)</p><p>If you think you have been blocked in error, contact the owner of this site for assistance.</p><p>Block reason: Blocked by the Wordfence Application Firewall</p></div><p>Generated by Wordfence at Thu, 29 Oct 2026 02:31:46 GMT.<br>Your computer\'s time: <script>document.write(new Date().toUTCString());</script>.</p></body></html>';

const WORDFENCE_ARTICLE = page(
  "<title>Your access to this site has been limited: what it means</title>",
  "<h1>Your access to this site has been limited: what it means</h1><p>Wordfence shows this heading when a firewall rule fires.</p>" +
    ARTICLE,
);

// A site's own 403 that copies Wordfence's wording but none of its markup (#1258).
const WORDFENCE_WORDING_ONLY =
  '<!DOCTYPE html><html><head><title>Your access to this site has been limited</title></head><body><h1>Your access to this site has been limited by the site owner</h1><p>If you think you have been blocked in error, contact the owner of this site.</p><p>Generated by Wordfence.</p></body></html>';

// Real-shaped variants: the footer timestamp without the script, and the script without the timestamp.
const WORDFENCE_NO_SCRIPT =
  '<!DOCTYPE html><html><head><title>Your access to this site has been limited</title></head><body><h1>Your access to this site has been limited by the site owner</h1><p>Block reason: Blocked by the Wordfence Application Firewall</p><p>Generated by Wordfence at Thu, 29 Oct 2026 02:31:46 GMT.</p></body></html>';
const WORDFENCE_NO_TIMESTAMP =
  '<!DOCTYPE html><html><head><title>Your access to this site has been limited</title></head><body><h1>Your access to this site has been limited by the site owner</h1><p>Generated by Wordfence.<br>Your computer\'s time: <script>document.write(new Date().toUTCString());</script>.</p></body></html>';

// ------------------------------------------------------------------ Radware

const RADWARE_CAPTCHA =
  '<html><head><title>Radware Bot Manager</title></head><body><h1>Human verification</h1><iframe src="https://validate.perfdrive.com/captcha?ssa=TEST" width="400" height="300"></iframe></body></html>';

const RADWARE_LOOKALIKE =
  '<html><body><h1>Human verification</h1><iframe src="https://validate.perfdrive.com.attacker.example/captcha"></iframe></body></html>';

const NO_HEADERS = {};

export const BLOCKED: BlockedSample[] = [
  {
    name: "Cloudflare managed challenge (403)",
    how: "live",
    provider: "cloudflare",
    signal: "cf-mitigated",
    status: 403,
    headers: { "cf-mitigated": "challenge", server: "cloudflare" },
    html: CF_MANAGED_CHALLENGE,
  },
  {
    name: "Cloudflare managed challenge, no header",
    how: "live",
    provider: "cloudflare",
    signal: "challenge",
    status: 403,
    headers: { server: "cloudflare" },
    html: CF_MANAGED_CHALLENGE,
  },
  {
    name: "Cloudflare managed challenge (503)",
    how: "reports",
    provider: "cloudflare",
    signal: "challenge",
    status: 503,
    headers: { server: "cloudflare" },
    html: CF_MANAGED_CHALLENGE,
  },
  {
    name: "Cloudflare challenge known only by header",
    how: "live",
    provider: "cloudflare",
    signal: "cf-mitigated",
    status: 403,
    headers: { "cf-mitigated": "challenge" },
    html: CF_HEADER_ONLY,
  },
  {
    name: "Cloudflare block page (403)",
    how: "live",
    provider: "cloudflare",
    signal: "Attention Required",
    status: 403,
    headers: { server: "cloudflare" },
    html: CF_BLOCK_PAGE,
  },
  {
    name: "Cloudflare block page (429)",
    how: "reports",
    provider: "cloudflare",
    signal: "Attention Required",
    status: 429,
    headers: { server: "cloudflare" },
    html: CF_BLOCK_PAGE,
  },
  {
    name: "Akamai deny page (403)",
    how: "live",
    provider: "akamai",
    signal: "Akamai",
    status: 403,
    headers: { server: "AkamaiGHost" },
    html: akamaiDeny(AKAMAI_REF),
  },
  {
    name: "Akamai deny page served as 200",
    how: "live",
    provider: "akamai",
    signal: "Akamai",
    status: 200,
    headers: NO_HEADERS,
    html: akamaiDeny(AKAMAI_REF),
  },
  {
    name: "Akamai deny page (503)",
    how: "reports",
    provider: "akamai",
    signal: "Akamai",
    status: 503,
    headers: NO_HEADERS,
    html: akamaiDeny(AKAMAI_REF),
  },
  {
    name: "DataDome challenge (403)",
    how: "live",
    provider: "datadome",
    signal: "DataDome",
    status: 403,
    headers: { "x-datadome": "protected", "x-dd-b": "1" },
    html: datadome("c"),
  },
  {
    name: "DataDome interstitial (403, rt=i)",
    how: "live",
    provider: "datadome",
    signal: "DataDome",
    status: 403,
    headers: { "x-datadome": "protected" },
    html: datadome("i"),
  },
  {
    name: "DataDome challenge served as 200",
    how: "reports",
    provider: "datadome",
    signal: "DataDome",
    status: 200,
    headers: NO_HEADERS,
    html: datadome("c"),
  },
  {
    name: "DataDome challenge served as 202",
    how: "recalled",
    provider: "datadome",
    signal: "DataDome",
    status: 202,
    headers: NO_HEADERS,
    html: datadome("c"),
  },
  {
    name: "DataDome challenge (405)",
    how: "recalled",
    provider: "datadome",
    signal: "DataDome",
    status: 405,
    headers: NO_HEADERS,
    html: datadome("c"),
  },
  {
    name: "Kasada challenge (429)",
    how: "live",
    provider: "kasada",
    signal: "Kasada",
    status: 429,
    headers: { "x-kpsdk-r": "1-AA" },
    html: KASADA_CHALLENGE,
  },
  {
    name: "Kasada challenge (403)",
    how: "reports",
    provider: "kasada",
    signal: "Kasada",
    status: 403,
    headers: NO_HEADERS,
    html: KASADA_CHALLENGE,
  },
  {
    name: "HUMAN block page (403)",
    how: "live",
    provider: "perimeterx",
    signal: "x-px-blocked",
    status: 403,
    headers: { "x-px-blocked": "1" },
    html: PX_BLOCK,
  },
  {
    name: "HUMAN block page, no header",
    how: "live",
    provider: "perimeterx",
    signal: "HUMAN",
    status: 403,
    headers: NO_HEADERS,
    html: PX_BLOCK,
  },
  {
    name: "HUMAN block known only by header",
    how: "live",
    provider: "perimeterx",
    signal: "x-px-blocked",
    status: 403,
    headers: { "x-px-blocked": "1" },
    html: null,
  },
  {
    name: "HUMAN branded challenge through Cloudflare (403)",
    how: "live",
    provider: "perimeterx",
    signal: "captcha element",
    status: 403,
    headers: { server: "cloudflare", "cf-ray": "0-SYD" },
    html: PX_BRANDED,
  },
  {
    name: "Cloudflare challenge (429, cf-mitigated)",
    how: "live",
    provider: "cloudflare",
    signal: "cf-mitigated",
    status: 429,
    headers: { "cf-mitigated": "challenge", server: "cloudflare" },
    html: CF_MANAGED_CHALLENGE,
  },
  {
    name: "HUMAN block page served as 200",
    how: "reports",
    provider: "perimeterx",
    signal: "HUMAN",
    status: 200,
    headers: NO_HEADERS,
    html: PX_BLOCK,
  },
  {
    name: "Imperva block page (403)",
    how: "reports",
    provider: "imperva",
    signal: "incident id",
    status: 403,
    headers: { "x-iinfo": "1-1-1" },
    html: IMPERVA_BLOCK,
  },
  {
    name: "Imperva block page served as 200",
    how: "reports",
    provider: "imperva",
    signal: "incident id",
    status: 200,
    headers: NO_HEADERS,
    html: IMPERVA_BLOCK,
  },
  {
    name: "Imperva Pardon Our Interruption",
    how: "reports",
    provider: "imperva",
    signal: "Pardon",
    status: 200,
    headers: NO_HEADERS,
    html: IMPERVA_PARDON,
  },
  {
    name: "Imperva JavaScript challenge page (403)",
    how: "recalled",
    provider: "imperva",
    signal: "JavaScript challenge",
    status: 403,
    headers: NO_HEADERS,
    html: IMPERVA_JS_CHALLENGE,
  },
  {
    name: "Sucuri firewall block (403)",
    how: "reports",
    provider: "sucuri",
    signal: "Sucuri",
    status: 403,
    headers: { server: "Sucuri/Cloudproxy" },
    html: SUCURI_BLOCK,
  },
  {
    name: "AWS WAF challenge (202, header, empty body)",
    how: "docs",
    provider: "aws-waf",
    signal: "x-amzn-waf-action",
    status: 202,
    headers: { "x-amzn-waf-action": "challenge" },
    html: "",
  },
  {
    name: "AWS WAF CAPTCHA (405, header)",
    how: "docs",
    provider: "aws-waf",
    signal: "x-amzn-waf-action",
    status: 405,
    headers: { "x-amzn-waf-action": "captcha" },
    html: null,
  },
  {
    name: "AWS WAF challenge interstitial (202, script)",
    how: "docs",
    provider: "aws-waf",
    signal: "AWS WAF",
    status: 202,
    headers: NO_HEADERS,
    html: AWS_CHALLENGE_PAGE,
  },
  {
    name: "AWS WAF CAPTCHA interstitial (405, script)",
    how: "docs",
    provider: "aws-waf",
    signal: "AWS WAF",
    status: 405,
    headers: NO_HEADERS,
    html: AWS_CHALLENGE_PAGE,
  },
  {
    name: "F5 rejection page (200)",
    how: "reports",
    provider: "f5",
    signal: "F5",
    status: 200,
    headers: NO_HEADERS,
    html: F5_REJECT,
  },
  {
    name: "F5 rejection page (403)",
    how: "reports",
    provider: "f5",
    signal: "F5",
    status: 403,
    headers: NO_HEADERS,
    html: F5_REJECT,
  },
  {
    name: "Vercel challenge (403, header)",
    how: "live",
    provider: "vercel",
    signal: "x-vercel-mitigated",
    status: 403,
    headers: { "x-vercel-mitigated": "challenge" },
    html: VERCEL_CHECKPOINT,
  },
  {
    name: "Vercel Security Checkpoint (429)",
    how: "live",
    provider: "vercel",
    signal: "Checkpoint",
    status: 429,
    headers: NO_HEADERS,
    html: VERCEL_CHECKPOINT,
  },
  {
    name: "Wordfence block (503)",
    how: "reports",
    provider: "wordfence",
    signal: "Wordfence",
    status: 503,
    headers: NO_HEADERS,
    html: WORDFENCE_BLOCK,
  },
  {
    name: "Wordfence block (403)",
    how: "reports",
    provider: "wordfence",
    signal: "Wordfence",
    status: 403,
    headers: NO_HEADERS,
    html: WORDFENCE_BLOCK,
  },
  {
    name: "Wordfence block with the timestamp and no script (403)",
    how: "reports",
    provider: "wordfence",
    signal: "Wordfence",
    status: 403,
    headers: NO_HEADERS,
    html: WORDFENCE_NO_SCRIPT,
  },
  {
    name: "Wordfence block with the script and no timestamp (403)",
    how: "reports",
    provider: "wordfence",
    signal: "Wordfence",
    status: 403,
    headers: NO_HEADERS,
    html: WORDFENCE_NO_TIMESTAMP,
  },
  {
    name: "Radware captcha host (403)",
    how: "recalled",
    provider: "radware",
    signal: "Radware",
    status: 403,
    headers: NO_HEADERS,
    html: RADWARE_CAPTCHA,
  },
];

export interface NearMiss extends Sample {
  provider: WafBlockProvider | "none";
}

/** Responses that must never read as blocked. Each carries its provider's headers where it would. */
export const NEAR_MISSES: NearMiss[] = [
  {
    name: "Cloudflare page with JavaScript Detections",
    how: "constructed",
    provider: "cloudflare",
    status: 200,
    headers: { server: "cloudflare", "cf-ray": "0-SYD" },
    html: CF_JSD_PAGE,
  },
  {
    name: "Cloudflare origin error 522",
    how: "constructed",
    provider: "cloudflare",
    status: 522,
    headers: { server: "cloudflare" },
    html: CF_ORIGIN_ERROR,
  },
  {
    name: "Cloudflare origin 403 on a short body",
    how: "constructed",
    provider: "cloudflare",
    status: 403,
    headers: { server: "cloudflare" },
    html: "<html><body><h1>Forbidden</h1></body></html>",
  },
  {
    name: "Turnstile widget on a contact form",
    how: "constructed",
    provider: "cloudflare",
    status: 200,
    headers: { server: "cloudflare", "cf-cache-status": "DYNAMIC" },
    html: TURNSTILE_FORM,
  },
  {
    name: "Akamai origin 403 without a reference number",
    how: "constructed",
    provider: "akamai",
    status: 403,
    headers: { server: "AkamaiGHost" },
    html: AKAMAI_ORIGIN_403,
  },
  {
    name: "Article quoting an Akamai reference in a code block",
    how: "constructed",
    provider: "akamai",
    status: 200,
    headers: { server: "AkamaiGHost" },
    html: AKAMAI_SUPPORT_ARTICLE,
  },
  {
    name: "Page loading the DataDome tag",
    how: "constructed",
    provider: "datadome",
    status: 200,
    headers: { "x-datadome": "protected" },
    html: DATADOME_TAG_PAGE,
  },
  {
    name: "Look-alike captcha host on a small page",
    how: "constructed",
    provider: "datadome",
    status: 403,
    headers: NO_HEADERS,
    html: DATADOME_LOOKALIKE,
  },
  {
    name: "Long article that embeds the captcha script",
    how: "constructed",
    provider: "datadome",
    status: 200,
    headers: NO_HEADERS,
    html: DATADOME_QUOTED_ON_LONG_PAGE,
  },
  {
    name: "Sparse app shell that loads the Kasada script (200)",
    how: "constructed",
    provider: "kasada",
    status: 200,
    headers: NO_HEADERS,
    html: KASADA_SPARSE_SHELL,
  },
  {
    name: "Page with the HUMAN sensor snippet",
    how: "constructed",
    provider: "perimeterx",
    status: 200,
    headers: NO_HEADERS,
    html: PX_SENSOR_PAGE,
  },
  {
    name: "Article titled like the HUMAN block page",
    how: "constructed",
    provider: "perimeterx",
    status: 200,
    headers: NO_HEADERS,
    html: PX_QUOTED,
  },
  {
    name: "Content page that also loads the Imperva script",
    how: "constructed",
    provider: "imperva",
    status: 200,
    headers: { "x-iinfo": "1-1-1" },
    html: IMPERVA_NORMAL_PAGE,
  },
  {
    name: "Article quoting an Imperva incident line",
    how: "constructed",
    provider: "imperva",
    status: 200,
    headers: NO_HEADERS,
    html: IMPERVA_QUOTED,
  },
  {
    name: "Article about the Sucuri firewall",
    how: "constructed",
    provider: "sucuri",
    status: 200,
    headers: { "x-sucuri-id": "12345" },
    html: SUCURI_MENTION,
  },
  {
    name: "Page using the AWS WAF JavaScript SDK",
    how: "constructed",
    provider: "aws-waf",
    status: 200,
    headers: { "x-amz-cf-id": "TEST" },
    html: AWS_SDK_PAGE,
  },
  {
    name: "Look-alike AWS WAF token host on a 202",
    how: "constructed",
    provider: "aws-waf",
    status: 202,
    headers: NO_HEADERS,
    html: AWS_LOOKALIKE,
  },
  {
    name: "Ordinary 202 from an API gateway",
    how: "constructed",
    provider: "aws-waf",
    status: 202,
    headers: { "x-amzn-requestid": "TEST" },
    html: "",
  },
  {
    name: "Article quoting the F5 rejection text",
    how: "constructed",
    provider: "f5",
    status: 200,
    headers: NO_HEADERS,
    html: F5_QUOTED,
  },
  {
    name: "Article about the Vercel Security Checkpoint",
    how: "constructed",
    provider: "vercel",
    status: 200,
    headers: { "x-vercel-id": "sfo1::TEST" },
    html: VERCEL_BLOG,
  },
  {
    name: "Article reusing the Wordfence heading",
    how: "constructed",
    provider: "wordfence",
    status: 200,
    headers: NO_HEADERS,
    html: WORDFENCE_ARTICLE,
  },
  {
    name: "403 that copies Wordfence's wording without its markup",
    how: "constructed",
    provider: "wordfence",
    status: 403,
    headers: NO_HEADERS,
    html: WORDFENCE_WORDING_ONLY,
  },
  {
    name: "Look-alike Radware host on a small page",
    how: "constructed",
    provider: "radware",
    status: 403,
    headers: NO_HEADERS,
    html: RADWARE_LOOKALIKE,
  },
  {
    name: "Content page behind Akamai (200)",
    how: "constructed",
    provider: "akamai",
    status: 200,
    headers: { "x-akamai-request-id": "0.1" },
    html: page("<title>Home</title>", ARTICLE),
  },
  {
    name: "Content page behind DataDome (200, header)",
    how: "constructed",
    provider: "datadome",
    status: 200,
    headers: { "x-datadome": "protected", "x-dd-b": "1" },
    html: page("<title>Home</title>", ARTICLE),
  },
  {
    name: "Vercel BotID page that bundles the Kasada client (200)",
    how: "constructed",
    provider: "kasada",
    status: 200,
    headers: { server: "Vercel", "x-vercel-id": "sfo1::TEST" },
    html: page(
      "<title>Projects</title>",
      ARTICLE +
        "<script>if(!window.KPSDK)throw Error('KPSDK is not loaded');KPSDK.configure([])</script>",
    ),
  },
  {
    name: "Content page behind Sucuri (200)",
    how: "constructed",
    provider: "sucuri",
    status: 200,
    headers: { server: "Sucuri/Cloudproxy", "x-sucuri-id": "12345", "x-sucuri-cache": "MISS" },
    html: page("<title>Home</title>", ARTICLE),
  },
  {
    name: "Empty 200 behind Vercel",
    how: "constructed",
    provider: "none",
    status: 200,
    headers: { server: "Vercel", "x-vercel-id": "sfo1::TEST" },
    html: "",
  },
  {
    name: "Real page with a HUMAN captcha mount point (200)",
    how: "constructed",
    provider: "perimeterx",
    status: 200,
    headers: {},
    html: page(
      "<title>Contact</title>",
      ARTICLE +
        '<form action="/send"><input name="email"><div id="px-captcha"></div><button>Send</button></form><script>window._pxAppId="PXtest0000";window._pxOnCaptchaSuccess=function(){}</script>',
    ),
  },
  {
    name: "Imperva-fronted app shell with the Imperva script (200)",
    how: "constructed",
    provider: "imperva",
    status: 200,
    headers: { "x-iinfo": "1-1-1" },
    html: '<!doctype html><html><head><title></title><script src="/_Incapsula_Resource?SWJIYLWA=00000000000000000000000000000000"></script></head><body><div id=root></div></body></html>',
  },
  {
    name: "Script-only page with the Imperva script (200)",
    how: "constructed",
    provider: "imperva",
    status: 200,
    headers: {},
    html: IMPERVA_JS_CHALLENGE,
  },
  {
    name: "Radware captcha host on a near-empty 200 page",
    how: "constructed",
    provider: "radware",
    status: 200,
    headers: {},
    html: RADWARE_CAPTCHA,
  },
  {
    name: "Origin 403 with only a captcha mount point",
    how: "constructed",
    provider: "perimeterx",
    status: 403,
    headers: {},
    html: '<html><body><h1>Forbidden</h1><div id="px-captcha"></div></body></html>',
  },
  {
    name: "Article showing the HUMAN mount point as a code sample",
    how: "constructed",
    provider: "perimeterx",
    status: 403,
    headers: {},
    html: page(
      "<title>Docs</title>",
      '<p>Add the mount point:</p><pre><code>&lt;div id="px-captcha"&gt;&lt;/div&gt; _pxAppId _pxOnCaptchaSuccess</code></pre>',
    ),
  },
  {
    name: "x-px-blocked on a 200 page",
    how: "constructed",
    provider: "perimeterx",
    status: 200,
    headers: { "x-px-blocked": "1" },
    html: page("<title>Home</title>", ARTICLE),
  },
  {
    name: "Small 200 page titled Vercel Security Checkpoint",
    how: "constructed",
    provider: "vercel",
    status: 200,
    headers: {},
    html: VERCEL_CHECKPOINT,
  },
  {
    name: "Plain content page",
    how: "constructed",
    provider: "none",
    status: 200,
    headers: NO_HEADERS,
    html: page("<title>Article</title>", ARTICLE),
  },
];
