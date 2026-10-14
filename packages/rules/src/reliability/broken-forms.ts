// reliability/broken-forms - forms that silently lose submissions (#707)
//
// Two causes that look fine from the outside. A control with no `name` is shown,
// filled in and never sent, because the browser submits only named controls. A
// form whose `action` answers 404, points at a staging or localhost host, or is
// `mailto:` never reaches a handler, and the visitor is shown a success page anyway.
//
// Field checks read the DOM the crawl already parsed. Action checks reuse the
// crawl's status for a same-site URL. Anything else gets at most one probe per
// distinct action URL, through the shared probe budget: HEAD, then GET when HEAD is
// refused (405/501) or fails at the network level. The probe method type is
// `"HEAD" | "GET"`, so no POST can be sent and no submission can happen.
//
// A probe carries squirrel's User-Agent and Accept only: no cookies and none of
// the audit's custom headers, the same as the GraphQL probes. Its body is never
// read (fetched undecoded, so a compression bomb is never inflated), redirects
// are not followed, and every request goes through the egress guard: a
// third-party action, or a subdomain of a public site, is requested only on a
// public address (unless the audited site is itself on a private network), a
// same-site action only on the site's host or subdomains, never link-local or
// metadata addresses, and always on the address that was vetted.

import type { CheckItem, CheckResult } from "@squirrelscan/core-contracts";
import { normalizeUrl } from "@squirrelscan/utils";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { isNonPublicHostname } from "@squirrelscan/utils/non-public-host";
import {
  EgressRefusedError,
  assertEgressAllowed,
  egressGuardedSend,
  memoizeResolveHost,
  resolveHostAddresses,
  type EgressPolicy,
  type ResolveHost,
} from "@squirrelscan/utils/public-egress";
import { isRateLimitedResponse } from "@squirrelscan/utils/rate-limit";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";

import {
  classifyHost,
  isLoopbackHost,
  isNonProductionSeedHost,
  isPrivateIpHost,
  registrableDomain,
  siteOriginOf,
  toSample,
} from "../content/dev-leakage";
import type { ProbeBudget } from "../probe-budget";
import { fieldSelector, fieldSnippet, formSelector, inputType } from "../shared/form-fields";
import type { ExternalLinkCheckData, Rule, RuleContext, RuleResult, SiteData } from "../types";

/** Per-request cap, on top of the shared budget's deadline. */
const PROBE_TIMEOUT_MS = 10_000;

/** Control types that never carry a submitted name of their own. */
const UNNAMEABLE_TYPES = new Set(["submit", "button", "reset", "image"]);

/** Submit controls whose `formaction` overrides the owning form's action. */
const FORMACTION_SUBMITTERS =
  'button[formaction]:not([type="button" i]):not([type="reset" i]), input[type="submit" i][formaction], input[type="image" i][formaction]';

const REASON_PASSIVE = "passive probing sends no requests";
const REASON_BUDGET = "probe budget exhausted";
const REASON_EXTERNAL_OFF = "external link checking is off";
const REASON_REFUSED = "its address is private, loopback or link-local, or it is off the site";
const REASON_PLAIN_HTTP = "a plain-http action on a page the crawl did not fetch is not probed";
const REASON_PROBE_CAP = "probe cap reached";

/**
 * Distinct actions probed per audit, and per host. A site with one form per
 * product (`/cart/add?id=N`) would otherwise spend the whole shared probe budget
 * here, send a GET to every one of those endpoints, and point a page's worth of
 * requests at one third-party host from the auditor's address.
 */
const MAX_PROBED_ACTIONS = 25;
/** Per site (registrable domain), so `a.vendor.com` and `b.vendor.com` share one allowance. */
const MAX_PROBED_PER_HOST = 10;

/** Longest site-controlled string kept in an item id or meta (labels are cut shorter). */
const MAX_STORED = 2048;

function stored(value: string): string {
  return value.length > MAX_STORED ? value.slice(0, MAX_STORED) : value;
}

