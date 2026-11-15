// ax/agent-tasks - scripted, deterministic checks for the jobs a visitor's agent would do.
//
// No LLM, no goal seeking, no network. Every task is a fixed sequence over the crawled raw HTML:
// start page, bounded link following by a fixed heuristic, then assertions on the DOM. Same crawl in,
// same result out. Nothing is ever submitted, no account is created and no purchase is made.

import { z } from "zod";

import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";
import { getPathname, normalizeUrl } from "@squirrelscan/utils";

import { ruleApplies } from "../applicability";
import type { CheckResult, Rule, RuleContext, RuleResult, SiteData, RuleApplicability } from "../types";

export const TASK_IDS = ["find-contact", "reach-form", "find-price"] as const;
export type TaskId = (typeof TASK_IDS)[number];

const modeSchema = z.enum(["auto", "on", "off"]);

export const optionsSchema = z.object({
  /** Per-task override: `auto` follows the site type, `on` forces the task, `off` skips it. */
  tasks: z.partialRecord(z.enum(TASK_IDS), modeSchema).default({}),
  /** Most link clicks from the entry page to the contact route. */
  maxClicks: z.number().int().min(1).max(4).default(2),
});

type PageRec = SiteData["pages"][number];
type TaskResult = { result: "pass" | "fail" | "blocked"; step: string; message: string; url?: string };

const APPLIES: Record<TaskId, RuleApplicability | undefined> = {
  "find-contact": undefined,
  "reach-form": undefined,
  "find-price": { siteTypes: ["ecommerce", "saas", "marketplace", "agency", "smb_local"] },
};

const PRICE_PATH = /\/(?:pricing|prices?|plans?|products?|shop|store|buy|rates|packages)(?:\/|\.html?)?$/i;
// A currency symbol or code next to an amount, in either order. Plain integers are not prices.
const PRICE_TEXT =
  /(?:[$€£¥₹]\s?\d[\d.,]*|\b(?:USD|EUR|GBP|AUD|CAD|NZD|JPY|INR)\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|EUR|GBP|AUD|CAD|NZD|JPY|INR)\b)/;
const PHONE_TEXT = /(?:\+\d[\d\s().-]{7,}\d|\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b)/;
const CHALLENGE_SELECTOR =
  ".g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile']";
const LOGIN_PATH = /\/(?:log-?in|sign-?in|signin|account|auth|sso)(?:\/|\.html?)?$/i;
const BOT_WALL_STATUS = new Set([401, 403, 429, 503]);
const BOT_WALL_TITLE = /just a moment|attention required|access denied|verify you are human|are you a robot/i;

const key = (url: string): string => normalizeUrl(url.split("#")[0] ?? url);

function isContactUrl(url: string): boolean {
  return EEAT_PAGE_PATTERNS.contact.some((p) => p.test(getPathname(url)));
}

function isBotWall(page: PageRec): boolean {
  if (BOT_WALL_STATUS.has(page.statusCode)) return true;
  return BOT_WALL_TITLE.test(page.parsed?.meta?.title ?? "") && page.statusCode < 400;
}

function isUsable(page: PageRec): boolean {
  return !page.redirectSource && page.statusCode >= 200 && page.statusCode < 300 && !!page.parsed?.document;
}

function entryPage(site: SiteData, byKey: Map<string, PageRec>): PageRec | undefined {
  for (const u of [...(site.entryUrls ?? []), site.baseUrl]) {
    const hit = byKey.get(key(u));
    if (hit) return hit;
  }
  return site.pages.find((p) => !p.redirectSource);
}

type Route = { page?: PageRec; url: string; clicks: number; blocked: boolean };

/** Breadth-first over internal links of crawled pages, in document order, ties broken by URL. */
function findContactRoute(
  start: PageRec,
  byKey: Map<string, PageRec>,
  maxClicks: number,
): Route | null {
  const seen = new Set([key(start.url)]);
  let frontier: PageRec[] = [start];
  if (isContactUrl(start.url)) return { page: start, url: start.url, clicks: 0, blocked: false };
  for (let clicks = 1; clicks <= maxClicks; clicks++) {
    const next: PageRec[] = [];
    const targets: string[] = [];
    for (const page of frontier) {
      for (const link of page.parsed?.links ?? []) {
        if (!link.isInternal) continue;
        const k = key(link.url);
        if (seen.has(k)) continue;
        seen.add(k);
        targets.push(link.url);
      }
    }
    targets.sort();
    for (const url of targets) {
      const page = byKey.get(key(url));
      const schemaHit = !!page?.parsed?.schemas?.hasType?.("ContactPage");
      if (isContactUrl(url) || schemaHit) {
        return { page, url, clicks, blocked: !!page && isBotWall(page) };
      }
      if (page) next.push(page);
    }
    frontier = next;
  }
  return null;
}

function formsOf(page: PageRec): Element[] {
  const doc = page.parsed?.document;
  if (!doc) return [];
  return Array.from(doc.querySelectorAll("form")).filter((f) => {
    const role = f.getAttribute("role");
    return role !== "search" && !f.querySelector("input[type=search]");
  });
}

