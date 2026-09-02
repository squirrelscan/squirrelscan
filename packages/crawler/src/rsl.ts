import { Effect } from "effect";
import { truncateToBytes } from "@squirrelscan/utils/bytes";
import { isHttpOrHttpsUrl } from "@squirrelscan/utils/safe-fetch";
import { readBodyCapped } from "@squirrelscan/utils/response-body";

import { safeFetchWithDeadline } from "./deadline";

import type { RslData, RslLicenseDoc } from "@squirrelscan/core-contracts";

const PROBE_TIMEOUT_MS = 15_000;
const ROBOTS_MAX_BYTES = 512 * 1024;
const RSL_MAX_BYTES = 512 * 1024;
const EXCERPT_MAX_BYTES = 2_048;

// Extract `License:` directive URLs from raw robots.txt (RSL, rslstandard.org).
// Directive is case-insensitive; comments (#) and blank values are ignored.
export function extractRobotsLicenseUrls(robotsTxt: string): string[] {
  const urls: string[] = [];
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const match = /^license\s*:\s*(\S+)/i.exec(line);
    if (match?.[1]) urls.push(match[1]);
  }
  return urls;
}

// Extract URLs from a `Link:` response header carrying rel="license".
export function extractLinkHeaderLicenseUrls(linkHeader: string | null): string[] {
  if (!linkHeader) return [];
  const urls: string[] = [];
  // Header can hold several comma-separated links: <url>; rel="license", <url>; rel="next"
  for (const part of linkHeader.split(/,(?=\s*<)/)) {
    const urlMatch = /<([^>]+)>/.exec(part);
    if (!urlMatch?.[1]) continue;
    if (/rel\s*=\s*"?[^"]*\blicense\b/i.test(part)) urls.push(urlMatch[1]);
  }
  return urls;
}

// Root element / namespace check for an RSL license document.
export function looksLikeRsl(body: string): boolean {
  const head = body.slice(0, 4_096);
  return /<rsl[\s>]/i.test(head) || head.includes("rslstandard.org/rsl");
}

// A well-formed-enough XML sniff: starts with a tag or XML prolog and is not HTML.
export function looksLikeXml(body: string): boolean {
  const head = body.trimStart().slice(0, 512).toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return false;
  return head.startsWith("<?xml") || head.startsWith("<");
}

async function fetchLicenseDoc(
  url: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
): Promise<RslLicenseDoc> {
  try {
    return await safeFetchWithDeadline(
      url,
      {
        headers: {
          "User-Agent": userAgent,
          Accept: "application/rsl+xml, application/xml, text/xml, */*",
          ...customHeaders,
        },
      },
      PROBE_TIMEOUT_MS,
      async (response) => {
        const contentType = response.headers.get("content-type");
        const raw = await readBodyCapped(response, RSL_MAX_BYTES);
        const body = truncateToBytes(raw, RSL_MAX_BYTES);
        return {
          url,
          status: response.status,
          contentType,
          xmlValid: looksLikeXml(body),
          looksRsl: looksLikeRsl(body),
          excerpt: truncateToBytes(body, EXCERPT_MAX_BYTES),
          error: null,
        };
      },
    );
  } catch (e) {
    return {
      url,
      status: 0,
      contentType: null,
      xmlValid: false,
      looksRsl: false,
      excerpt: "",
      error: (e as Error).message,
    };
  }
}

// Fetch robots.txt, extract RSL `License:` directives + `Link: rel=license`
// header, then fetch each referenced license doc. Self-contained so it runs
// unconditionally alongside the other prefetches (independent of respectRobots).
export function fetchRslLicensing(
  baseUrl: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
): Effect.Effect<RslData, never, never> {
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();
  return Effect.promise(async () => {
    let robotsBody = "";
    let linkHeader: string | null = null;
    try {
      await safeFetchWithDeadline(
        robotsUrl,
        { headers: { "User-Agent": userAgent, Accept: "text/plain, */*", ...customHeaders } },
        PROBE_TIMEOUT_MS,
        async (response) => {
          if (response.ok) {
            const raw = await readBodyCapped(response, ROBOTS_MAX_BYTES);
            robotsBody = truncateToBytes(raw, ROBOTS_MAX_BYTES);
            linkHeader = response.headers.get("link");
          } else {
            await response.body?.cancel().catch(() => {});
          }
        },
      );
    } catch {
      // robots unreachable → no licensing signal; return empty below.
    }

    const directiveUrls = extractRobotsLicenseUrls(robotsBody);
    const headerUrls = extractLinkHeaderLicenseUrls(linkHeader);
    const licenseUrls = [...new Set([...directiveUrls, ...headerUrls])].flatMap((u) => {
      // A malformed advisory URL must not abort the crawl — drop it.
      try {
        const resolved = new URL(u, baseUrl).toString();
        // #1394: `License:` directives and `Link: rel=license` headers are
        // untrusted page content. Only fetch http(s) license docs — a
        // `file://`/`data:` target would otherwise be fetched and its body
        // captured into `excerpt`.
        if (!isHttpOrHttpsUrl(resolved)) return [];
        return [resolved];
      } catch {
        return [];
      }
    });

    // #1394: the caller's secret customHeaders are scoped to the audited origin —
    // a license doc hosted off-origin must not receive them.
    const baseHost = new URL(baseUrl).host;
    const documents = await Promise.all(
      licenseUrls.map((url) => {
        const sameOrigin = new URL(url).host === baseHost;
        return fetchLicenseDoc(url, userAgent, sameOrigin ? customHeaders : undefined);
      }),
    );

    return {
      licenseUrls,
      robotsHasLicense: directiveUrls.length > 0,
      linkHeaderPresent: headerUrls.length > 0,
      documents,
    };
  });
}
