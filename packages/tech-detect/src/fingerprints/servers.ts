import type { TechFingerprint } from "../types";

export const SERVER_FINGERPRINTS: TechFingerprint[] = [
  {
    id: "nginx",
    name: "nginx",
    category: "web-server",
    website: "https://nginx.org",
    icon: "nginx",
    detectors: [
      { type: "header", name: "server", pattern: /^nginx/i },
    ],
    versionPattern: /nginx\/([\d.]+)/i,
  },
  {
    id: "apache",
    name: "Apache",
    category: "web-server",
    website: "https://httpd.apache.org",
    icon: "apache",
    detectors: [
      { type: "header", name: "server", pattern: /^Apache/i },
    ],
    versionPattern: /Apache\/([\d.]+)/i,
  },
  {
    id: "iis",
    name: "Microsoft IIS",
    category: "web-server",
    website: "https://iis.net",
    icon: "iis",
    detectors: [
      { type: "header", name: "server", pattern: /Microsoft-IIS/i },
    ],
    versionPattern: /Microsoft-IIS\/([\d.]+)/i,
  },
  {
    id: "litespeed",
    name: "LiteSpeed",
    category: "web-server",
    website: "https://litespeedtech.com",
    icon: "litespeed",
    detectors: [
      { type: "header", name: "server", pattern: /LiteSpeed/i },
    ],
    versionPattern: /LiteSpeed\/([\d.]+)/i,
  },
  {
    id: "caddy",
    name: "Caddy",
    category: "web-server",
    website: "https://caddyserver.com",
    icon: "caddy",
    detectors: [
      { type: "header", name: "server", pattern: /^Caddy/i },
    ],
    versionPattern: /Caddy\/([\d.]+)/i,
  },
  {
    id: "envoy",
    name: "Envoy",
    category: "web-server",
    website: "https://envoyproxy.io",
    icon: "envoy",
    detectors: [
      { type: "header", name: "server", pattern: /^envoy/i },
    ],
  },
];
