// content/terminology-consistency - the same concept called by different names across the site
//
// An agent (or a visitor) told to "log in" has to match that against the labels on the page. A site
// that says "Sign in" in the header, "Log in" on the pricing page and "Login" in the footer makes
// that match unreliable. This rule counts the spellings of a few concepts on every page, sums them
// site-wide and reports the minority spellings against the dominant one.
//
// Concept groups (the shipped variant table, TERM_GROUPS):
//   - sign in / log in / login / signin (hyphenated forms fold into the spaced ones)
//   - email / e-mail
//   - sign up / signup / register / create account
//   - FAQ / FAQs / Faq (case-sensitive: FAQ and Faq are the variants)
//   - the product name's casing (lowercase, Title, UPPER, camel), where the name is the page's
//     og:site_name and is one word
//
// Known limits, kept simple on purpose: "login" is also a noun ("the login page") and is counted as
// the variant it spells; "register" and "sign up" are counted wherever they appear, not only when
// they mean "create an account"; a word inside a URL or an email address is never counted.
//
// Per-page data is ONE bounded map on `page_features.terminology_variants` (variant key to a
// capped count, at most TERM_KEY_COUNT keys, no raw text). Both paths feed ONE accumulator and ONE
// check builder, and the legacy path derives the map with the SAME function the streaming engine
// stores (pageTerminologyVariants), so the output is byte-identical by construction (the same
// shape as content/voice-consistency).
//
// Guards:
//   1. Site floor (TERM_MIN_PAGES): a small crawl has no convention.
//   2. Group floor (TERM_MIN_OCCURRENCES uses on TERM_MIN_GROUP_PAGES pages): too little text to vote.
//   3. Agreement (TERM_MIN_AGREEMENT): the dominant spelling needs 70% of the group's uses. A site
//      that splits its wording has no norm, and nothing in the group is a deviant.
//   4. Error pages and noindex pages on an indexable site do not vote, as in the other site rules.
//
// Scoring: one site check, weight 2, at most TERM_MAX_ITEMS items. warn when one or two groups have
// minority spellings; fail when TERM_FAIL_GROUPS or more groups do (the site has no single voice for
// its own interface words). Light enough that it cannot dominate the content category.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { CheckItem, SiteQuery } from "@squirrelscan/core-contracts";
import type { Element } from "linkedom";

import { collectTextExcluding, tagExcluder } from "@squirrelscan/parser/extractors";

import { excludesNoindexPage, skipsNoindexPages } from "../shared/noindex";

/** Crawl-wide page floor: below this there is no site convention to judge against. */
export const TERM_MIN_PAGES = 10;

/** A group needs this many uses site-wide before its dominant spelling is trusted. */
export const TERM_MIN_OCCURRENCES = 10;

/** ...spread over at least this many pages (one page repeating a word is not a convention). */
export const TERM_MIN_GROUP_PAGES = 3;

/** Share of a group's uses the dominant spelling needs for a norm to exist. */
export const TERM_MIN_AGREEMENT = 0.7;

/** This many groups with minority spellings turns the warning into a failure. */
export const TERM_FAIL_GROUPS = 3;

/** Per-page cap on one variant's stored count. */
export const TERM_COUNT_CAP = 255;

const TERM_MAX_ITEMS = 8;
const TERM_MAX_URLS = 10;
const CHECK_NAME = "terminology-consistency";

interface TermVariant {
  /** Short, stable id: the storage key is `${group.id}.${key}`. */
  key: string;
  /** What the message shows for this spelling. */
  label: string;
  pattern: RegExp;
}

interface TermGroup {
  id: string;
  /** The concept, for the message. */
  label: string;
  variants: TermVariant[];
}

const W_START = String.raw`(?<![\p{L}\p{N}_-])`;
const W_END = String.raw`(?![\p{L}\p{N}_])`;
const re = (source: string, flags = "giu"): RegExp => new RegExp(`${W_START}${source}${W_END}`, flags);