/**
 * How many probes this run has spent, in total and per registrable domain, and
 * the verdict per endpoint (origin and path): query variants of one endpoint
 * (`/cart/add?id=1`, `?id=2`) share one probe, since its status does not
 * depend on the query.
 */
interface ProbeQuota {
  total: number;
  perSite: Map<string, number>;
  byEndpoint: Map<string, Promise<Reach>>;
}

function endpointOf(href: string): string {
  try {
    const url = new URL(href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return href;
  }
}

/**
 * One probe per endpoint within the caps: the endpoint's verdict when it was
 * already probed, a fresh probe while the quota lasts, else "probe cap reached".
 */
function probeWithinQuota(
  quota: ProbeQuota,
  href: string,
  probe: () => Promise<Reach>,
): Promise<Reach> {
  const endpoint = endpointOf(href);
  const known = quota.byEndpoint.get(endpoint);
  if (known) return known;
  const host = hostOf(href) ?? "";
  const site = registrableDomain(host);
  const used = quota.perSite.get(site) ?? 0;
  if (quota.total >= MAX_PROBED_ACTIONS || used >= MAX_PROBED_PER_HOST) {
    return Promise.resolve({ kind: "unchecked", reason: REASON_PROBE_CAP });
  }
  quota.total++;
  quota.perSite.set(site, used + 1);
  const verdict = probe();
  quota.byEndpoint.set(endpoint, verdict);
  return verdict;
}

type Method = "HEAD" | "GET";

interface Sent {
  status: number | null;
  error: string | null;
  retryAfter: string | null;
  challenge: boolean;
  /** The egress guard refused the request: nothing was sent. */
  refused?: boolean;
}

/** How one action URL reads. */
type Reach =
  | { kind: "ok" }
  /** A first-party action the crawl fetched and found 404 or 410: submissions are lost. */
  | { kind: "dead"; status: number }
  /**
   * A first-party action that answers 404 or 410 to the HEAD/GET probe. Express
   * and Rails answer 404 to GET on a POST-only route, so this may be fine.
   */
  | { kind: "probe-missing"; status: number }
  /** 5xx, a network failure, or a third-party 404/410. */
  | { kind: "unreachable"; detail: string }
  /** Throttled, or a WAF challenge: the status says nothing about the handler. */
  | { kind: "unverified"; detail: string }
  /** Nothing was sent, or nothing is known. */
  | { kind: "unchecked"; reason: string };

/** Where a form action points, before any request. */
type Target =
  | { kind: "skip" }
  | { kind: "mailto"; href: string }
  | { kind: "non-production"; href: string; host: string; classification: string }
  | { kind: "reach"; href: string; firstParty: boolean; plainHttp: boolean };

interface ActionSource {
  page: string;
  form: string;
  raw: string;
  attribute: "action" | "formaction";
}

interface UnnamedField {
  page: string;
  form: string;
  hasAction: boolean;
  field: string;
  type: string;
  snippet: string;
}

/** Longest site-controlled selector quoted in a label. */
const MAX_LABEL_PART = 120;

/**
 * A site-controlled CSS selector (it carries attribute values) for a label:
 * whitespace collapsed, cut, and its parentheses percent-encoded so a crafted
 * value cannot close a bracket and open a markdown link (`"](https://…)`).
 * Square brackets stay readable: without `(` no link can form.
 */
function selectorSample(raw: string): string {
  const flat = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));
  return flat.length > MAX_LABEL_PART ? `${flat.slice(0, MAX_LABEL_PART - 1)}…` : flat;
}

/** One finding bucket: a list of items, each with the pages it was seen on. */
class Bucket {
  private readonly items = new Map<
    string,
    { label: string; pages: Set<string>; meta: Record<string, unknown> }
  >();

  add(key: string, label: string, page: string, meta: Record<string, unknown> = {}): void {
    const existing = this.items.get(key);
    if (existing) {
      existing.pages.add(page);
      return;
    }
    this.items.set(key, { label, pages: new Set([page]), meta });
  }

