// Deterministic synthetic site model generator — the shared core both HTTP
// mode (server.ts) and direct-storage mode (storage-writer.ts) build on.
//
// Determinism contract: generateSiteModel(opts) with the same `opts.seed` and
// the same other options always returns a bit-for-bit identical SiteModel.
// Every random choice pulls from a single seeded Rng stream in a fixed code
// order — never Date.now()/Math.random().
//
// Memory contract: PageModel never holds rendered HTML. A 25k-page model with
// large per-page target sizes stays cheap — HTML is rendered lazily per page
// from its own seedTag (html-render.ts), on demand, in either mode.

import type {
  DuplicateGroupSpec,
  GenerateSiteModelOptions,
  IssueMixOptions,
  IssueSpec,
  IssueTag,
  PageModel,
  PageTemplate,
  RedirectChainSpec,
  ResolvedIssueMixOptions,
  ResolvedSiteOptions,
  SiteModel,
} from "./types";

import {
  DEFAULT_CLEAN_RATIO,
  DEFAULT_MAX_PAGE_SIZE_BYTES,
  DEFAULT_MIN_PAGE_SIZE_BYTES,
  DEFAULT_TEMPLATE_COUNT,
  LONG_H1_MIN_LENGTH,
  LONG_URL_MIN_LENGTH,
  OVERSIZE_DESCRIPTION_MIN_LENGTH,
  OVERSIZE_TITLE_MIN_LENGTH,
  RESERVED_BROKEN_LINK_PREFIX,
  RESERVED_REDIRECT_CHAIN_PREFIX,
} from "./constants";
import { ADJECTIVES, NOUNS, TOPICS, VERBS } from "./lexicon";
import {
  createRng,
  deriveSeed,
  hashStringHex,
  pickExcluding,
  pickFewExcluding,
  pickIndices,
  pickSubset,
  rngInt,
  rngPick,
  type Rng,
} from "./prng";

const TEMPLATE_KINDS = [
  "category",
  "product",
  "blog",
  "static",
  "landing",
  "docs",
  "support",
] as const;

const ISSUE_TAGS: IssueTag[] = [
  "long-h1",
  "oversize-title",
  "oversize-description",
  "long-url",
  "duplicate-title",
  "duplicate-description",
  "orphan",
  "redirect-chain",
  "broken-link",
  "noindex-in-sitemap",
  "clean",
];

