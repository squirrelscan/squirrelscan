// security/csp-violations - what the page's Content-Security-Policy actually blocked while it rendered (#425).
//
// security/csp grades the policy text and security/csp-blocks-own-resources predicts blocks from the
// markup. Neither sees what a script injects after hydration or which endpoint a tag posts to at run
// time. This rule reads the browser's own verdict: the `securitypolicyviolation` events the renderer
// recorded while the page ran during a rendered crawl, including the few seconds after `load`.
//
// It needs the render to have recorded them. A raw (HTTP) page, or a renderer that did not listen for
// violations, is a skip, never a pass: no violation seen is only clean when someone was looking.

import type {
  CheckItem,
  CheckResult,
  RenderCspViolation,
} from "@squirrelscan/core-contracts";

import { RUNTIME_NOT_RECORDED_SKIP_REASON } from "@squirrelscan/core-contracts";
import {
  clampItemId,
  clampItemString,
} from "@squirrelscan/core-contracts/clamp";

import type { Rule, RuleContext, RuleResult } from "../types";

import { blockedUrlCategory, type VendorCategory } from "./csp-vendors";

const CHECK = "csp-violations";
/** Groups listed per page; the rest are counted in `details.additional`. */
const MAX_ITEMS = 25;
/** Distinct blocked endpoints named per group. */
const MAX_ENDPOINTS = 5;
/** Longest directive name kept; real ones are under 30 characters. */
const MAX_DIRECTIVE = 64;
/** Longest blocked endpoint or source location kept in a label. */
const MAX_ENDPOINT = 200;

/** `blockedURI` values that name a kind of content rather than a URL, with how a visitor would describe it. */
const KEYWORD_LABELS: Readonly<Record<string, string>> = {
  inline: "inline code",
  eval: "eval()",
  "wasm-eval": "WebAssembly compilation",
  data: "a data: URL",
  blob: "a blob: URL",
  "trusted-types-policy": "a Trusted Types policy",
  "trusted-types-sink": "a Trusted Types sink",
};

interface Group {
  directive: string;
  /** Lowercase hostname, or the keyword for non-URL blocks. */
  target: string;
  /** Scheme and host to add to the policy, absent for keywords. */
  source?: string;
  keyword?: string;
  category?: VendorCategory;
  endpoints: string[];
  count: number;
  /** Where the first violation of the group came from, when the browser said. */
  where?: string;
}

/** A directive name as the browser reports it: lowercase letters and hyphens only. */
function cleanDirective(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.trim().toLowerCase().slice(0, MAX_DIRECTIVE);
  return /^[a-z][a-z-]*$/.test(d) ? d : null;
}

/** An absolute http(s) URL. The browser reports `blockedURI` and `sourceFile` absolute, so nothing is resolved. */
function httpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Host and path, never the query: a beacon's query carries visitor ids and the property's tokens. */
function endpointOf(url: URL): string {
  return clampItemString(`${url.host}${url.pathname}`, MAX_ENDPOINT);
}