/** The shipped variant table. The brand group is handled apart: its words come from the page. */
export const TERM_GROUPS: readonly TermGroup[] = [
  {
    id: "signin",
    label: "sign in",
    variants: [
      { key: "sign_in", label: "Sign in", pattern: re(String.raw`sign[\s-]+in`) },
      { key: "log_in", label: "Log in", pattern: re(String.raw`log[\s-]+in`) },
      { key: "login", label: "Login", pattern: re("login") },
      { key: "signin", label: "Signin", pattern: re("signin") },
    ],
  },
  {
    id: "email",
    label: "email",
    variants: [
      { key: "email", label: "Email", pattern: re("emails?") },
      { key: "e_mail", label: "E-mail", pattern: re("e-mails?") },
    ],
  },
  {
    id: "signup",
    label: "sign up",
    variants: [
      { key: "sign_up", label: "Sign up", pattern: re(String.raw`sign[\s-]+up`) },
      { key: "signup", label: "Signup", pattern: re("signup") },
      { key: "register", label: "Register", pattern: re("register") },
      {
        key: "create_account",
        label: "Create account",
        pattern: re(String.raw`create\s+(?:an?\s+|your\s+|a\s+new\s+)?account`),
      },
    ],
  },
  {
    id: "faq",
    label: "FAQ",
    variants: [
      { key: "upper", label: "FAQ", pattern: re("FAQ", "gu") },
      { key: "upper_s", label: "FAQs", pattern: re("FAQs", "gu") },
      { key: "other", label: "Faq", pattern: re("[Ff]aqs?", "gu") },
    ],
  },
];

/** Casing shapes of the product name. Stored as `brand.<shape>`. */
const BRAND_SHAPES: readonly { key: string; label: string }[] = [
  { key: "lower", label: "lowercase" },
  { key: "title", label: "Title case" },
  { key: "upper", label: "UPPERCASE" },
  { key: "camel", label: "camelCase" },
];

const BRAND_GROUP: TermGroup = {
  id: "brand",
  label: "product name casing",
  variants: BRAND_SHAPES.map((s) => ({ key: s.key, label: s.label, pattern: /(?!)/u })),
};

const ALL_GROUPS: readonly TermGroup[] = [...TERM_GROUPS, BRAND_GROUP];

/** Every storage key the column can hold: its bound. */
export const TERM_KEYS: readonly string[] = ALL_GROUPS.flatMap((g) => g.variants.map((v) => `${g.id}.${v.key}`));
export const TERM_KEY_COUNT = TERM_KEYS.length;

const BRAND_TOKEN = /^[\p{L}\p{N}]{4,30}$/u;

// Inline formatting does not break a phrase: `Sign <b>in</b>` is still "Sign in". Every other
// element (links, buttons, cells, blocks) is a boundary, so `<a>Sign in</a><a>Log in</a>` does not glue.
const INLINE = new Set(["span", "b", "strong", "em", "i", "u", "small", "mark", "abbr", "sub", "sup", "wbr", "font"]);
const isNonText = tagExcluder(new Set(["script", "style", "noscript", "code", "pre", "samp", "kbd", "template"]));
const isBoundary = (el: Element): boolean => !INLINE.has(el.tagName.toLowerCase());

const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b[\w-]+(?:\.[\w-]+)+\/\S*/giu;

function countMatches(text: string, pattern: RegExp): number {
  let n = 0;
  for (const _m of text.matchAll(pattern)) n += 1;
  return n;
}

