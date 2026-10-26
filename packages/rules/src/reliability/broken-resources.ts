// reliability/broken-resources - scripts, stylesheets and fonts that fail to load (#703)
//
// Reads the statuses the asset phase records, with no render: a deploy that
// deletes a hashed bundle shows up here even when the HTML that references it is
// a 200. Same-site assets are the ones the asset phase already fetches; the only
// extra requests are a status check (HEAD first) per third-party script,
// stylesheet and font, capped at MAX_EXTERNAL_ASSETS_TO_CHECK per kind, sent
// without the audit's custom headers and only to public addresses (#703).

import type {
  CheckItem,
  CheckResult,
  ResourceSizeData,
  ScriptContentData,
} from "@squirrelscan/core-contracts";
import {
  ASSET_FETCH_REFUSED_ERROR,
  ASSET_FETCH_SKIPPED_ERROR,
} from "@squirrelscan/utils/constants";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";

import { registrableDomain } from "../content/dev-leakage";
import type { Rule, RuleContext, RuleResult, SiteData } from "../types";

type Kind = "script" | "stylesheet" | "font";

/** One resource URL, merged across the pages that reference it. */
interface Asset {
  url: string;
  kind: Kind;
  firstParty: boolean;
  status: number | null;
  error: string | null;
  rateLimited: boolean;
  wafBlocked: boolean;
  /** Custom headers were withheld from this host (#732): a 401/403 asks for them. */
  headersWithheld: boolean;
  /** Probed by the third-party status check, which sends no credentials. */
  credentialless: boolean;
  sourcePages: Set<string>;
}

/**
 * How one resource reads:
 * - `fail`: a first-party script or stylesheet answered 4xx/5xx (error).
 * - `warn`: a third-party script or stylesheet, or any font, answered 4xx/5xx,
 *   or the request failed at the network level (DNS, TLS, timeout). A warning,
 *   because a network failure is often transient and a third party is not the
 *   site's own code.
 * - `unverified`: the origin throttled us (429/430, or 503 with `Retry-After`),
 *   or a WAF or bot challenge answered in place of the file, or the
 *   credential-less probe of a sibling first-party host got 401/407. The
 *   status says nothing about the file.
 * - `unchecked`: the fetch was skipped (budget, tarpit) or never ran.
 * - `refused`: the URL, or a redirect it answered with, is on a private,
 *   loopback, link-local or metadata address (or, in an offline audit, on
 *   another site), so it was never requested.
 * - `ok`: answered below 400.
 */
type Verdict = "fail" | "warn" | "unverified" | "unchecked" | "refused" | "ok";

interface SiteOrigin {
  host: string;
  /** Registrable domain (eTLD+1), or the host itself where there is none. */
  domain: string;
}

function siteOrigin(baseUrl: string): SiteOrigin | null {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
    return { host, domain: registrableDomain(host) };
  } catch {
    return null;
  }
}

/**
 * First-party means the same registrable domain as the site (#703), so a site on
 * `www.example.com` owns `example.com/app.js` and `cdn.example.com/app.js`. The
 * private-suffix list is on, so `a.vercel.app` does not own `b.vercel.app`. The
 * site's own host and its subdomains always count too: a host with no registrable
 * domain (`localhost`, an IP) still owns `assets.localhost`. This is wider than
 * the asset collector's same-host split, which only decides which list
 * (same-site or third-party) a URL is fetched through.
 */
function isFirstParty(url: string, site: SiteOrigin | null): boolean {
  if (!site) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (host === site.host || host.endsWith(`.${site.host}`)) return true;
  return registrableDomain(host) === site.domain;
}

