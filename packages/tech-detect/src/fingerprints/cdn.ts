import type { TechFingerprint } from "../types";

export const CDN_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "cloudflare-cdn",
    name: "Cloudflare",
    category: "cdn",
    website: "https://cloudflare.com",
    icon: "cloudflare",
    detectors: [
      { type: "header", name: "cf-ray", pattern: /.+/ },
      { type: "header", name: "server", pattern: /cloudflare/i },
      { type: "header", name: "cf-cache-status", pattern: /.+/ },
    ],
  },
  {
    id: "cloudfront",
    name: "Amazon CloudFront",
    category: "cdn",
    website: "https://aws.amazon.com/cloudfront",
    icon: "aws",
    detectors: [
      { type: "header", name: "x-amz-cf-id", pattern: /.+/ },
      { type: "header", name: "x-amz-cf-pop", pattern: /.+/ },
      { type: "header", name: "via", pattern: /cloudfront/i },
      { type: "html", pattern: /cloudfront\.net/i },
    ],
  },
  {
    id: "fastly",
    name: "Fastly",
    category: "cdn",
    website: "https://fastly.com",
    icon: "fastly",
    detectors: [
      { type: "header", name: "x-served-by", pattern: /cache-/i },
      { type: "header", name: "x-fastly-request-id", pattern: /.+/ },
      { type: "header", name: "via", pattern: /varnish/i },
    ],
    confidence: "medium",
  },
  {
    id: "akamai-cdn",
    name: "Akamai",
    category: "cdn",
    website: "https://akamai.com",
    icon: "akamai",
    detectors: [
      { type: "header", name: "x-akamai-transformed", pattern: /.+/ },
      { type: "header", name: "server", pattern: /AkamaiGHost/i },
    ],
  },
  {
    id: "vercel-edge",
    name: "Vercel Edge Network",
    category: "cdn",
    website: "https://vercel.com",
    icon: "vercel",
    detectors: [
      { type: "header", name: "x-vercel-cache", pattern: /.+/ },
      { type: "header", name: "x-vercel-id", pattern: /.+/ },
      { type: "header", name: "server", pattern: /Vercel/i },
    ],
  },
  {
    id: "bunnycdn",
    name: "BunnyCDN",
    category: "cdn",
    website: "https://bunny.net",
    icon: "bunnycdn",
    detectors: [
      { type: "header", name: "server", pattern: /BunnyCDN/i },
      { type: "header", name: "cdn-pullzone", pattern: /.+/ },
      { type: "html", pattern: /b-cdn\.net/i },
    ],
  },
  {
    id: "keycdn",
    name: "KeyCDN",
    category: "cdn",
    website: "https://keycdn.com",
    icon: "keycdn",
    detectors: [
      { type: "header", name: "server", pattern: /keycdn/i },
      { type: "html", pattern: /kxcdn\.com/i },
    ],
  },
];