function brandShape(word: string): string | null {
  const lower = word.toLowerCase();
  const upper = word.toUpperCase();
  if (lower === upper) return null;
  if (word === lower) return "lower";
  if (word === upper) return "upper";
  if (word[0] === upper[0] && word.slice(1) === lower.slice(1)) return "title";
  return "camel";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * The variant counts of one page, or null when none of the tracked spellings occur. Keys are the
 * fixed ids in TERM_KEYS, values are capped at TERM_COUNT_CAP: bounded by the table, never raw text.
 * The one computation behind the stored `page_features.terminology_variants` and the legacy path.
 */
export function pageTerminologyVariants(
  parsed: { document?: Document | null; og?: { siteName?: string | null } | null } | null | undefined,
): Record<string, number> | null {
  const body = parsed?.document?.querySelector("body");
  if (!body) return null;
  const raw = collectTextExcluding(body as unknown as Element, isNonText, "\n", isBoundary);
  const text = raw.replace(URL_LIKE, " ");
  const out: Record<string, number> = {};
  const add = (key: string, n: number): void => {
    if (n > 0) out[key] = Math.min(TERM_COUNT_CAP, n);
  };

  for (const group of TERM_GROUPS) {
    for (const v of group.variants) add(`${group.id}.${v.key}`, countMatches(text, v.pattern));
  }

  const brand = parsed?.og?.siteName?.trim();
  if (brand && BRAND_TOKEN.test(brand) && brandShape(brand) !== null) {
    // Not part of a hostname or address: "acme.com" or "@acme" says nothing about the name's casing.
    const pattern = new RegExp(`(?<![.@/])${W_START}${escapeRegExp(brand)}${W_END}(?!\\.[\\p{L}\\p{N}])`, "giu");
    const shapes: Record<string, number> = {};
    for (const m of text.matchAll(pattern)) {
      const idx = m.index ?? 0;
      const shape = brandShape(m[0]);
      if (!shape) continue;
      // A leading capital at the start of a sentence, heading, link or button says nothing about the
      // brand's own casing, so a Title-case match there is not counted (camelCase or UPPER still is).
      // Element boundaries are newlines in the collected text.
      const before = text.slice(Math.max(0, idx - 8), idx);
      const sentenceStart = (idx < 8 && before.trim() === "") || /(?:[.!?]\s+|\n[^\S\n]*)$/u.test(before);
      if (sentenceStart && shape === "title") continue;
      shapes[shape] = (shapes[shape] ?? 0) + 1;
    }
    for (const [shape, n] of Object.entries(shapes)) add(`brand.${shape}`, n);
  }

  return Object.keys(out).length > 0 ? out : null;
}

interface TermPageRecord {
  url: string;
  status: number;
  variants: Record<string, number> | null;
  excluded?: boolean;
}

interface VariantTally {
  uses: number;
  urls: string[];
}

interface TermRollup {
  pageCount: number;
  skippedNoindexPages: number;
  tallies: Map<string, VariantTally>;
  groupPages: Map<string, number>;
}

function emptyRollup(): TermRollup {
  return { pageCount: 0, skippedNoindexPages: 0, tallies: new Map(), groupPages: new Map() };
}

function accumulatePage(rollup: TermRollup, record: TermPageRecord): void {
  rollup.pageCount += 1;
  if (record.excluded) {
    rollup.skippedNoindexPages += 1;
    return;
  }
  if (record.status < 200 || record.status >= 300 || !record.variants) return;
  const seenGroups = new Set<string>();
  for (const group of ALL_GROUPS) {
    for (const v of group.variants) {
      const key = `${group.id}.${v.key}`;
      const n = record.variants[key];
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) continue;
      const tally = rollup.tallies.get(key) ?? { uses: 0, urls: [] };
      tally.uses += n;
      tally.urls.push(record.url);
      rollup.tallies.set(key, tally);
      seenGroups.add(group.id);
    }
  }
  for (const id of seenGroups) rollup.groupPages.set(id, (rollup.groupPages.get(id) ?? 0) + 1);
}

function skip(message: string, rollup?: TermRollup): CheckResult {
  return {
    name: CHECK_NAME,
    status: "skipped",
    message,
    ...(rollup ? { details: { skippedNoindexPages: rollup.skippedNoindexPages } } : {}),
  };
}

type GroupState = "insufficient" | "no-norm" | "consistent" | "deviant";