function emptyIssueSummary(): Record<IssueTag, number> {
  const summary = {} as Record<IssueTag, number>;
  for (const tag of ISSUE_TAGS) summary[tag] = 0;
  return summary;
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

function resolveIssueSpec(
  spec: IssueSpec | undefined | false,
  pageCount: number,
  defaultRatio: number,
): { count: number } {
  if (spec === false) return { count: 0 };
  if (spec?.count !== undefined) return { count: Math.max(0, Math.floor(spec.count)) };
  if (spec?.ratio !== undefined) return { count: Math.max(0, Math.round(pageCount * spec.ratio)) };
  return { count: Math.max(0, Math.round(pageCount * defaultRatio)) };
}

// "at least 1" only applies while the ratio scale is actually nonzero —
// cleanRatio:1 (ratioScale 0) must be able to reach truly zero defaults, not
// get floored back up to a single group/chain.
function defaultCountFromRatio(pageCount: number, ratio: number, ratioScale: number): number {
  if (ratioScale <= 0) return 0;
  return Math.max(1, Math.round(pageCount * ratio * ratioScale));
}

function resolveDuplicateSpec(
  spec: DuplicateGroupSpec | undefined | false,
  pageCount: number,
  ratioScale: number,
): { groupCount: number; groupSize: number } {
  if (spec === false) return { groupCount: 0, groupSize: 0 };
  const groupCount = spec?.groupCount ?? defaultCountFromRatio(pageCount, 0.01, ratioScale);
  const groupSize = spec?.groupSize ?? 3;
  return { groupCount: Math.max(0, groupCount), groupSize: Math.max(2, groupSize) };
}

function resolveRedirectChainSpec(
  spec: RedirectChainSpec | undefined | false,
  pageCount: number,
  ratioScale: number,
): { count: number; chainLength: number } {
  if (spec === false) return { count: 0, chainLength: 0 };
  const count = spec?.count ?? defaultCountFromRatio(pageCount, 0.005, ratioScale);
  const chainLength = Math.max(1, spec?.chainLength ?? 3);
  return { count: Math.max(0, count), chainLength };
}

// Default per-issue ratios below were tuned against a reference cleanRatio of
// 0.5 — scale them so `cleanRatio` actually moves the (unconfigured) issue
// classes' defaults instead of being purely advisory. Explicit count/ratio
// specs on individual issues always win regardless of this scale.
const REFERENCE_CLEAN_RATIO = 0.5;

function resolveIssueMixOptions(
  issues: IssueMixOptions | undefined,
  pageCount: number,
  cleanRatio: number,
): ResolvedIssueMixOptions {
  const ratioScale = (1 - cleanRatio) / (1 - REFERENCE_CLEAN_RATIO);
  return {
    longH1: resolveIssueSpec(issues?.longH1, pageCount, 0.05 * ratioScale),
    oversizeTitle: resolveIssueSpec(issues?.oversizeTitle, pageCount, 0.05 * ratioScale),
    oversizeDescription: resolveIssueSpec(
      issues?.oversizeDescription,
      pageCount,
      0.05 * ratioScale,
    ),
    longUrls: resolveIssueSpec(issues?.longUrls, pageCount, 0.05 * ratioScale),
    duplicateTitles: resolveDuplicateSpec(issues?.duplicateTitles, pageCount, ratioScale),
    duplicateDescriptions: resolveDuplicateSpec(
      issues?.duplicateDescriptions,
      pageCount,
      ratioScale,
    ),
    orphanPages: resolveIssueSpec(issues?.orphanPages, pageCount, 0.03 * ratioScale),
    redirectChains: resolveRedirectChainSpec(issues?.redirectChains, pageCount, ratioScale),
    brokenLinks: resolveIssueSpec(issues?.brokenLinks, pageCount, 0.05 * ratioScale),
    noindexInSitemap: resolveIssueSpec(issues?.noindexInSitemap, pageCount, 0.03 * ratioScale),
  };
}

function resolveOptions(opts: GenerateSiteModelOptions): ResolvedSiteOptions {
  const pageCount = Math.max(1, Math.floor(opts.pageCount));
  const cleanRatio = Math.min(1, Math.max(0, opts.cleanRatio ?? DEFAULT_CLEAN_RATIO));
  return {
    seed: String(opts.seed),
    pageCount,
    templateCount: Math.max(1, opts.templateCount ?? DEFAULT_TEMPLATE_COUNT),
    minPageSizeBytes: opts.minPageSizeBytes ?? DEFAULT_MIN_PAGE_SIZE_BYTES,
    maxPageSizeBytes: Math.max(
      opts.minPageSizeBytes ?? DEFAULT_MIN_PAGE_SIZE_BYTES,
      opts.maxPageSizeBytes ?? DEFAULT_MAX_PAGE_SIZE_BYTES,
    ),
    cleanRatio,
    issues: resolveIssueMixOptions(opts.issues, pageCount, cleanRatio),
  };
}

function buildTemplates(templateCount: number): PageTemplate[] {
  const templates: PageTemplate[] = [
    { id: "home", label: "Home", fingerprint: hashStringHex("tpl:home") },
  ];
  for (let i = 1; i < templateCount; i++) {
    const kind = TEMPLATE_KINDS[(i - 1) % TEMPLATE_KINDS.length]!;
    const id = i - 1 < TEMPLATE_KINDS.length ? kind : `${kind}-${i}`;
    templates.push({ id, label: capitalize(kind), fingerprint: hashStringHex(`tpl:${id}`) });
  }
  return templates;
}

function buildLongText(rng: Rng, minLength: number): string {
  const bank = [...ADJECTIVES, ...NOUNS, ...VERBS, ...TOPICS];
  let text = "";
  while (text.length < minLength) {
    text += (text.length > 0 ? " " : "") + rngPick(rng, bank);
  }
  return text;
}

function basePage(
  rng: Rng,
  seed: string,
  index: number,
  template: PageTemplate,
  resolved: ResolvedSiteOptions,
): PageModel {
  // Keyed on `index`, not `template.id === "home"` — templateCount:1 reuses the
  // "home" template for every content page too, and path uniqueness must not
  // depend on template identity or every page would collide onto "/".
  const path = index === 0 ? "/" : `/${template.id}/${index}`;
  const adjective = capitalize(rngPick(rng, ADJECTIVES));
  const noun = rngPick(rng, NOUNS);
  const verb = rngPick(rng, VERBS);
  const topic = rngPick(rng, TOPICS);
  const title = `${adjective} ${noun} — ${template.label} ${index}`;
  const description = `This ${noun} ${verb} ${topic} for teams that need ${adjective.toLowerCase()} results, page ${index}.`;
  const h1 = `${adjective} ${noun} #${index}`;
  const wordCount = rngInt(rng, 150, 900);
  const targetSizeBytes = rngInt(rng, resolved.minPageSizeBytes, resolved.maxPageSizeBytes);

  return {
    path,
    templateId: template.id,
    title,
    description,
    h1,
    wordCount,
    statusCode: 200,
    noindex: false,
    inSitemap: true,
    outgoingLinks: [],
    targetSizeBytes,
    issues: [],
    seedTag: deriveSeed(seed, path),
  };
}

function wireDefaultLinks(rng: Rng, pages: PageModel[], orphanIndices: Set<number>): void {
  const linkableIndices = pages.map((_, i) => i).filter((i) => !orphanIndices.has(i));

  // Home links to a curated nav sample of linkable pages.
  const navSampleSize = Math.min(20, Math.max(0, linkableIndices.length - 1));
  const navPicks = pickIndices(rng, linkableIndices.length, navSampleSize)
    .map((i) => linkableIndices[i]!)
    .filter((i) => i !== 0);
  pages[0]!.outgoingLinks.push(...navPicks.map((i) => pages[i]!.path));

  // Bucket linkable indices by template ONCE — O(n) total — instead of
  // re-filtering the full `linkableIndices` pool for every page (was O(n)
  // per page = O(n^2) overall, which at the package's own 25k-page target is
  // ~625M comparisons; genuinely slow and directly against the "fast
  // synthetic data" premise this package exists for).
  const byTemplate = new Map<string, number[]>();
  for (const i of linkableIndices) {
    // Home (index 0) is never a valid sibling pick — it's already added via
    // the unconditional "every page links home" push below. Bucketing it in
    // would let pickFewExcluding (which only excludes the CURRENT page, not
    // home) pick it as a "sibling" whenever home shares a template with
    // content pages (trivially true at templateCount:1), duplicating "/" in
    // that page's outgoingLinks.
    if (i === 0) continue;
    const templateId = pages[i]!.templateId;
    let bucket = byTemplate.get(templateId);
    if (!bucket) {
      bucket = [];
      byTemplate.set(templateId, bucket);
    }
    bucket.push(i);
  }

  for (let i = 1; i < pages.length; i++) {
    const page = pages[i]!;
    page.outgoingLinks.push(pages[0]!.path); // every page links home
    const bucket = byTemplate.get(page.templateId) ?? [];
    const siblingCount = rngInt(rng, 2, 4);
    // pickFewExcluding is O(siblingCount), not O(bucket size) — the bucket is
    // shared/reused (and mutated in place) across every page of this
    // template, which is fine: determinism only requires a fixed rng-call
    // order, not statistical independence between picks.
    const siblingPicks = pickFewExcluding(rng, bucket, i, siblingCount);
    page.outgoingLinks.push(...siblingPicks.map((j) => pages[j]!.path));
  }
}

/** Non-home page indices, minus any already claimed by a conflicting field mutator. */
function eligibleNonHomeIndices(pages: PageModel[], exclude: ReadonlySet<number>): number[] {
  const indices: number[] = [];
  for (let i = 1; i < pages.length; i++) {
    if (!exclude.has(i)) indices.push(i);
  }
  return indices;
}

/**
 * Applies a single-tag, single-field mutation to `count` pages. Two issue
 * classes that both rewrite the same field (e.g. oversize-title and
 * duplicate-title both rewrite `.title`) MUST NOT be allowed to pick the same
 * page — whichever ran second would silently clobber the first mutation while
 * leaving its issue tag behind, decoupling the tag from the actual content.
 * `exclude` + the returned Set is how callers chain these picks in sequence.
 */
function applySingleTagIssue(
  rng: Rng,
  pages: PageModel[],
  count: number,
  tag: IssueTag,
  issueSummary: Record<IssueTag, number>,
  apply: (page: PageModel, rng: Rng) => void,
  exclude: ReadonlySet<number> = new Set(),
): Set<number> {
  const touched = new Set<number>();
  if (count <= 0 || pages.length <= 1) return touched;
  const candidates = eligibleNonHomeIndices(pages, exclude);
  const picks = pickSubset(rng, candidates, count);
  for (const idx of picks) {
    const page = pages[idx]!;
    apply(page, rng);
    page.issues.push(tag);
    issueSummary[tag] += 1;
    touched.add(idx);
  }
  return touched;
}

function applyDuplicateGroup(
  rng: Rng,
  pages: PageModel[],
  spec: { groupCount: number; groupSize: number },
  tag: "duplicate-title" | "duplicate-description",
  issueSummary: Record<IssueTag, number>,
  setValue: (page: PageModel, value: string) => void,
  makeValue: (rng: Rng, groupIndex: number) => string,
  exclude: ReadonlySet<number> = new Set(),
): void {
  if (spec.groupCount <= 0 || spec.groupSize < 2 || pages.length <= 1) return;
  const candidates = eligibleNonHomeIndices(pages, exclude);

  // Clamp groupCount DOWN to what the candidate pool can fully satisfy —
  // every emitted group always has exactly groupSize members, never a
  // silently-shrunk partial group. A requested mix that can't fit the
  // available pool (small pageCount, or a heavy `exclude` from an
  // earlier field-owning issue — see titleClaimed/descriptionClaimed
  // below) produces fewer FULL groups rather than dropping stragglers, so
  // issueSummary[tag] always equals actualGroupCount * groupSize exactly.
  const maxFittingGroups = Math.floor(candidates.length / spec.groupSize);
  const actualGroupCount = Math.min(spec.groupCount, maxFittingGroups);
  if (actualGroupCount <= 0) return;

  const picks = pickSubset(rng, candidates, actualGroupCount * spec.groupSize);
  for (let g = 0; g < actualGroupCount; g++) {
    const groupIndices = picks.slice(g * spec.groupSize, (g + 1) * spec.groupSize);
    const value = makeValue(rng, g);
    for (const idx of groupIndices) {
      const page = pages[idx]!;
      setValue(page, value);
      page.issues.push(tag);
      issueSummary[tag] += 1;
    }
  }
}

function applyLongUrls(
  rng: Rng,
  pages: PageModel[],
  orphanIndices: ReadonlySet<number>,
  count: number,
  issueSummary: Record<IssueTag, number>,
): void {
  if (count <= 0 || pages.length <= 1) return;
  const nonHomePool = pages.length - 1;
  const picks = pickIndices(rng, nonHomePool, count).map((i) => i + 1);
  // Target pool must exclude orphans — linking to one would give it an
  // incoming link, breaking the "orphan = zero inbound links" invariant.
  const linkableIndices = pages.map((_, i) => i).filter((i) => !orphanIndices.has(i));
  for (const idx of picks) {
    const source = pages[idx]!;
    const targetIdx = pickExcluding(rng, linkableIndices, idx);
    const target = pages[targetIdx]!;
    // Pad the query string well past LONG_URL_MIN_LENGTH regardless of origin
    // length. Not reachable with today's `/${templateId}/${index}` paths, but
    // guard the negative case anyway (repeat() throws RangeError on a
    // negative count) since target.path length isn't bounded by this function.
    const junkLength = Math.max(0, LONG_URL_MIN_LENGTH - target.path.length + 200);
    const junk = hashStringHex(`${source.path}:${idx}`).repeat(
      Math.max(1, Math.ceil(junkLength / 8)),
    );
    const href = `${target.path}?session=${junk.slice(0, junkLength)}`;
    source.outgoingLinks.push(href);
    source.issues.push("long-url");
    issueSummary["long-url"] += 1;
  }
}

function applyBrokenLinks(
  rng: Rng,
  pages: PageModel[],
  count: number,
  issueSummary: Record<IssueTag, number>,
): void {
  if (count <= 0 || pages.length <= 1) return;
  const nonHomePool = pages.length - 1;
  const picks = pickIndices(rng, nonHomePool, count).map((i) => i + 1);
  let n = 0;
  for (const idx of picks) {
    const source = pages[idx]!;
    source.outgoingLinks.push(`${RESERVED_BROKEN_LINK_PREFIX}/${idx}-${n}`);
    source.issues.push("broken-link");
    issueSummary["broken-link"] += 1;
    n += 1;
  }
}

function applyRedirectChains(
  rng: Rng,
  pages: PageModel[],
  orphanIndices: Set<number>,
  spec: { count: number; chainLength: number },
  seed: string,
  issueSummary: Record<IssueTag, number>,
): PageModel[] {
  if (spec.count <= 0 || spec.chainLength <= 0 || pages.length <= 1) return [];
  const linkableIndices = pages.map((_, i) => i).filter((i) => i !== 0 && !orphanIndices.has(i));
  if (linkableIndices.length === 0) return [];

  const sourcePicks = pickIndices(rng, pages.length - 1, spec.count).map((i) => i + 1);
  const hops: PageModel[] = [];

  for (let c = 0; c < spec.count; c++) {
    // `% sourcePicks.length` cycles back over the same source pages once
    // `spec.count` exceeds the available non-home pool — harmless (one page
    // can link to several redirect chains), just means "requested chain
    // count" and "distinct source pages" aren't the same number when count
    // is large relative to pageCount.
    const sourceIdx = sourcePicks[c % sourcePicks.length]!;
    // Hard-excludes the source: a chain redirecting back to the very page
    // that links into it is a confusing edge case for a fixture meant to
    // model realistic chains, even though it wouldn't technically loop (the
    // chain still terminates at a real 200 page). This is a real guarantee,
    // not a probabilistic one — the "no self-link" invariant tests rely on it.
    const destIdx = pickExcluding(rng, linkableIndices, sourceIdx);
    const destPage = pages[destIdx]!;
    for (let h = 0; h < spec.chainLength; h++) {
      const hopPath = `${RESERVED_REDIRECT_CHAIN_PREFIX}/${c}/hop-${h}`;
      const isLastHop = h === spec.chainLength - 1;
      hops.push({
        path: hopPath,
        templateId: "redirect-hop",
        title: "Redirecting…",
        description: "",
        h1: "",
        wordCount: 0,
        statusCode: 301,
        redirectTo: isLastHop
          ? destPage.path
          : `${RESERVED_REDIRECT_CHAIN_PREFIX}/${c}/hop-${h + 1}`,
        noindex: false,
        inSitemap: false,
        outgoingLinks: [],
        targetSizeBytes: 0,
        issues: ["redirect-chain"],
        seedTag: deriveSeed(seed, hopPath),
      });
      issueSummary["redirect-chain"] += 1;
    }
    pages[sourceIdx]!.outgoingLinks.push(`${RESERVED_REDIRECT_CHAIN_PREFIX}/${c}/hop-0`);
  }
  return hops;
}

/**
 * Generate a full synthetic site model deterministically from `opts.seed`.
 * Pure function — no I/O, no rendered HTML held in memory.
 */
export function generateSiteModel(opts: GenerateSiteModelOptions): SiteModel {
  const resolved = resolveOptions(opts);
  const rng = createRng(resolved.seed);
  const templates = buildTemplates(resolved.templateCount);
  const issueSummary = emptyIssueSummary();

  const pages: PageModel[] = [];
  pages.push(basePage(rng, resolved.seed, 0, templates[0]!, resolved));
  // templateCount:1 means every page (including content pages) reuses "home" —
  // `templates.length - 1` would otherwise be 0 and the round-robin below divides by it.
  const contentTemplateCount = templates.length - 1;
  for (let i = 1; i < resolved.pageCount; i++) {
    const template =
      contentTemplateCount > 0 ? templates[1 + ((i - 1) % contentTemplateCount)]! : templates[0]!;
    pages.push(basePage(rng, resolved.seed, i, template, resolved));
  }

  // Orphan reservation happens BEFORE link wiring so orphans genuinely end up
  // with zero incoming links (never chosen as a link target anywhere below).
  const orphanCount = Math.min(resolved.issues.orphanPages.count, Math.max(0, pages.length - 1));
  const orphanIndices = new Set(pickIndices(rng, pages.length - 1, orphanCount).map((i) => i + 1));
  for (const idx of orphanIndices) {
    pages[idx]!.issues.push("orphan");
    issueSummary.orphan += 1;
    // inSitemap stays true (default) — "in sitemap, never linked" is the point.
  }

  wireDefaultLinks(rng, pages, orphanIndices);

  applySingleTagIssue(
    rng,
    pages,
    resolved.issues.longH1.count,
    "long-h1",
    issueSummary,
    (page, r) => {
      page.h1 = buildLongText(r, LONG_H1_MIN_LENGTH + 50);
    },
  );
  // oversize-title and duplicate-title both rewrite `.title` — the duplicate-
  // group pass below excludes whatever this claims, so neither can silently
  // clobber the other's mutation while leaving a stale issue tag behind.
  const titleClaimed = applySingleTagIssue(
    rng,
    pages,
    resolved.issues.oversizeTitle.count,
    "oversize-title",
    issueSummary,
    (page, r) => {
      page.title = buildLongText(r, OVERSIZE_TITLE_MIN_LENGTH + 20);
    },
  );
  const descriptionClaimed = applySingleTagIssue(
    rng,
    pages,
    resolved.issues.oversizeDescription.count,
    "oversize-description",
    issueSummary,
    (page, r) => {
      page.description = buildLongText(r, OVERSIZE_DESCRIPTION_MIN_LENGTH + 20);
    },
  );
  applySingleTagIssue(
    rng,
    pages,
    resolved.issues.noindexInSitemap.count,
    "noindex-in-sitemap",
    issueSummary,
    (page) => {
      page.noindex = true;
      page.inSitemap = true;
    },
  );

  applyDuplicateGroup(
    rng,
    pages,
    resolved.issues.duplicateTitles,
    "duplicate-title",
    issueSummary,
    (page, value) => {
      page.title = value;
    },
    (r, groupIndex) =>
      `${capitalize(rngPick(r, ADJECTIVES))} ${rngPick(r, NOUNS)} — Group ${groupIndex}`,
    titleClaimed,
  );
  applyDuplicateGroup(
    rng,
    pages,
    resolved.issues.duplicateDescriptions,
    "duplicate-description",
    issueSummary,
    (page, value) => {
      page.description = value;
    },
    (r, groupIndex) =>
      `The same description text appears on every page in duplicate group ${groupIndex}, describing ${rngPick(r, NOUNS)}.`,
    descriptionClaimed,
  );

  applyLongUrls(rng, pages, orphanIndices, resolved.issues.longUrls.count, issueSummary);
  applyBrokenLinks(rng, pages, resolved.issues.brokenLinks.count, issueSummary);
  const redirectHops = applyRedirectChains(
    rng,
    pages,
    orphanIndices,
    resolved.issues.redirectChains,
    resolved.seed,
    issueSummary,
  );

  const allPages = [...pages, ...redirectHops];
  issueSummary.clean = pages.filter((p) => p.issues.length === 0).length;

  const sitemapPaths = allPages.filter((p) => p.inSitemap).map((p) => p.path);

  return {
    seed: resolved.seed,
    pages: allPages,
    sitemapPaths,
    templates,
    issueSummary,
    options: resolved,
  };
}