function verdictOf(asset: Asset): Verdict {
  if (asset.status === null) {
    // No status and no error: the fetch never ran. The skipped placeholder is the
    // budget or tarpit path, which the asset phase records explicitly.
    if (asset.error === null || asset.error === ASSET_FETCH_SKIPPED_ERROR) return "unchecked";
    if (asset.error === ASSET_FETCH_REFUSED_ERROR) return "refused";
    // A status-less error is a network failure (DNS, TLS, timeout, reset).
    return "warn";
  }
  // Throttling and challenges are read from the response, not the status alone:
  // a bare 503 is an outage and stays broken. Only 503 with Retry-After (flagged
  // `rateLimited`) is the origin asking us to come back later.
  if (asset.rateLimited || asset.wafBlocked || isRateLimitStatus(asset.status)) {
    return "unverified";
  }
  // The audit's custom headers go to the audited origin and named hosts only
  // (#732), so a 401/403 from another host says it wants them.
  if (asset.headersWithheld && (asset.status === 401 || asset.status === 403)) {
    return "unverified";
  }
  // The third-party probe sends none of the audit's credentials, so on a
  // sibling of the site's own host (a staging CDN behind the same auth) a 401
  // or 407 says the host wants them, not that the file is gone. A true third
  // party that answers 401 fails for visitors too, so it stays a warning.
  if (asset.credentialless && asset.firstParty && (asset.status === 401 || asset.status === 407)) {
    return "unverified";
  }
  if (asset.status < 400) return "ok";
  // 4xx/5xx. Only first-party scripts and stylesheets are errors; fonts and
  // third-party files are warnings.
  const firstPartyCode = asset.firstParty && asset.kind !== "font";
  return firstPartyCode ? "fail" : "warn";
}

function toItem(asset: Asset): CheckItem {
  const detail =
    asset.status !== null ? `HTTP ${asset.status}` : `error: ${asset.error ?? "unknown"}`;
  return {
    id: asset.url,
    label: `${asset.url} (${detail})`,
    sourcePages: [...asset.sourcePages],
    meta: {
      kind: asset.kind,
      status: asset.status,
      error: asset.error,
      rateLimited: asset.rateLimited,
      wafBlocked: asset.wafBlocked,
      ...(asset.headersWithheld ? { headersWithheld: true } : {}),
    },
  };
}

interface Collected {
  assets: Asset[];
  /** Kinds the crawl never measured (hand-built context, older caller). */
  unmeasured: string[];
}