  get size(): number {
    return this.items.size;
  }

  toItems(): CheckItem[] {
    return [...this.items.entries()].map(([key, v]) => ({
      id: key,
      label: v.label,
      sourcePages: [...v.pages],
      meta: v.meta,
    }));
  }
}

/** Lowercased hostname, IPv6 without brackets (the form the egress guard compares). */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/** The site's own host or a subdomain of it, as broken-resources reads first-party. */
function isFirstParty(host: string, siteHostName: string | null): boolean {
  if (!siteHostName) return false;
  return host === siteHostName || host.endsWith(`.${siteHostName}`);
}

/** A real action: non-empty, not a fragment, not `javascript:`. */
function hasRealAction(raw: string): boolean {
  const value = raw.trim();
  return value !== "" && !value.startsWith("#") && !/^javascript:/i.test(value);
}

/** A control the browser would submit if it had a name. */
function isNameable(el: Element): boolean {
  if (el.hasAttribute("disabled")) return false;
  if (el.closest("template")) return false;
  return !UNNAMEABLE_TYPES.has(inputType(el));
}

function reachOf(sent: Sent, firstParty: boolean, fromProbe = false): Reach {
  if (sent.refused) return { kind: "unchecked", reason: REASON_REFUSED };
  if (sent.status === null) {
    return { kind: "unreachable", detail: `error: ${toSample(sent.error ?? "unknown")}` };
  }
  if (sent.challenge || isRateLimitedResponse(sent.status, sent.retryAfter)) {
    return { kind: "unverified", detail: `HTTP ${sent.status}` };
  }
  if (sent.status === 404 || sent.status === 410) {
    if (!firstParty) return { kind: "unreachable", detail: `HTTP ${sent.status}` };
    return fromProbe
      ? { kind: "probe-missing", status: sent.status }
      : { kind: "dead", status: sent.status };
  }
  if (sent.status >= 500) return { kind: "unreachable", detail: `HTTP ${sent.status}` };
  // 401, 403, 405 and 501 mean the endpoint exists and refuses this probe. Not broken.
  return { kind: "ok" };
}

/**
 * Where a host sits: on the auditor's own network (loopback, private IP), on a
 * preview or dev deployment, or in production.
 */
type Locality = "network" | "preview" | "production";

/** Tunnels to a developer's own machine: the site behind them is local. */
const TUNNEL_SUFFIXES = ["ngrok.io", "ngrok.app", "ngrok-free.app", "trycloudflare.com"];

function localityOf(host: string | null): Locality {
  if (!host) return "production";
  if (isLoopbackHost(host) || isPrivateIpHost(host)) return "network";
  if (TUNNEL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return "network";
  }
  return isNonProductionSeedHost(host) ? "preview" : "production";
}

/**
 * Whether a dev-host classification is expected rather than a leak, given where
 * the audited site (or the page) itself is. Auditing localhost or a LAN box, its
 * localhost and private-IP actions are its own, and so are preview and dev ones.
 * Auditing a preview deployment (many production sites live on `*.netlify.app`),
 * only preview and dev hosts are expected: a localhost or private-IP action there
 * still ships to every visitor and is still reported.
 */
function devHostExpected(kind: string, locality: Locality): boolean {
  if (locality === "network") return true;
  if (locality === "preview") return kind === "preview-host" || kind === "dev-subdomain";
  return false;
}

