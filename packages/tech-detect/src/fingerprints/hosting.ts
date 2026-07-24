import type { TechFingerprint } from "../types";

export const HOSTING_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "vercel",
    name: "Vercel",
    category: "hosting",
    website: "https://vercel.com",
    icon: "vercel",
    detectors: [
      { type: "header", name: "x-vercel-id", pattern: /.+/ },
      { type: "header", name: "server", pattern: /Vercel/i },
    ],
  },
  {
    id: "netlify",
    name: "Netlify",
    category: "hosting",
    website: "https://netlify.com",
    icon: "netlify",
    detectors: [
      { type: "header", name: "server", pattern: /Netlify/i },
      { type: "header", name: "x-nf-request-id", pattern: /.+/ },
    ],
  },
  {
    id: "github-pages",
    name: "GitHub Pages",
    category: "hosting",
    website: "https://pages.github.com",
    icon: "github",
    detectors: [
      { type: "header", name: "server", pattern: /GitHub\.com/i },
      { type: "header", name: "x-github-request-id", pattern: /.+/ },
    ],
  },
  {
    id: "cloudflare-pages",
    name: "Cloudflare Pages",
    category: "hosting",
    website: "https://pages.cloudflare.com",
    icon: "cloudflare",
    detectors: [
      // NOT cf-ray — that header is on EVERY Cloudflare-proxied site (CDN), not
      // just Pages. `*.pages.dev` (deploy domain) + the Pages server token are
      // Pages-specific.
      { type: "html", pattern: /\.pages\.dev/i },
      { type: "header", name: "server", pattern: /^cloudflare-pages$/i },
    ],
    confidence: "medium",
  },
  {
    id: "render",
    name: "Render",
    category: "hosting",
    website: "https://render.com",
    icon: "render",
    detectors: [
      { type: "header", name: "server", pattern: /Render/i },
      { type: "header", name: "x-render-origin-server", pattern: /.+/ },
    ],
  },
  {
    id: "fly-io",
    name: "Fly.io",
    category: "hosting",
    website: "https://fly.io",
    icon: "fly",
    detectors: [
      { type: "header", name: "fly-request-id", pattern: /.+/ },
      { type: "header", name: "server", pattern: /Fly/i },
    ],
  },
  {
    id: "heroku",
    name: "Heroku",
    category: "hosting",
    website: "https://heroku.com",
    icon: "heroku",
    detectors: [
      { type: "header", name: "via", pattern: /vegur/i },
      { type: "header", name: "server", pattern: /heroku/i },
    ],
    confidence: "medium",
  },
  {
    id: "aws-s3",
    name: "AWS S3",
    category: "hosting",
    website: "https://aws.amazon.com/s3",
    icon: "aws",
    detectors: [
      { type: "header", name: "server", pattern: /AmazonS3/i },
      { type: "header", name: "x-amz-request-id", pattern: /.+/ },
    ],
  },
];