interface GroupVerdict {
  group: TermGroup;
  state: GroupState;
  uses: number;
  pages: number;
  dominant?: TermVariant;
  share?: number;
  minorities: { variant: TermVariant; uses: number; urls: string[] }[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function judgeGroup(rollup: TermRollup, group: TermGroup): GroupVerdict {
  let uses = 0;
  for (const v of group.variants) uses += rollup.tallies.get(`${group.id}.${v.key}`)?.uses ?? 0;
  const pages = rollup.groupPages.get(group.id) ?? 0;
  const base = { group, uses, pages, minorities: [] as GroupVerdict["minorities"] };
  if (uses < TERM_MIN_OCCURRENCES || pages < TERM_MIN_GROUP_PAGES) return { ...base, state: "insufficient" };

  let dominant = group.variants[0]!;
  let best = -1;
  for (const v of group.variants) {
    const n = rollup.tallies.get(`${group.id}.${v.key}`)?.uses ?? 0;
    if (n > best) {
      best = n;
      dominant = v;
    }
  }
  const share = best / uses;
  if (share < TERM_MIN_AGREEMENT) return { ...base, state: "no-norm", dominant, share };

  const minorities: GroupVerdict["minorities"] = [];
  for (const v of group.variants) {
    if (v === dominant) continue;
    const tally = rollup.tallies.get(`${group.id}.${v.key}`);
    if (!tally) continue;
    minorities.push({ variant: v, uses: tally.uses, urls: [...tally.urls].sort(cmp) });
  }
  return { ...base, state: minorities.length > 0 ? "deviant" : "consistent", dominant, share, minorities };
}

function buildChecks(rollup: TermRollup, sitePageCount: number): CheckResult[] {
  if (sitePageCount < TERM_MIN_PAGES) {
    return [
      skip(`Only ${sitePageCount} page(s) crawled; ${TERM_MIN_PAGES} needed to establish the site's terminology`, rollup),
    ];
  }

  const verdicts = ALL_GROUPS.map((g) => judgeGroup(rollup, g));
  const judged = verdicts.filter((v) => v.state !== "insufficient");
  if (judged.length === 0) {
    return [skip("Too little sign-in, email, sign-up, FAQ or product-name wording to establish a site convention", rollup)];
  }
  const deviants = verdicts.filter((v) => v.state === "deviant");
  if (deviants.length === 0 && judged.every((v) => v.state === "no-norm")) {
    return [skip("The site's wording does not settle on one spelling for any concept, so no page is a deviant", rollup)];
  }

  const details: Record<string, unknown> = {
    groups: verdicts.map((v) => ({
      group: v.group.id,
      state: v.state,
      uses: v.uses,
      pages: v.pages,
      ...(v.dominant ? { dominant: v.dominant.label, agreement: Math.round((v.share ?? 0) * 100) } : {}),
    })),
    skippedNoindexPages: rollup.skippedNoindexPages,
  };

  if (deviants.length === 0) {
    return [
      {
        name: CHECK_NAME,
        status: "pass",
        message: `${judged.length} concept(s) are worded consistently across the site`,
        value: judged.length,
        details,
      },
    ];
  }

  const items: CheckItem[] = [];
  const flagged = new Set<string>();
  for (const v of deviants) {
    const pct = Math.round((v.share ?? 0) * 100);
    for (const m of v.minorities) {
      for (const url of m.urls) flagged.add(url);
      items.push({
        id: `${v.group.id}.${m.variant.key}`,
        label: `Uses "${m.variant.label}" where the site mostly says "${v.dominant!.label}" (${pct}% of ${v.uses} uses)`,
        sourcePages: m.urls.slice(0, TERM_MAX_URLS),
        meta: { dominant: v.dominant!.label, minority: m.variant.label, pages: m.urls.length, uses: m.uses },
      });
    }
  }
  const first = deviants[0]!;
  const firstMinor = first.minorities[0]!;
  const more = deviants.length > 1 ? ` and ${deviants.length - 1} more concept(s)` : "";
  return [
    {
      name: CHECK_NAME,
      status: deviants.length >= TERM_FAIL_GROUPS ? "fail" : "warn",
      message: `${flagged.size} page(s) use different words for the same thing: "${firstMinor.variant.label}" where the site mostly says "${first.dominant!.label}"${more}`,
      value: flagged.size,
      items: items.slice(0, TERM_MAX_ITEMS),
      details: { ...details, flaggedPages: flagged.size },
    },
  ];
}

async function runViaSiteQuery(siteQuery: SiteQuery, skipNoindex: boolean): Promise<RuleResult> {
  const rollup = emptyRollup();
  for await (const row of siteQuery.pagesMatching(() => true)) {
    accumulatePage(rollup, {
      url: row.normalizedUrl,
      status: row.status,
      variants: row.terminologyVariants ?? null,
      excluded: skipNoindex && row.robotsNoindex,
    });
  }
  return { checks: buildChecks(rollup, siteQuery.pageCount()) };
}

export const terminologyConsistencyRule: Rule = {
  meta: {
    id: "content/terminology-consistency",
    name: "Terminology Consistency",
    description: "Finds pages that use a different word for the same thing than the rest of the site (sign in vs log in, email vs e-mail)",
    solution:
      "A site that says 'Sign in' on one page, 'Log in' on another and 'Login' in the footer makes it harder for visitors, and for an agent asked to 'log in', to find the control. Pick one spelling for each concept, usually the one the site already uses most, and change the minority uses to match: button labels, links, headings and body copy. The same applies to 'email' against 'e-mail', 'sign up' against 'register' or 'create account', 'FAQ' against 'FAQs' or 'Faq', and the casing of your product name. 'Login' is also a noun ('the login page'), so a deliberate noun use is fine; the rule only reports when one spelling clearly dominates.",
    category: "content",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.siteQuery) {
      return runViaSiteQuery(ctx.siteQuery, skipsNoindexPages(ctx.site));
    }

    const pages = ctx.site?.pages;
    if (!pages || pages.length === 0) {
      return { checks: [skip("No pages available for analysis")] };
    }

    const rollup = emptyRollup();
    for (const page of pages) {
      accumulatePage(rollup, {
        url: page.url,
        status: page.statusCode,
        variants: pageTerminologyVariants(page.parsed),
        excluded: excludesNoindexPage(ctx.site, page.parsed, page.headers),
      });
    }
    return { checks: buildChecks(rollup, rollup.pageCount) };
  },
};