/** Classify one action from the target's classification, before any request. */
function targetOf(
  raw: string,
  pageUrl: string,
  siteHostName: string | null,
  siteIsHttps: boolean,
  siteLocality: Locality,
): Target {
  const value = raw.trim();
  if (/^mailto:/i.test(value)) return { kind: "mailto", href: value };

  let resolved: URL;
  try {
    resolved = new URL(value, pageUrl);
  } catch {
    return { kind: "skip" };
  }
  // tel:, sms:, data: and friends never reach a handler this rule can judge.
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return { kind: "skip" };
  resolved.hash = "";

  const host = resolved.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const origin = siteOriginOf(pageUrl);
  const pageLocality = localityOf(origin?.host ?? null);
  const found = origin ? classifyHost(host, origin) : null;
  const dev =
    found &&
    !devHostExpected(found.kind, siteLocality) &&
    !devHostExpected(found.kind, pageLocality)
      ? found
      : null;
  // A dev host the site is not itself on is reported without a request: probing
  // localhost or a staging host from the audit would be a request to the wrong place.
  if (dev) {
    return { kind: "non-production", href: resolved.href, host, classification: dev.kind };
  }
  // A plain-http action from an https site is an insecure submission:
  // security/form-https reports it, and this rule never sends it a request.
  const plainHttp = resolved.protocol === "http:";
  if (plainHttp && siteIsHttps) return { kind: "skip" };
  return {
    kind: "reach",
    href: resolved.href,
    firstParty: isFirstParty(host, siteHostName),
    plainHttp,
  };
}

/** Where probes may go, built once per run (one resolver cache per run). */
interface ProbeEgress {
  firstParty: EgressPolicy;
  thirdParty: EgressPolicy;
}

function probeEgressFor(
  siteHostName: string | null,
  siteOrigin: string | null,
  resolveHost: ResolveHost,
): ProbeEgress {
  const resolve = memoizeResolveHost(resolveHost);
  const sameSite = (host: string) => siteHostName !== null && isFirstParty(host, siteHostName);
  const sitePrivate = siteHostName !== null && isNonPublicHostname(siteHostName);
  return {
    // The site's own host and subdomains only. Private addresses only when the
    // site itself is private, or for the site's own origin (host and port), which
    // the crawl already requested: a public site's subdomain, or another port on
    // its host, that resolves privately is refused, so a page cannot point a
    // probe at the auditor's network. Never link-local or metadata addresses.
    firstParty: {
      allowPrivateNetwork: sitePrivate,
      allowPrivateTarget: (url) => siteOrigin !== null && url.origin === siteOrigin,
      allowHost: sameSite,
      resolve,
    },
    // Public addresses only, unless the audited site is itself on a private network.
    thirdParty: { allowPrivateNetwork: sitePrivate, resolve },
  };
}

