import type { Detector, TechFingerprint } from "../types";
import { inScript, resourceAttr, scriptSrc } from "./helpers";

// Stack fingerprints for logged-out audits (#1263): CMS and shop systems, tag
// managers, consent tools and CDNs a site is routed by. First-party research only:
// every signal below is a host, path, header or marker that product's own
// documentation or page output names. No third-party catalog or signature file was
// read or copied.
//
// Each needs real markup context (a script tag, a resource attribute, an inline
// script, a `<meta>` value or a response header), so a page that only talks about
// the product, or shows its snippet in a code sample, does not match.

/** An asset under `wp-content/plugins/<slug>/`, as a script URL or a link, img or source attribute. */
function wpPlugin(slug: string): Detector[] {
  const url = String.raw`(?:(?:https?:)?\/\/[^\/"'\s]{1,200})?\/(?:[^"'\s?#]{0,200}\/)?wp-content\/plugins\/${slug}\/`;
  return [...scriptSrc(url), resourceAttr("link|img|source", "href|src|srcset|data-src", url)];
}

export const STACK_FINGERPRINTS: TechFingerprint[] = [
  // Consent tools.
  {
    id: "borlabs-cookie",
    name: "Borlabs Cookie",
    category: "security",
    website: "https://borlabs.io",
    icon: "borlabs-cookie",
    detectors: [
      ...wpPlugin("borlabs-cookie"),
      inScript(String.raw`(?:window\.)?borlabsCookieConfig\s*=`, "borlabsCookieConfig"),
      {
        type: "html",
        requires: "data-borlabs-cookie-",
        pattern: /<(?:script|iframe|div)\s(?:[^>]{0,400}\s)?data-borlabs-cookie-[a-z-]{1,40}\s*=/i,
      },
    ],
    confidence: "high",
  },
  {
    id: "complianz",
    name: "Complianz",
    category: "security",
    website: "https://complianz.io",
    icon: "complianz",
    detectors: [
      ...wpPlugin(String.raw`complianz-gdpr(?:-premium)?`),
      {
        type: "html",
        requires: "cmplz-cookiebanner",
        pattern:
          /<div\s(?:[^>]{0,400}\s)?class\s*=\s*["'](?:[^"']{0,200}\s)?cmplz-cookiebanner[\s"']/i,
      },
    ],
    confidence: "high",
  },
  {
    id: "real-cookie-banner",
    name: "Real Cookie Banner",
    category: "security",
    website: "https://devowl.io/wordpress-real-cookie-banner/",
    icon: "real-cookie-banner",
    detectors: [...wpPlugin(String.raw`real-cookie-banner(?:-pro)?`)],
    confidence: "high",
  },
  {
    id: "cookie-notice",
    name: "Cookie Notice",
    category: "security",
    website: "https://wordpress.org/plugins/cookie-notice/",
    icon: "cookie-notice",
    detectors: [...wpPlugin("cookie-notice")],
    confidence: "high",
  },
  {
    id: "consentmanager",
    name: "consentmanager",
    category: "security",
    website: "https://www.consentmanager.net",
    icon: "consentmanager",
    detectors: [
      ...scriptSrc(String.raw`(?:https:)?\/\/(?:cdn|delivery)\.consentmanager\.net\/`),
      ...scriptSrc(String.raw`(?:https:)?\/\/[a-z0-9-]{1,63}\.delivery\.consentmanager\.net\/`),
    ],
    confidence: "high",
  },
  {
    id: "klaro",
    name: "Klaro",
    category: "security",
    website: "https://klaro.org",
    icon: "klaro",
    detectors: [
      inScript(String.raw`(?:var\s+|window\.)klaroConfig\s*=`, "klaroConfig"),
      ...scriptSrc(
        String.raw`[^"']{0,200}\/klaro(?:-no-css|-no-translations)?(?:\.min)?\.js(?:[?#][^"']{0,100})?`,
      ),
    ],
    confidence: "high",
  },
  {
    id: "axeptio",
    name: "Axeptio",
    category: "security",
    website: "https://www.axept.io",
    icon: "axeptio",
    detectors: [
      ...scriptSrc(String.raw`(?:https:)?\/\/static\.axept\.io\/`),
      inScript(String.raw`window\.axeptioSettings\s*=`, "axeptioSettings"),
    ],
    confidence: "high",
  },
  {
    id: "cookiefirst",
    name: "CookieFirst",
    category: "security",
    website: "https://cookiefirst.com",
    icon: "cookiefirst",
    detectors: [...scriptSrc(String.raw`(?:https:)?\/\/consent\.cookiefirst\.com\/`)],
    confidence: "high",
  },
  {
    id: "cookie-information",
    name: "Cookie Information",
    category: "security",
    website: "https://cookieinformation.com",
    icon: "cookie-information",
    detectors: [
      ...scriptSrc(String.raw`(?:https:)?\/\/policy\.app\.cookieinformation\.com\/`),
      ...scriptSrc(String.raw`(?:https:)?\/\/cdn\.cookieinformation\.com\/`),
    ],
    confidence: "high",
  },
  {
    id: "cookie-script",
    name: "Cookie-Script",
    category: "security",
    website: "https://cookie-script.com",
    icon: "cookie-script",
    detectors: [...scriptSrc(String.raw`(?:https:)?\/\/cdn\.cookie-script\.com\/`)],
    confidence: "high",
  },

  // Tag managers.
  {
    id: "cloudflare-zaraz",
    name: "Cloudflare Zaraz",
    category: "tag-manager",
    website: "https://developers.cloudflare.com/zaraz/",
    icon: "cloudflare-zaraz",
    detectors: [
      ...scriptSrc(String.raw`[^"']{0,200}\/cdn-cgi\/zaraz\/`),
      inScript(String.raw`(?:window\.)?zarazData\s*=`, "zarazData"),
    ],
    confidence: "high",
  },
  {
    id: "matomo-tag-manager",
    name: "Matomo Tag Manager",
    category: "tag-manager",
    website: "https://matomo.org/tag-manager/",
    icon: "matomo-tag-manager",
    detectors: [
      ...scriptSrc(
        String.raw`(?:https:)?\/\/cdn\.matomo\.cloud\/[A-Za-z0-9._-]{1,100}\/container_[A-Za-z0-9]{4,40}\.js`,
      ),
      inScript(
        String.raw`(?:var\s+)?_mtm\s*=\s*window\._mtm\s*=\s*window\._mtm\s*\|\|\s*\[\]`,
        "_mtm",
      ),
    ],
    confidence: "high",
  },
  {
    id: "piwik-pro-tag-manager",
    name: "Piwik PRO Tag Manager",
    category: "tag-manager",
    website: "https://piwik.pro/tag-manager/",
    icon: "piwik-pro-tag-manager",
    detectors: [
      // The container script is a UUID-named file on the account's own Piwik PRO host.
      ...scriptSrc(
        String.raw`(?:https:)?\/\/[a-z0-9-]{1,63}\.containers\.piwik\.pro\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.js`,
      ),
    ],
    confidence: "high",
  },
  {
    id: "commanders-act",
    name: "Commanders Act",
    category: "tag-manager",
    website: "https://www.commandersact.com",
    icon: "commanders-act",
    detectors: [...scriptSrc(String.raw`(?:https:)?\/\/cdn\.(?:tagcommander|commander1)\.com\/`)],
    confidence: "high",
  },

  // Shop systems and CMS.
  {
    id: "lightspeed-ecom",
    name: "Lightspeed eCom",
    category: "cms",
    website: "https://www.lightspeedhq.com/ecommerce/",
    icon: "lightspeed-ecom",
    detectors: [
      resourceAttr(
        "link|script|img|source",
        "href|src|srcset|data-src",
        String.raw`(?:https:)?\/\/(?:cdn\.webshopapp\.com|[a-z0-9-]{1,63}\.shoplightspeed\.com)\/`,
      ),
    ],
    confidence: "high",
  },
  {
    id: "contao",
    name: "Contao",
    category: "cms",
    website: "https://contao.org",
    icon: "contao",
    detectors: [{ type: "meta", name: "generator", pattern: /^Contao Open Source CMS/i }],
    confidence: "high",
  },
  {
    id: "silverstripe",
    name: "SilverStripe",
    category: "cms",
    website: "https://www.silverstripe.org",
    icon: "silverstripe",
    detectors: [{ type: "meta", name: "generator", pattern: /^SilverStripe\b/i }],
    confidence: "high",
  },
  {
    id: "plone",
    name: "Plone",
    category: "cms",
    website: "https://plone.org",
    icon: "plone",
    detectors: [{ type: "meta", name: "generator", pattern: /^Plone\b/i }],
    confidence: "high",
  },
  {
    id: "grav",
    name: "Grav",
    category: "cms",
    website: "https://getgrav.org",
    icon: "grav",
    detectors: [{ type: "meta", name: "generator", pattern: /^GravCMS\b/i }],
    confidence: "high",
  },
  {
    id: "odoo",
    name: "Odoo",
    category: "cms",
    website: "https://www.odoo.com",
    icon: "odoo",
    detectors: [{ type: "meta", name: "generator", pattern: /^Odoo\b/i }],
    confidence: "high",
  },
  {
    id: "liferay",
    name: "Liferay",
    category: "cms",
    website: "https://www.liferay.com",
    icon: "liferay",
    detectors: [{ type: "header", name: "liferay-portal", pattern: /.+/ }],
    confidence: "high",
  },
  {
    id: "pimcore",
    name: "Pimcore",
    category: "cms",
    website: "https://pimcore.com",
    icon: "pimcore",
    detectors: [{ type: "header", name: "x-powered-by", pattern: /^pimcore\b/i }],
    confidence: "high",
  },

  // CDNs.
  {
    id: "azure-front-door",
    name: "Azure Front Door",
    category: "cdn",
    website: "https://azure.microsoft.com/products/frontdoor",
    icon: "azure-front-door",
    detectors: [{ type: "header", name: "x-azure-ref", pattern: /.+/ }],
    confidence: "high",
  },
  {
    id: "google-cloud-cdn",
    name: "Google Cloud CDN",
    category: "cdn",
    website: "https://cloud.google.com/cdn",
    icon: "google-cloud-cdn",
    detectors: [{ type: "header", name: "via", pattern: /^1\.1 google$/i }],
    confidence: "medium",
  },
];