function collect(site: SiteData, origin: SiteOrigin | null): Collected {
  const byKey = new Map<string, Asset>();
  const add = (
    entries: Array<ScriptContentData | ResourceSizeData>,
    kind: Kind,
    credentialless = false,
  ): void => {
    for (const entry of entries) {
      const firstParty = isFirstParty(entry.url, origin);
      const key = `${kind}\n${firstParty}\n${entry.url}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const page of entry.sourcePages) existing.sourcePages.add(page);
        continue;
      }
      byKey.set(key, {
        url: entry.url,
        kind,
        firstParty,
        status: entry.status,
        error: entry.error,
        rateLimited: entry.rateLimited === true,
        wafBlocked: entry.wafBlocked === true,
        headersWithheld: entry.headersWithheld === true,
        credentialless,
        sourcePages: new Set(entry.sourcePages),
      });
    }
  };

  // A kind whose list is absent was never measured (hand-built context, older
  // caller). That is "not checked", never "none referenced".
  const unmeasured: string[] = [];
  if (site.scripts === undefined) unmeasured.push("scripts");
  else add(site.scripts, "script");

  if (site.resourceSizes?.css === undefined) unmeasured.push("stylesheets");
  else add(site.resourceSizes.css, "stylesheet");

  if (site.resourceSizes?.fonts === undefined) unmeasured.push("fonts");
  else add(site.resourceSizes.fonts, "font");

  if (site.externalAssets === undefined) unmeasured.push("third-party resources");
  else {
    add(site.externalAssets.scripts, "script", true);
    add(site.externalAssets.css, "stylesheet", true);
    add(site.externalAssets.fonts, "font", true);
  }

  return { assets: [...byKey.values()], unmeasured };
}

export const brokenResourcesRule: Rule = {
  meta: {
    id: "reliability/broken-resources",
    name: "Broken Scripts, Stylesheets and Fonts",
    description:
      "Checks that the scripts, stylesheets and fonts pages reference load, and reports 4xx/5xx or failed requests",
    solution:
      "A page whose script or stylesheet returns 404 or 500 still answers 200 with its title and meta, but renders unstyled or its interactive parts never run. The usual cause is a deploy: cached HTML still points at hashed bundles the new release deleted. Redeploy the missing file, or update the reference so pages point at the bundle that exists. Keep old hashed assets for as long as cached HTML may reference them. Third-party failures are reported as warnings: check the provider's status, or remove the reference if the service is gone.",
    category: "reliability",
    scope: "site",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const site = ctx.site;

    if (!site) {
      checks.push({
        name: "broken-resources",
        status: "skipped",
        message: "Site data not available",
      });
      return { checks };
    }

    const { assets, unmeasured } = collect(site, siteOrigin(site.baseUrl));

    const failed: Asset[] = [];
    const warned: Asset[] = [];
    const unverified: Asset[] = [];
    let unchecked = 0;
    let refused = 0;
    let ok = 0;
    for (const asset of assets) {
      switch (verdictOf(asset)) {
        case "fail":
          failed.push(asset);
          break;
        case "warn":
          warned.push(asset);
          break;
        case "unverified":
          unverified.push(asset);
          break;
        case "unchecked":
          unchecked++;
          break;
        case "refused":
          refused++;
          break;
        case "ok":
          ok++;
          break;
      }
    }

    // URLs the fetch caps left out of the list entirely (#703): they are not in
    // `assets` at all, so only the count says they exist.
    const dropped = Object.values(site.assetCapDropped ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);

    // Partial when any fetch was skipped, a cap dropped referenced URLs, or a
    // kind was never measured. The result must say so instead of reading as a pass.
    const notChecked = unchecked + refused + dropped + unmeasured.length;

    if (failed.length > 0) {
      checks.push({
        name: "broken-resources",
        status: "fail",
        message: `${failed.length} first-party script or stylesheet(s) answer with an error status`,
        items: failed.map(toItem),
        details: { count: failed.length },
      });
    }

    if (warned.length > 0) {
      checks.push({
        name: "unreachable-resources",
        status: "warn",
        message: `${warned.length} third-party or font resource(s), or resource(s) that failed at the network level, did not load`,
        items: warned.map(toItem),
        details: { count: warned.length },
      });
    }

    if (unverified.length > 0) {
      const withheldHosts = [
        ...new Set(
          unverified
            .filter((asset) => asset.headersWithheld)
            .map((asset) => {
              try {
                return new URL(asset.url).host;
              } catch {
                return asset.url;
              }
            }),
        ),
      ].sort();
      const withheldNote =
        withheldHosts.length > 0
          ? `; ${withheldHosts.join(", ")} asked for credentials and the audit's custom headers are not sent there, so name the host in header_hosts or --header-host to send them`
          : "";
      checks.push({
        name: "unverified-resources",
        status: "info",
        message: `${unverified.length} resource(s) were throttled by the origin, answered with a WAF or bot challenge, or asked for credentials the third-party check does not send, so their status is unverified and not reported as broken${withheldNote}`,
        items: unverified.map(toItem),
        details: { count: unverified.length },
      });
    }

    if (notChecked > 0) {
      const parts: string[] = [];
      if (unchecked > 0) {
        parts.push(`${unchecked} referenced resource(s) were not fetched (budget or tarpit skip)`);
      }
      if (dropped > 0) {
        parts.push(`${dropped} referenced resource(s) were not fetched (asset fetch cap)`);
      }
      if (refused > 0) {
        parts.push(
          `${refused} referenced resource(s) were not requested (a private, loopback or metadata address, or another site in an offline audit)`,
        );
      }
      if (unmeasured.length > 0) {
        parts.push(`${unmeasured.join(", ")} were not measured this audit`);
      }
      checks.push({
        name: "unchecked-resources",
        status: "info",
        message: `Partial check: ${parts.join("; ")}`,
        details: { unchecked, refused, dropped, unmeasured },
      });
    }

    if (failed.length === 0 && warned.length === 0) {
      if (ok > 0) {
        checks.push({
          name: "broken-resources",
          status: "pass",
          message:
            notChecked > 0
              ? `No broken resources among the ${ok} checked`
              : `All ${ok} checked script, stylesheet and font resource(s) load`,
          value: ok,
        });
      } else if (assets.length === 0 && notChecked === 0) {
        checks.push({
          name: "broken-resources",
          status: "pass",
          message: "No scripts, stylesheets or fonts to check",
          value: 0,
        });
      }
    }

    return { checks };
  },
};