function sourceLocation(v: RenderCspViolation): string | undefined {
  if (typeof v.sourceFile !== "string" || v.sourceFile === "") return undefined;
  const url = httpUrl(v.sourceFile);
  if (!url) return undefined;
  const line =
    typeof v.lineNumber === "number" &&
    Number.isInteger(v.lineNumber) &&
    v.lineNumber > 0
      ? `:${v.lineNumber}`
      : "";
  return clampItemString(`${url.href.split(/[?#]/)[0]}${line}`, MAX_ENDPOINT);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describe(group: Group): string {
  const what = group.keyword
    ? (KEYWORD_LABELS[group.keyword] ?? group.keyword)
    : group.target;
  const endpoints =
    group.endpoints.length > 0
      ? ` (${group.endpoints.join(", ")}${group.count > group.endpoints.length && group.endpoints.length === MAX_ENDPOINTS ? ", ..." : ""})`
      : "";
  const times = group.count > 1 ? `, ${group.count} times` : "";
  const fix = group.source
    ? `add ${group.source} to ${group.directive}`
    : group.keyword === "inline"
      ? `move the code to a file or allow it with a nonce or hash in ${group.directive}`
      : `allow it in ${group.directive} only if the page needs it`;
  return `${group.directive} blocked ${what}${endpoints}${times}: ${fix}`;
}

export const cspViolationsRule: Rule = {
  meta: {
    id: "security/csp-violations",
    name: "CSP Violations During Render",
    description:
      "Reports the resources the browser blocked under the page's Content-Security-Policy while the page rendered, grouped by blocked host and directive",
    solution:
      "The browser blocked these loads and the page still answered 200, so nothing in the HTML looks wrong: a widget injected after load never appears, analytics hits never arrive, a payment or captcha frame stays empty. For each finding, add the reported host to the directive it names (for example script-src-elem, or script-src when the policy has no script-src-elem), then reload the page with the browser console open and confirm no violation remains. A blocked analytics, ads, payments, captcha, form or booking vendor is an error, because the feature it powers is broken for every visitor. For blocked inline code, move it to a file or allow it with a nonce or hash rather than 'unsafe-inline'.",
    category: "security",
    scope: "page",
    // Reads what this page's render recorded, which no template shares.
    verdictScope: "page",
    // A finding names a blocked host under one directive, shared across the pages that load it.
    findingScope: "resource",
    severity: "error",
    weight: 6,
    // One check name for every outcome: a pass on the page clears the page's earlier violations.
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CHECK, outcome: "clean", clears: [CHECK] },
      { name: CHECK, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const skip = (message: string, skipReason: string): RuleResult => ({
      checks: [{ name: CHECK, status: "skipped", message, skipReason }],
    });

    if (!ctx.page.rendered) {
      return skip(
        "CSP violations were not checked: the page was fetched as plain HTML, not rendered in a browser",
        "Only a browser render records what a Content-Security-Policy blocks: audit with --render (or --render-mode auto) to check it"
      );
    }
    const violations = ctx.page.renderRuntime?.cspViolations;
    if (!Array.isArray(violations)) {
      return skip(
        "CSP violations were not checked: the renderer did not record them for this page",
        RUNTIME_NOT_RECORDED_SKIP_REASON
      );
    }

    // Keyed with JSON so no site-chosen host or directive can collide with another pair.
    const groups = new Map<string, Group>();
    for (const v of violations) {
      if (typeof v !== "object" || v === null) continue;
      // A report-only policy blocked nothing.
      if (v.disposition === "report") continue;
      const directive = cleanDirective(v.effectiveDirective);
      if (!directive || typeof v.blockedURI !== "string") continue;
      const raw = v.blockedURI.trim();
      const keyword = raw.toLowerCase();
      let group: Group | undefined;
      if (Object.hasOwn(KEYWORD_LABELS, keyword)) {
        const key = JSON.stringify([directive, keyword]);
        group = groups.get(key);
        if (!group) {
          group = {
            directive,
            target: keyword,
            keyword,
            endpoints: [],
            count: 0,
          };
          groups.set(key, group);
        }
      } else {
        const url = httpUrl(raw);
        // Not a URL the rule can name a host for (an unknown keyword, a non-http scheme).
        if (!url) continue;
        const host = url.hostname.toLowerCase().replace(/\.$/, "");
        const key = JSON.stringify([directive, host]);
        group = groups.get(key);
        if (!group) {
          group = {
            directive,
            target: host,
            source: `${url.protocol}//${url.host}`,
            category: blockedUrlCategory(url),
            endpoints: [],
            count: 0,
          };
          groups.set(key, group);
        }
        // Any vendor endpoint on the host makes the whole group the vendor's.
        group.category ??= blockedUrlCategory(url);
        const endpoint = endpointOf(url);
        if (
          endpoint !== `${url.host}/` &&
          !group.endpoints.includes(endpoint) &&
          group.endpoints.length < MAX_ENDPOINTS
        )
          group.endpoints.push(endpoint);
      }
      group.count++;
      group.where ??= sourceLocation(v);
    }

    if (groups.size === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message:
              "The browser blocked nothing under the page's Content-Security-Policy while it rendered",
          },
        ],
      };
    }

    // Vendor blocks first, then the most frequent.
    const all = [...groups.values()].sort(
      (a, b) =>
        Number(b.category !== undefined) - Number(a.category !== undefined) ||
        b.count - a.count
    );
    const vendorBlocks = all.filter((g) => g.category !== undefined).length;
    const items: CheckItem[] = all.slice(0, MAX_ITEMS).map((g) => ({
      id: clampItemId(`${g.directive} ${g.target}`),
      label: clampItemString(describe(g)),
      ...(g.where ? { snippet: `from ${g.where}` } : {}),
      meta: {
        directive: g.directive,
        ...(g.source ? { host: g.target } : { blocked: g.target }),
        count: g.count,
        ...(g.endpoints.length > 0 ? { endpoints: g.endpoints } : {}),
        ...(g.category ? { category: g.category } : {}),
      },
    }));
    const summary = all
      .slice(0, 5)
      .map(
        (g) =>
          `${g.directive}: ${g.keyword ? (KEYWORD_LABELS[g.keyword] ?? g.target) : g.target}`
      )
      .join("; ");
    const more = all.length > 5 ? ` and ${all.length - 5} more` : "";
    const check: CheckResult = {
      name: CHECK,
      status: vendorBlocks > 0 ? "fail" : "warn",
      message: `The page's Content-Security-Policy blocked ${plural(all.length, "source")} while it rendered${vendorBlocks > 0 ? `, ${vendorBlocks} from a known analytics, ads, payments, captcha, form or booking vendor` : ""} (${summary}${more})`,
      items,
      details: {
        groups: all.length,
        vendorGroups: vendorBlocks,
        ...(all.length > MAX_ITEMS
          ? { additional: all.length - MAX_ITEMS }
          : {}),
      },
    };
    return { checks: [check] };
  },
};