const FIELD_SELECTOR = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), textarea, select";

function isLabelled(el: Element, form: Element): boolean {
  if (el.getAttribute("aria-label")?.trim() || el.getAttribute("aria-labelledby")?.trim()) return true;
  if (el.getAttribute("title")?.trim()) return true;
  const id = el.getAttribute("id");
  if (id) {
    for (const l of Array.from(form.ownerDocument?.querySelectorAll("label[for]") ?? [])) {
      if (l.getAttribute("for") === id && l.textContent?.trim()) return true;
    }
  }
  const wrap = el.closest("label");
  return !!wrap?.textContent?.trim();
}

function assessForm(page: PageRec): TaskResult {
  const forms = formsOf(page);
  if (isBotWall(page)) return { result: "blocked", step: "load-page", message: "A bot wall answered before the form could be read", url: page.url };
  const withFields = forms
    .map((form) => ({ form, fields: Array.from(form.querySelectorAll(FIELD_SELECTOR)) }))
    .filter((f) => f.fields.length > 0);
  if (withFields.length === 0) {
    return { result: "fail", step: "find-form", message: "No form with fields in the served HTML", url: page.url };
  }
  // Primary form: most fields, first in the document on a tie.
  const primary = withFields.reduce((best, f) => (f.fields.length > best.fields.length ? f : best));
  if (primary.fields.some((f) => f.getAttribute("type")?.toLowerCase() === "password") || LOGIN_PATH.test(getPathname(page.url))) {
    return { result: "fail", step: "no-login", message: "The form sits behind a login", url: page.url };
  }
  const unlabelled = primary.fields.filter((f) => !isLabelled(f, primary.form));
  if (unlabelled.length > 0) {
    return { result: "fail", step: "labelled-fields", message: `${unlabelled.length} of ${primary.fields.length} fields have no label`, url: page.url };
  }
  const challenge = primary.form.querySelector(CHALLENGE_SELECTOR) ?? page.parsed.document?.querySelector(CHALLENGE_SELECTOR);
  if (challenge) {
    const first = primary.fields[0]!;
    // Challenge before the first field in document order (DOCUMENT_POSITION_FOLLOWING = 4).
    if ((first.compareDocumentPosition(challenge) & 4) === 0 && !challenge.contains(first)) {
      return { result: "fail", step: "challenge-before-field", message: "A visible challenge comes before the first field", url: page.url };
    }
  }
  return { result: "pass", step: "done", message: "Form renders without login, with labelled fields", url: page.url };
}

function runFindContact(site: SiteData, byKey: Map<string, PageRec>, maxClicks: number): { contact: TaskResult; route: Route | null } {
  const start = entryPage(site, byKey);
  if (!start) return { contact: { result: "fail", step: "load-entry", message: "No entry page was crawled" }, route: null };
  if (isBotWall(start)) {
    return { contact: { result: "blocked", step: "load-entry", message: "A bot wall answered the entry page", url: start.url }, route: null };
  }
  const route = findContactRoute(start, byKey, maxClicks);
  if (!route) {
    return {
      contact: { result: "fail", step: "find-route", message: `No contact route within ${maxClicks} clicks of the entry page`, url: start.url },
      route: null,
    };
  }
  if (route.blocked) return { contact: { result: "blocked", step: "load-route", message: "A bot wall answered the contact page", url: route.url }, route };
  const pages = [route.page, start].filter((p): p is PageRec => !!p);
  const contacts = pages.flatMap((p) => p.parsed.contactLinks ?? []);
  const hasMailto = contacts.some((c) => c.scheme === "mailto");
  const hasTel = contacts.some((c) => c.scheme === "tel");
  const hasForm = route.page ? formsOf(route.page).some((f) => f.querySelector(FIELD_SELECTOR)) : false;
  if (route.page && !isUsable(route.page)) {
    return { contact: { result: "fail", step: "load-route", message: "The contact page did not serve HTML", url: route.url }, route };
  }
  if (!route.page) {
    return { contact: { result: "fail", step: "load-route", message: "The contact link was not crawled, so its methods were not read", url: route.url }, route };
  }
  const text = route.page.parsed.document?.body?.textContent ?? "";
  if (!hasTel && PHONE_TEXT.test(text)) {
    return { contact: { result: "fail", step: "phone-link", message: "A phone number is shown as plain text, not a tel: link", url: route.url }, route };
  }
  if (!hasMailto && !hasForm) {
    return { contact: { result: "fail", step: "email-or-form", message: "No mailto: link and no form on the contact page", url: route.url }, route };
  }
  
  return { contact: { result: "pass", step: "done", message: `Contact route reachable in ${route.clicks} click${route.clicks === 1 ? "" : "s"}`, url: route.url }, route };
}