/** One request, HEAD or GET. Null when the shared budget does not allow it. */
async function send(
  budget: ProbeBudget,
  url: string,
  method: Method,
  egress: EgressPolicy,
): Promise<Sent | null> {
  if (!budget.allows("quiet")) return null;
  // Aborted once the request is done (#766): cancelling a body does not close
  // the connection in Bun, which keeps downloading it until the signal fires.
  const done = new AbortController();
  const signal = AbortSignal.any([
    budget.signal(),
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
    done.signal,
  ]);
  const refused: Sent = {
    status: null,
    error: null,
    retryAfter: null,
    challenge: false,
    refused: true,
  };
  try {
    // Vetted before it counts: a refused request never leaves, so it spends no budget.
    await assertEgressAllowed(url, egress, signal);
  } catch (err) {
    if (err instanceof EgressRefusedError) return refused;
    return {
      status: null,
      error: err instanceof Error ? err.name || err.message : String(err),
      retryAfter: null,
      challenge: false,
    };
  }
  // Counted before the request leaves, so a request that fails still uses budget.
  budget.record();
  try {
    // Undecoded, so the runtime never inflates a compressed body it is about to
    // drop (#2717), and pinned to the vetted address by the egress guard.
    const res = await egressGuardedSend(fetchUndecoded, egress)(url, {
      method,
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: {
        "User-Agent": SQUIRRELSCAN_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    });
    await res.body?.cancel().catch(() => {});
    return {
      status: res.status,
      error: null,
      retryAfter: res.headers.get("retry-after"),
      challenge: res.headers.get("cf-mitigated") === "challenge",
    };
  } catch (err) {
    if (err instanceof EgressRefusedError) return refused;
    return {
      status: null,
      error: err instanceof Error ? err.name || err.message : String(err),
      retryAfter: null,
      challenge: false,
    };
  } finally {
    done.abort();
  }
}

/** The reason a probe was refused: passive by level, otherwise the budget. */
function refusalReason(budget: ProbeBudget | undefined): string {
  return !budget || budget.level === "passive" ? REASON_PASSIVE : REASON_BUDGET;
}

/** HEAD first; GET only when HEAD is refused (405/501) or fails at the network level. */
async function probeReach(
  budget: ProbeBudget,
  url: string,
  firstParty: boolean,
  egress: EgressPolicy,
): Promise<Reach> {
  const head = await send(budget, url, "HEAD", egress);
  if (head === null) return { kind: "unchecked", reason: refusalReason(budget) };
  let sent = head;
  if (!head.refused && (head.status === null || head.status === 405 || head.status === 501)) {
    const get = await send(budget, url, "GET", egress);
    if (get === null) return { kind: "unchecked", reason: refusalReason(budget) };
    sent = get;
  }
  return reachOf(sent, firstParty, true);
}

/** What the rule needs from outside: DNS, which tests replace. */
export interface BrokenFormsDeps {
  resolve?: ResolveHost;
}

/** The rule, with its resolver injectable for tests; {@link brokenFormsRule} uses the system one. */
export function createBrokenFormsRule(deps: BrokenFormsDeps = {}): Rule {
  const resolveHost = deps.resolve ?? resolveHostAddresses;
  return {
    meta: {
      id: "reliability/broken-forms",
      name: "Forms That Lose Submissions",
      description:
        "Checks that form fields are submitted (they have a name) and that form actions answer, not 404, a staging host or mailto:",
      solution:
        "A field without a name is never submitted, so its value is lost even though the visitor sees it filled in. Give every input, select and textarea a name that the handler reads. A form action that answers 404 or 410 loses every submission: point it at the endpoint that exists, or remove the form. Staging, preview, development and localhost hosts shipped to production lose submissions for every visitor: replace them with the production URL. A mailto: action only opens the visitor's mail client, so most submissions are lost: use a handler that stores or sends them.",
      category: "reliability",
      scope: "site",
      severity: "error",
      weight: 6,
    },

    async run(ctx: RuleContext): Promise<RuleResult> {
      const checks: CheckResult[] = [];
      const site: SiteData | undefined = ctx.site;

      if (!site?.pages) {
        checks.push({
          name: "broken-forms",
          status: "skipped",
          message: "Site data not available for form checks",
        });
        return { checks };
      }

      const siteHostName = hostOf(site.baseUrl);
      const siteIsHttps = /^https:/i.test(site.baseUrl);
      // Auditing localhost, a private-network box or a preview: some dev hosts are
      // then the site itself, not a leak (see devHostExpected).
      const siteLocality = localityOf(siteHostName);
      let siteOrigin: string | null = null;
      try {
        siteOrigin = new URL(site.baseUrl).origin;
      } catch {
        // No origin: no private exception.
      }
      const egress = probeEgressFor(siteHostName, siteOrigin, resolveHost);
      const crawled = new Map<string, number>();
      for (const page of site.pages) crawled.set(normalizeUrl(page.url), page.statusCode);
      const external = new Map<string, ExternalLinkCheckData>();
      for (const link of site.externalLinks ?? []) external.set(normalizeUrl(link.href), link);

      // Pass 1: read every page's DOM for forms, unnamed controls and action sources.
      let formCount = 0;
      const unnamed: UnnamedField[] = [];
      const sources: ActionSource[] = [];
      for (const page of site.pages) {
        const doc = page.parsed?.document;
        if (!doc) continue;
        const pageUrl = page.finalUrl || page.url;
        const forms: Element[] = [...doc.querySelectorAll("form")];
        formCount += forms.length;

        // The first form with each id wins, as the browser associates `form=` with it.
        const byId = new Map<string, Element>();
        for (const form of forms) {
          const id = form.getAttribute("id");
          if (id && !byId.has(id)) byId.set(id, form);
        }
        // `form=` overrides ancestry, and a `form=` that names no form owns nothing.
        const ownerOf = (el: Element): Element | null => {
          const attr = el.getAttribute("form");
          if (attr !== null) return byId.get(attr) ?? null;
          return el.closest("form");
        };
        const selectorOf = (form: Element): string => formSelector(form, forms.indexOf(form));

        const realAction = new Map<Element, string>();
        for (const form of forms) {
          const raw = form.getAttribute("action");
          if (raw !== null && hasRealAction(raw)) realAction.set(form, raw.trim());
        }

        for (const el of doc.querySelectorAll("input, select, textarea")) {
          if (!isNameable(el)) continue;
          if ((el.getAttribute("name") ?? "") !== "") continue;
          const owner = ownerOf(el);
          if (!owner) continue;
          unnamed.push({
            page: pageUrl,
            form: selectorOf(owner),
            hasAction: realAction.has(owner),
            field: fieldSelector(el),
            type: inputType(el),
            snippet: fieldSnippet(el, 200),
          });
        }

        for (const [form, raw] of realAction) {
          sources.push({ page: pageUrl, form: selectorOf(form), raw, attribute: "action" });
        }
        for (const el of doc.querySelectorAll(FORMACTION_SUBMITTERS)) {
          const raw = el.getAttribute("formaction");
          if (raw === null || !hasRealAction(raw)) continue;
          const owner = ownerOf(el);
          if (!owner) continue;
          sources.push({
            page: pageUrl,
            form: selectorOf(owner),
            raw: raw.trim(),
            attribute: "formaction",
          });
        }
      }

      // Pass 2: where each distinct action goes. One verdict per resolved URL.
      const dead = new Bucket();
      const probeMissing = new Bucket();
      const nonProduction = new Bucket();
      const mailto = new Bucket();
      const unreachable = new Bucket();
      const unverified = new Bucket();
      const unchecked = new Bucket();
      const uncheckedReasons = new Set<string>();
      const verdicts = new Map<string, Reach>();
      const quota: ProbeQuota = { total: 0, perSite: new Map(), byEndpoint: new Map() };

      // The site's own actions are probed before third-party ones, so a page full
      // of vendor forms cannot use up the probe quota ahead of them.
      const ordered = sources
        .map((source) => ({
          source,
          target: targetOf(source.raw, source.page, siteHostName, siteIsHttps, siteLocality),
        }))
        .sort(
          (a, b) =>
            Number(a.target.kind === "reach" && !a.target.firstParty) -
            Number(b.target.kind === "reach" && !b.target.firstParty),
        );
      for (const { source, target } of ordered) {
        if (target.kind === "skip") continue;
        // Site-controlled text (selectors, hrefs) goes into labels cut and escaped.
        const form = selectorSample(source.form);
        if (target.kind === "mailto") {
          mailto.add(
            stored(`${source.form}\n${target.href}`),
            `${form} submits with ${toSample(target.href)}: this opens the visitor's mail client and loses the submission otherwise`,
            source.page,
            { href: stored(target.href) },
          );
          continue;
        }
        const href = toSample(target.href);
        if (target.kind === "non-production") {
          nonProduction.add(
            stored(`${source.form}\n${target.href}`),
            `${form} submits to ${href} (${target.classification} host)`,
            source.page,
            {
              href: stored(target.href),
              host: stored(target.host),
              classification: target.classification,
            },
          );
          continue;
        }

        let reach = verdicts.get(target.href);
        if (!reach) {
          reach = await verdictFor(ctx, site, crawled, external, target, egress, quota);
          verdicts.set(target.href, reach);
        }
        const key = stored(`${source.form}\n${target.href}`);
        switch (reach.kind) {
          case "ok":
            break;
          case "dead":
            dead.add(
              key,
              `${form} submits to ${href} (HTTP ${reach.status}): submissions are lost`,
              source.page,
              { href: stored(target.href), status: reach.status },
            );
            break;
          case "probe-missing":
            probeMissing.add(
              key,
              `${form} submits to ${href} (HTTP ${reach.status} to a HEAD or GET probe): the endpoint may accept POST only`,
              source.page,
              { href: stored(target.href), status: reach.status },
            );
            break;
          case "unreachable":
            unreachable.add(key, `${form} submits to ${href} (${reach.detail})`, source.page, {
              href: stored(target.href),
              detail: reach.detail,
            });
            break;
          case "unverified":
            unverified.add(
              key,
              `${form} submits to ${href} (${reach.detail}): not verified, not reported as broken`,
              source.page,
              { href: stored(target.href), detail: reach.detail },
            );
            break;
          case "unchecked":
            uncheckedReasons.add(reach.reason);
            unchecked.add(
              key,
              `${form} submits to ${href}: not checked (${reach.reason})`,
              source.page,
              {
                href: stored(target.href),
                reason: reach.reason,
              },
            );
            break;
        }
      }

      // Pass 3: unnamed controls, split by whether the form posts to a real action.
      const unnamedWarn = new Bucket();
      const unnamedInfo = new Bucket();
      for (const field of unnamed) {
        const key = stored(`${field.form}\n${field.field}`);
        const fieldLabel = `${selectorSample(field.field)} (${selectorSample(field.type)}) in ${selectorSample(field.form)}`;
        if (field.hasAction) {
          unnamedWarn.add(
            key,
            `${fieldLabel} has no name, so the browser never submits it (a script on the page may still read it)`,
            field.page,
            {
              form: stored(field.form),
              field: stored(field.field),
              type: stored(field.type),
              snippet: field.snippet,
            },
          );
        } else {
          unnamedInfo.add(
            key,
            `${fieldLabel} has no name; the form has no action, so a script may read it`,
            field.page,
            {
              form: stored(field.form),
              field: stored(field.field),
              type: stored(field.type),
              snippet: field.snippet,
            },
          );
        }
      }

      if (dead.size > 0) {
        checks.push({
          name: "dead-form-action",
          status: "fail",
          message: `${dead.size} form action(s) answer 404 or 410: submissions are lost`,
          items: dead.toItems(),
          details: { count: dead.size },
        });
      }
      if (probeMissing.size > 0) {
        checks.push({
          name: "form-action-not-found-to-probe",
          status: "warn",
          message: `${probeMissing.size} form action(s) answer 404 or 410 to a HEAD or GET probe: the endpoint may accept POST only, or submissions are lost`,
          items: probeMissing.toItems(),
          details: { count: probeMissing.size },
        });
      }
      if (nonProduction.size > 0) {
        checks.push({
          name: "non-production-form-action",
          status: "warn",
          message: `${nonProduction.size} form action(s) point at a staging, preview, development or localhost host`,
          items: nonProduction.toItems(),
          details: { count: nonProduction.size },
        });
      }
      if (mailto.size > 0) {
        checks.push({
          name: "mailto-form-action",
          status: "warn",
          message: `${mailto.size} form action(s) use mailto:, which loses submissions unless the visitor's mail client sends them`,
          items: mailto.toItems(),
          details: { count: mailto.size },
        });
      }
      if (unreachable.size > 0) {
        checks.push({
          name: "unreachable-form-action",
          status: "warn",
          message: `${unreachable.size} form action(s) answer 5xx, fail at the network level, or are gone on a third-party host`,
          items: unreachable.toItems(),
          details: { count: unreachable.size },
        });
      }
      if (unnamedWarn.size > 0) {
        checks.push({
          name: "unnamed-form-fields",
          status: "warn",
          message: `${unnamedWarn.size} field(s) with no name in forms that post to an action: the browser does not submit them`,
          items: unnamedWarn.toItems(),
          details: { count: unnamedWarn.size },
        });
      }
      if (unnamedInfo.size > 0) {
        checks.push({
          name: "unnamed-form-fields-no-action",
          status: "info",
          message: `${unnamedInfo.size} field(s) with no name in forms without a real action: a script may read them, so they are not reported as broken`,
          items: unnamedInfo.toItems(),
          details: { count: unnamedInfo.size },
        });
      }
      if (unverified.size > 0) {
        checks.push({
          name: "unverified-form-actions",
          status: "info",
          message: `${unverified.size} form action(s) were throttled, challenged or returned 503 with Retry-After: unverified, not reported as broken`,
          items: unverified.toItems(),
          details: { count: unverified.size },
        });
      }
      if (unchecked.size > 0) {
        const reasons = [...uncheckedReasons].join("; ");
        checks.push({
          name: "unchecked-form-actions",
          status: "info",
          message: `${unchecked.size} form action(s) not checked: ${reasons}`,
          items: unchecked.toItems(),
          details: { count: unchecked.size, reasons: [...uncheckedReasons] },
        });
      }

      const hasProblem =
        dead.size +
          probeMissing.size +
          nonProduction.size +
          mailto.size +
          unreachable.size +
          unnamedWarn.size >
        0;
      if (formCount === 0) {
        checks.push({ name: "broken-forms", status: "info", message: "No forms detected" });
      } else if (
        !hasProblem &&
        unchecked.size === 0 &&
        unverified.size === 0 &&
        unnamedInfo.size === 0
      ) {
        checks.push({
          name: "broken-forms",
          status: "pass",
          message: `All ${formCount} form(s) name their fields and their actions answer`,
          value: formCount,
        });
      }

      return { checks };
    },
  };
}

export const brokenFormsRule: Rule = createBrokenFormsRule();

/**
 * The verdict for one resolved action URL: the crawl's status for a same-site
 * URL, the external checker's row for a third-party URL, or one probe.
 */
async function verdictFor(
  ctx: RuleContext,
  site: SiteData,
  crawled: Map<string, number>,
  external: Map<string, ExternalLinkCheckData>,
  target: { href: string; firstParty: boolean; plainHttp: boolean },
  egress: ProbeEgress,
  quota: ProbeQuota,
): Promise<Reach> {
  const { href, firstParty } = target;
  const normalized = normalizeUrl(href);

  if (firstParty) {
    const status = crawled.get(normalized);
    if (status !== undefined) {
      if (status === 0) return { kind: "unchecked", reason: "the crawl did not fetch it" };
      return reachOf({ status, error: null, retryAfter: null, challenge: false }, true);
    }
    if (target.plainHttp) return { kind: "unchecked", reason: REASON_PLAIN_HTTP };
    if (!ctx.probe || ctx.probe.level === "passive") {
      return { kind: "unchecked", reason: refusalReason(ctx.probe) };
    }
    const budget = ctx.probe;
    return probeWithinQuota(quota, href, () => probeReach(budget, href, true, egress.firstParty));
  }
  if (target.plainHttp) return { kind: "unchecked", reason: REASON_PLAIN_HTTP };

  // Third-party: only when external link checking ran for this audit.
  if (site.externalLinks === undefined) return { kind: "unchecked", reason: REASON_EXTERNAL_OFF };
  const link = external.get(normalized);
  if (link) {
    if (link.rateLimited === true || link.wafBlocked === true) {
      return {
        kind: "unverified",
        detail: link.status !== null ? `HTTP ${link.status}` : "throttled",
      };
    }
    if (link.status === null && link.error === null) {
      return { kind: "unchecked", reason: "the external check did not run" };
    }
    return reachOf(
      { status: link.status, error: link.error, retryAfter: null, challenge: false },
      false,
    );
  }
  if (!ctx.probe || ctx.probe.level === "passive") {
    return { kind: "unchecked", reason: refusalReason(ctx.probe) };
  }
  const budget = ctx.probe;
  return probeWithinQuota(quota, href, () => probeReach(budget, href, false, egress.thirdParty));
}
