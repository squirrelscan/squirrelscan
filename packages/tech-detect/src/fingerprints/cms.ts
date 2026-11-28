import type { TechFingerprint } from "../types";

import { scriptSrc } from "./helpers";

export const CMS_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "wordpress",
    name: "WordPress",
    category: "cms",
    website: "https://wordpress.org",
    icon: "wordpress",
    detectors: [
      { type: "meta", name: "generator", pattern: /WordPress/i },
      ...scriptSrc(
        String.raw`(?:https?:)?\/\/stats\.wp\.com\/(?:w|e-\d+)\.js(?![\w.-])`
      ),
      { type: "html", pattern: /wp-content\/themes\//i },
      { type: "html", pattern: /wp-content\/plugins\//i },
      { type: "url-path", pattern: /\/wp-json\//i },
      { type: "header", name: "x-powered-by", pattern: /WordPress/i },
      { type: "script-url", pattern: /wp-includes\/js\//i },
    ],
    versionPattern: /WordPress\s*([\d.]+)/i,
  },
  {
    id: "shopify",
    name: "Shopify",
    category: "cms",
    website: "https://shopify.com",
    icon: "shopify",
    detectors: [
      { type: "meta", name: "generator", pattern: /Shopify/i },
      { type: "html", pattern: /cdn\.shopify\.com/i },
      { type: "script-url", pattern: /cdn\.shopify\.com/i },
      { type: "header", name: "x-shopify-stage", pattern: /.+/ },
      { type: "html", pattern: /Shopify\.theme/i },
    ],
  },
  {
    id: "wix",
    name: "Wix",
    category: "cms",
    website: "https://wix.com",
    icon: "wix",
    detectors: [
      { type: "meta", name: "generator", pattern: /Wix/i },
      { type: "html", pattern: /static\.wixstatic\.com/i },
      { type: "html", pattern: /wix-code-sdk/i },
      { type: "script-url", pattern: /static\.parastorage\.com/i },
    ],
  },
  {
    id: "squarespace",
    name: "Squarespace",
    category: "cms",
    website: "https://squarespace.com",
    icon: "squarespace",
    detectors: [
      { type: "meta", name: "generator", pattern: /Squarespace/i },
      { type: "html", pattern: /static1\.squarespace\.com/i },
      ...scriptSrc(
        String.raw`(?:https?:)?\/\/(?:definitions\.sqspcdn\.com|assets\.squarespace\.com)\/`
      ),
      { type: "html", pattern: /sqsp-/i },
      { type: "header", name: "server", pattern: /Squarespace/i },
    ],
    versionPattern: /Squarespace\s*([\d.]+)/i,
  },
  {
    id: "webflow",
    name: "Webflow",
    category: "cms",
    website: "https://webflow.com",
    icon: "webflow",
    detectors: [
      { type: "meta", name: "generator", pattern: /Webflow/i },
      { type: "html", pattern: /assets\.website-files\.com/i },
      { type: "html", pattern: /data-wf-site/i },
      { type: "script-url", pattern: /webflow\.js/i },
      ...scriptSrc(
        String.raw`(?:https?:)?\/\/cdn\.prod\.website-files\.com\/[0-9a-f]{24}\/js\/`
      ),
    ],
  },
  {
    id: "drupal",
    name: "Drupal",
    category: "cms",
    website: "https://drupal.org",
    icon: "drupal",
    detectors: [
      { type: "meta", name: "generator", pattern: /Drupal/i },
      { type: "html", pattern: /\/sites\/default\/files\//i },
      { type: "header", name: "x-drupal-cache", pattern: /.+/ },
      { type: "header", name: "x-generator", pattern: /Drupal/i },
      { type: "html", pattern: /drupal\.js/i },
    ],
    versionPattern: /Drupal\s*([\d.]+)/i,
  },
  {
    id: "ghost",
    name: "Ghost",
    category: "cms",
    website: "https://ghost.org",
    icon: "ghost",
    detectors: [
      { type: "meta", name: "generator", pattern: /Ghost/i },
      { type: "html", pattern: /ghost-(?:url|api)/i },
      { type: "header", name: "x-ghost-cache-status", pattern: /.+/ },
    ],
    versionPattern: /Ghost\s*([\d.]+)/i,
  },
  {
    id: "joomla",
    name: "Joomla",
    category: "cms",
    website: "https://joomla.org",
    icon: "joomla",
    detectors: [
      { type: "meta", name: "generator", pattern: /Joomla/i },
      { type: "html", pattern: /\/media\/jui\//i },
      { type: "html", pattern: /\/components\/com_/i },
    ],
    versionPattern: /Joomla!\s*([\d.]+)/i,
  },
  {
    id: "contentful",
    name: "Contentful",
    category: "cms",
    website: "https://contentful.com",
    icon: "contentful",
    detectors: [
      // A script URL or package name (`cdn.contentful.com`, `contentful.js`, `/contentful@`), not the word.
      {
        type: "script-url",
        pattern: /(?:^|[/@.])contentful(?:\.(?:com|net)\b|[-.@/]|\.min\.js)/i,
      },
      { type: "html", pattern: /ctfassets\.net/i },
      { type: "html", pattern: /images\.ctfassets\.net/i },
    ],
  },
  {
    id: "hubspot-cms",
    name: "HubSpot CMS",
    category: "cms",
    website: "https://hubspot.com",
    icon: "hubspot",
    detectors: [
      { type: "meta", name: "generator", pattern: /HubSpot/i },
      ...scriptSrc(
        String.raw`(?:https?:)?\/\/js(?:-[a-z0-9]{2,6})?\.hs-scripts\.com\/`
      ),
      { type: "html", pattern: /hs-script-loader/i },
    ],
  },
];