function runFindPrice(site: SiteData, byKey: Map<string, PageRec>): TaskResult {
  const candidates = site.pages
    .filter((p) => !p.redirectSource && (PRICE_PATH.test(getPathname(p.url)) || p.parsed?.pageType === "product"))
    .sort((a, b) => a.url.localeCompare(b.url));
  if (candidates.length === 0) {
    const start = entryPage(site, byKey);
    return { result: "fail", step: "find-page", message: "No pricing or product page was crawled", url: start?.url };
  }
  const usable = candidates.filter((p) => !isBotWall(p) && isUsable(p));
  if (usable.length === 0) {
    return { result: "blocked", step: "load-page", message: "A bot wall answered the pricing page", url: candidates[0]!.url };
  }
  for (const p of usable) {
    const text = p.parsed.document?.body?.textContent ?? "";
    const raw = p.parsed.schemas?.raw ?? "";
    if (PRICE_TEXT.test(text) || /"price"\s*:\s*"?\d/.test(raw)) {
      return { result: "pass", step: "done", message: "A price is present in the served HTML", url: p.url };
    }
  }
  return { result: "fail", step: "price-in-html", message: "No price in the served HTML (it may only appear after script runs)", url: usable[0]!.url };
}

function toCheck(task: TaskId, r: TaskResult): CheckResult {
  const status = r.result === "pass" ? "pass" : r.result === "blocked" ? "skipped" : "info";
  const prefix = r.result === "pass" ? "passed" : r.result === "blocked" ? "blocked" : `failed at ${r.step}`;
  return {
    name: task,
    status,
    message: `Task ${task} ${prefix}: ${r.message}`,
    value: r.result,
    details: { task, result: r.result, step: r.step, url: r.url ?? null },
  };
}

export const agentTasksRule: Rule = {
  meta: {
    id: "ax/agent-tasks",
    name: "Agent Tasks",
    description:
      "Scripted, deterministic checks for jobs a visitor's agent does on your site: find a contact route, reach the form, find a price",
    solution:
      "Each task is a fixed script over the crawled HTML with no LLM and no submission. find-contact follows internal links up to the click budget and expects a contact page with a tel: link for any phone number and a mailto: link or a form. reach-form expects the primary form to need no login, to have labelled fields and to show no challenge before the first field. find-price (shops, SaaS and similar sites) expects a price in the served HTML of the pricing or product page, not only after JavaScript runs. A task reports pass, fail with the step that failed, or blocked when a bot wall answered. Results are advisory and never change the score. Force a task on or off with [rule_options.\"ax/agent-tasks\"] tasks.",
    category: "ax",
    scope: "site",
    severity: "info",
    weight: 1,
    optionsSchema,
    checks: [
      ...TASK_IDS.flatMap((t) => [{ name: t, outcome: "problem" as const }]),
      { name: "agent-tasks", outcome: "clean", clears: [...TASK_IDS] },
      { name: "agent-tasks-skipped", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const options = optionsSchema.parse(ctx.options);
    const site = ctx.site;
    if (!site || site.pages.length === 0) {
      return { checks: [{ name: "agent-tasks-skipped", status: "skipped", message: "No pages available for analysis" }] };
    }
    const byKey = new Map<string, PageRec>();
    for (const p of site.pages) if (!p.redirectSource) byKey.set(key(p.url), p);

    const enabled: TaskId[] = [];
    const skips: CheckResult[] = [];
    for (const task of TASK_IDS) {
      const mode = options.tasks[task] ?? "auto";
      if (mode === "off") {
        skips.push({ name: task, status: "skipped", message: `Task ${task} skipped: turned off for this site`, value: "off" });
        continue;
      }
      if (mode === "auto") {
        const verdict = ruleApplies(APPLIES[task], ctx.siteMetadata);
        if (!verdict.applies) {
          skips.push({ name: task, status: "skipped", message: `Task ${task} skipped: ${verdict.reason}`, value: "not-applicable" });
          continue;
        }
        // Without a resolved profile a priced-site task cannot be gated, so it stays off unless forced.
        if (APPLIES[task]?.siteTypes && !ctx.siteMetadata) {
          skips.push({ name: task, status: "skipped", message: `Task ${task} skipped: the site type is unknown (force it on to run it)`, value: "not-applicable" });
          continue;
        }
      }
      enabled.push(task);
    }

    const checks: CheckResult[] = [];
    const contact = enabled.includes("find-contact") || enabled.includes("reach-form")
      ? runFindContact(site, byKey, options.maxClicks)
      : null;
    if (enabled.includes("find-contact") && contact) checks.push(toCheck("find-contact", contact.contact));
    if (enabled.includes("reach-form")) {
      const start = entryPage(site, byKey);
      const target = contact?.route?.page ?? (start && formsOf(start).length > 0 ? start : undefined);
      checks.push(
        toCheck(
          "reach-form",
          target
            ? assessForm(target)
            : contact?.contact.result === "blocked"
              ? { result: "blocked", step: "load-page", message: "A bot wall answered before a form page was reached" }
              : { result: "fail", step: "find-form", message: "No page with a form was reached" },
        ),
      );
    }
    if (enabled.includes("find-price")) checks.push(toCheck("find-price", runFindPrice(site, byKey)));
    checks.push(...skips);
    if (checks.length === 0) {
      checks.push({ name: "agent-tasks-skipped", status: "skipped", message: "Every agent task is turned off" });
    }
    return { checks };
  },
};
