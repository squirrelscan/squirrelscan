// Smart audits (#110) — coverage line + carried-finding provenance helpers.
// Shared across CLI console + report renderers. No-op when `smart_audits` is
// off (the report carries no `coverage` and no carried checks).

import type { AuditReport, CheckItem } from "./types";
import type { GroupedCheck } from "./grouping";
import { checkAffectedPages } from "./affected-pages";

/**
 * One-line coverage summary, e.g.
 *   "Coverage: audited 10 of 100 known pages (90 findings carried forward)."
 *   "Coverage: audited 100 of 100 known pages (4925 findings on pages not yet rendered)."
 * Returns null when smart audits did not run (no `coverage` on the report).
 *
 * (#1652) The two counts are disjoint and read differently on purpose: "carried
 * forward" asserts an earlier audit observed the finding, which is false for a
 * page nothing has ever rendered — and on a first run that would be false for
 * every one of them.
 */
export function coverageLine(report: AuditReport): string | null {
  const c = report.coverage;
  if (!c) return null;
  const notes: string[] = [];
  if (c.carriedFindings > 0) {
    notes.push(
      `${c.carriedFindings} finding${c.carriedFindings === 1 ? "" : "s"} carried forward`
    );
  }
  const unrendered = c.unrenderedFindings ?? 0;
  if (unrendered > 0) {
    notes.push(
      `${unrendered} finding${unrendered === 1 ? "" : "s"} on pages not yet rendered`
    );
  }
  const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  return `Coverage: audited ${c.auditedPages} of ${c.knownPages} known page${c.knownPages === 1 ? "" : "s"}${suffix}.`;
}

/**
 * One-line scan scope summary (#1180), e.g.
 *   "Scan: 100 pages crawled from the CLI v0.0.76 (page limit 100 reached)."
 * Returns null for pre-#1180 reports (no `scanScope`).
 */
export function scanScopeLine(report: AuditReport): string | null {
  const s = report.scanScope;
  if (!s) return null;
  const origin = s.origin === "cloud" ? "squirrelscan cloud" : s.origin === "ci" ? "CI" : "the CLI";
  const version = report.generatorVersion ? ` v${report.generatorVersion}` : "";
  const cap =
    s.maxPages !== undefined
      ? s.capped
        ? ` (page limit ${s.maxPages} reached)`
        : ` (page limit ${s.maxPages})`
      : "";
  return `Scan: ${s.pagesCrawled} page${s.pagesCrawled === 1 ? "" : "s"} crawled from ${origin}${version}${cap}.`;
}

/**
 * Full-scan hint (#1180): shown when the score does not rest on a full fresh
 * crawl — either the page limit stopped the crawl (`scanScope.capped`) or the
 * smart-audit union carried pages not re-checked this run. Returns null when
 * the scan was complete.
 */
export function fullScanHint(report: AuditReport): string | null {
  const s = report.scanScope;
  const c = report.coverage;
  const capped = s?.capped ?? false;
  const partialUnion = c ? c.auditedPages < c.knownPages : false;
  if (!capped && !partialUnion) return null;
  // Remediation copy branches by origin: --max-pages is a CLI flag; a cloud
  // audit's page budget lives in the website settings / audit trigger.
  const cloud = s?.origin === "cloud";
  if (partialUnion && c) {
    const target = c.knownPages > (s?.maxPages ?? 0) ? String(c.knownPages) : null;
    const remedy = cloud
      ? "Raise the audit page limit and re-run"
      : `Re-run with ${target ? `--max-pages ${target}` : "a higher --max-pages"}`;
    return `Partial scan: ${c.auditedPages} of ${c.knownPages} known pages were re-checked this run; the score carries earlier results for the rest. ${remedy} for a fully fresh full-site score.`;
  }
  const remedy = cloud ? "Raise the audit page limit" : "Raise --max-pages";
  return `Partial scan: the page limit stopped the crawl, so the site may have more pages than this score covers. ${remedy} for a full-site score.`;
}

/**
 * One-line render-block recovery note (#512), e.g.
 *   "3 pages recovered via direct fetch after a render block."
 * Returns null when nothing was recovered (no `fetchFallbacks` on the report).
 */
export function fetchFallbacksLine(report: AuditReport): string | null {
  const recovered = report.fetchFallbacks?.recovered ?? 0;
  if (recovered <= 0) return null;
  return `${recovered} page${recovered === 1 ? "" : "s"} recovered via direct fetch after a render block.`;
}

export interface SeedRedirect {
  /**
   * Where the refused redirect pointed, canonicalized — or `null` when the
   * stored value was not a parseable http(s) URL and was withheld instead of
   * printed (see {@link seedRedirect}). Site-controlled: display only, and
   * every caller must escape it for its own output format.
   */
  finalUrl: string | null;
  /** The URL this audit actually graded (the report's `baseUrl`). */
  baseUrl: string;
  /** The disclosure as one sentence, ready to render. */
  note: string;
}

/**
 * What the disclosure says in place of a redirect target that could not be
 * canonicalized. Fixed text: no byte of the stored value reaches any output.
 * Worded without punctuation any renderer escapes, so it reads the same in the
 * raw markdown source as it does everywhere else.
 */
const WITHHELD_TARGET = "The redirect target was not a valid URL and is withheld.";

/**
 * Stand-in `finalUrl` for rebuilding a report whose redirect target was
 * withheld — a slim-JSON round trip, where the target was never serialized and
 * so cannot be restored (#1418).
 *
 * Deliberately not a URL: {@link seedRedirect} re-refuses it and re-emits the
 * withheld disclosure, so a reloaded report says exactly what the original one
 * did instead of quietly losing the fact that a redirect happened. Self-naming
 * so it explains itself if some other consumer ever prints `finalUrl` raw.
 */
export const WITHHELD_SEED_REDIRECT_TARGET = "withheld:unparseable-redirect-target";

/**
 * A refused off-site seed redirect (#1418), or null when there is nothing to
 * disclose: no `finalUrl` (older reports, and every seed that did not redirect
 * off-site), or a `finalUrl` that does not differ from `baseUrl`.
 *
 * The crawler pins the crawl to the seed when a seed redirect leaves the seed's
 * registrable domain, so `baseUrl` stays the site the user asked for and
 * `finalUrl` records where the redirect pointed. Unreported, the report reads
 * as a clean audit of a URL nobody requested.
 *
 * The returned `finalUrl` is the canonical one `note` quotes, so a consumer
 * reading the field and a human reading the sentence can never see two
 * different URLs. It is `null` when the stored value did not survive
 * {@link canonicalizeReportUrl}: the redirect is still disclosed, with the
 * target withheld, so a report can never carry a target nobody vetted. Only
 * `finalUrl` is canonicalized: `baseUrl` is the crawl's own base and is shown
 * the way the rest of the report shows it. Escaping for markdown/HTML/XML
 * stays each renderer's job.
 */
export function seedRedirect(report: AuditReport): SeedRedirect | null {
  // A non-string is out of contract rather than hostile content: treat it as
  // absent instead of throwing on it. The one place untrusted data enters (slim
  // JSON reconstruction) maps a malformed field to a stand-in of its own, so
  // the disclosure still survives there.
  const stored = typeof report.finalUrl === "string" ? report.finalUrl : "";
  // Absent or whitespace-only ⇒ no value was stored, so there is no redirect to
  // disclose. Deliberately NOT "nothing printable": a value made only of
  // invisible characters is a stored value, and hostile input must not be able
  // to buy silence by being unprintable. Everything past here either
  // canonicalizes or is withheld, but it is always disclosed.
  if (isBlankUrlField(stored)) return null;
  const baseUrl = dropNonUrlChars(report.baseUrl);
  if (!baseUrl) return null;
  const finalUrl = canonicalizeReportUrl(stored);
  if (finalUrl === null) {
    return {
      finalUrl: null,
      baseUrl,
      note: `Seed redirected off-site and was not followed. ${WITHHELD_TARGET} This audit graded ${baseUrl}.`,
    };
  }
  // Compared canonically so an equivalent pair ("https://example.com" vs
  // ".../") never prints a line saying the seed redirected to itself.
  if (finalUrl === baseUrl || finalUrl === canonicalizeReportUrl(baseUrl)) return null;
  return {
    finalUrl,
    baseUrl,
    note: `Seed redirected off-site to ${finalUrl}, not followed. This audit graded ${baseUrl}.`,
  };
}

/**
 * {@link seedRedirect}'s sentence alone, e.g.
 *   "Seed redirected off-site to https://other.example/, not followed. This audit graded https://example.com."
 * Returns null on the same terms.
 */
export function seedRedirectLine(report: AuditReport): string | null {
  return seedRedirect(report)?.note ?? null;
}

/**
 * Canonicalize a site-controlled URL for display, or `null` for a value we are
 * not willing to print at all.
 *
 * A redirect target is whatever `Location` the audited site sent, and it
 * reaches a report as a stored string, so it keeps whatever bytes it was sent
 * with. Re-serializing through the WHATWG parser is what makes it safe to
 * print: the parser drops tab/CR/LF, IDNA-encodes a Unicode hostname (so a
 * homograph host shows as `xn--…`), and percent-encodes every non-ASCII code
 * point and every C0 control in the path/query/fragment, which is what turns
 * an invisible bidi override or zero-width joiner into visible `%E2%80%AE`.
 * Left raw, a newline would break out of the line that renders the URL and a
 * bidi override would rewrite how the rest of it reads.
 *
 * Anything the parser does not hand back as http(s) is REFUSED rather than
 * sanitized. The only producer of this field resolves a `Location` header
 * against an absolute http(s) seed, so a value that does not parse is already
 * off the legitimate path: there is no shape worth preserving, and the
 * alternative — printing it minus a denylist of unsafe ranges — is a list that
 * has to stay current with Unicode forever, and was already missing the C1
 * controls (0x9b is an 8-bit CSI a terminal acts on) and the bidi overrides.
 * Refusing keeps the allowlist the WHATWG parser already implements: callers
 * disclose the redirect with a fixed placeholder instead.
 */
function canonicalizeReportUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {}
  return null;
}

/**
 * Drop whitespace, control characters and invisible formatting from a URL that
 * is not being canonicalized: the crawl's own `baseUrl`, shown the way the rest
 * of the report shows it (no added trailing slash).
 *
 * Checked per code point rather than as one character class: a class spanning
 * the C0 range trips oxlint's no-control-regex.
 */
function dropNonUrlChars(value: string | undefined): string {
  if (!value) return "";
  let out = "";
  // for..of iterates whole code points, so an astral character cannot be split.
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // C0 controls and space (<= 0x20), then DEL and the C1 controls
    // (0x7f-0x9f). C1 matters on its own terms: 0x9b is an 8-bit CSI, which a
    // terminal acts on exactly as it does ESC-[, and this string reaches text
    // and console output live.
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    // The rest of Unicode whitespace (NBSP, ideographic space and friends).
    if (UNICODE_WHITESPACE.test(char)) continue;
    // Invisible formatting: bidi controls rewrite how everything after them
    // reads, and the zero-width family hides a boundary inside a hostname.
    // None of them carry meaning in a URL.
    if (isInvisibleFormatChar(code)) continue;
    // Code points XML 1.0 forbids: unpaired surrogates (for..of yields a lone
    // one as its own character) and the noncharacters. They would make the llm
    // renderer's document unparseable.
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (code >= 0xfdd0 && code <= 0xfdef) continue;
    if ((code & 0xfffe) === 0xfffe) continue;
    out += char;
  }
  return out;
}

/**
 * True when the value holds nothing but ordinary whitespace, i.e. no value was
 * really stored.
 *
 * Deliberately not `String.prototype.trim`, whose whitespace set includes
 * U+FEFF for historical reasons: a BOM is invisible formatting, not an empty
 * field, and reading it as blank would hand an unprintable value exactly the
 * silence this disclosure exists to prevent. A no-break space, which really is
 * a space, still counts as blank.
 */
function isBlankUrlField(value: string): boolean {
  for (const char of value) {
    if (char.codePointAt(0) === 0xfeff) return false;
    if (!UNICODE_WHITESPACE.test(char)) return false;
  }
  return true;
}

/** Zero-width, joiner and bidi-control code points — invisible by design. */
function isInvisibleFormatChar(code: number): boolean {
  return (
    code === 0x00ad || // soft hyphen
    code === 0x061c || // Arabic letter mark
    (code >= 0x200b && code <= 0x200f) || // zero-width space/joiners, LRM, RLM
    (code >= 0x202a && code <= 0x202e) || // bidi embeddings and overrides
    (code >= 0x2060 && code <= 0x206f) || // word joiner, invisible operators,
    // bidi isolates, and the deprecated format controls above them
    code === 0xfeff // BOM / zero-width no-break space
  );
}

const UNICODE_WHITESPACE = /\s/;

/** Approximate "N days/hours ago" from an epoch-ms timestamp. */
export function timeAgo(epochMs: number, now: number = Date.now()): string {
  const deltaMs = Math.max(0, now - epochMs);
  const days = Math.floor(deltaMs / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} ago`;
  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return "recently";
}

/**
 * Provenance tag for a grouped check, e.g. "(carried — last seen 3 days ago)"
 * or, for a page nothing has ever rendered, "(not yet rendered)" (#1652).
 * Returns "" when the check is fresh. Only FULLY carried / fully unrendered
 * checks (every merged instance) are tagged.
 *
 * The unrendered branch comes first and never shows a "last seen" date: no run
 * has observed the finding, so any date would be fabricated — and on a first
 * audit "carried" itself would be.
 */
export function carriedTag(check: GroupedCheck, now: number = Date.now()): string {
  if (check.unrenderedCount && check.unrenderedCount >= check.count) {
    return " (not yet rendered)";
  }
  if (!check.carriedCount || check.carriedCount < check.count) return "";
  const seen =
    check.lastSeenAt !== undefined ? ` — last seen ${timeAgo(check.lastSeenAt, now)}` : "";
  return ` (carried${seen})`;
}

/**
 * Full-sentence label for a check row (#1135), e.g.
 *   "Not re-checked this run — last verified 3 days ago."
 * Returns null unless every merged instance of the check was carried
 * (partial-carry checks get {@link ruleCarriedRollupLine} instead, at the
 * rule level, since a check-level "N of M" would repeat the rule rollup).
 */
export function checkCarriedLabel(check: GroupedCheck, now: number = Date.now()): string | null {
  if (!check.carriedCount || check.carriedCount < check.count) return null;
  const seen = check.lastSeenAt !== undefined ? ` — last verified ${timeAgo(check.lastSeenAt, now)}` : "";
  return `Not re-checked this run${seen}.`;
}

/**
 * Full-sentence label for a check whose every instance sits on a page NO audit
 * has ever rendered (#1652), e.g. "Not yet rendered in this scan."
 *
 * Deliberately says nothing about re-checking or last verification: there is no
 * earlier run to have verified anything. Returns null unless every merged
 * instance is unrendered, mirroring {@link checkCarriedLabel}.
 */
export function checkUnrenderedLabel(check: GroupedCheck): string | null {
  if (!check.unrenderedCount || check.unrenderedCount < check.count) return null;
  return "Not yet rendered in this scan.";
}

/**
 * Per-rule carried-pages rollup (#1135), e.g.
 *   "28 of 103 pages carried from previous crawls."
 * Returns null when nothing is carried, or when EVERY affected page is
 * carried (the rule-level "carried" state is obvious without a fraction).
 */
export function ruleCarriedRollupLine(carriedPages: number, totalPages: number): string | null {
  if (carriedPages <= 0 || totalPages <= 0 || carriedPages >= totalPages) return null;
  return `${carriedPages} of ${totalPages} page${totalPages === 1 ? "" : "s"} carried from previous crawls.`;
}

/** The 5 fields {@link ruleMixedProvenanceNote} reads off a raw check. */
export interface MixedProvenanceCheck {
  status: string;
  pageUrl?: string;
  pages?: string[];
  items?: CheckItem[];
  provenance?: string;
}

/**
 * Per-rule "fixed on all pages checked this run; N pages pending re-check"
 * note (#1135). Fires when a rule has a FRESH pass on at least one page AND a
 * CARRIED warn/fail on at least one page, with no FRESH warn/fail anywhere —
 * i.e. every page re-checked this run came back clean, but the rule still
 * shows red only because of pages the crawl didn't revisit. Must read every
 * status (pass included), not just fail/warn.
 *
 * Single shared implementation used by the public renderers and hosted report
 * summaries so the two surfaces cannot silently drift.
 *
 * A page can be BOTH a fresh pass (one check under the rule) and a carried
 * issue (a different check under the same rule) — e.g. one check-name passes
 * on page X fresh while another check-name has a carried warn on the same
 * page. Such a page isn't actually clean, so it's excluded from the "checked
 * clean" count (only counted toward "pending re-check"); the two counts in
 * the rendered message are always disjoint.
 */
export function ruleMixedProvenanceNote(
  checks: ReadonlyArray<MixedProvenanceCheck>,
): string | undefined {
  const freshPassPages = new Set<string>();
  const carriedIssuePages = new Set<string>();
  const freshIssuePages = new Set<string>();
  for (const check of checks) {
    const pages = checkAffectedPages({ pages: check.pages, items: check.items });
    if (check.pageUrl) pages.add(check.pageUrl);
    if (pages.size === 0) continue;
    // (#1652) An "unrendered" check belongs to NEITHER bucket: its page was
    // never rendered, so it is not a fresh result (which would suppress the
    // note) and not carry-over from an earlier run (which would inflate
    // "pending re-check" with pages nothing has ever checked).
    if (check.provenance === "unrendered") continue;
    const isCarried = check.provenance === "carried";
    if (check.status === "pass") {
      if (!isCarried) for (const p of pages) freshPassPages.add(p);
    } else if (check.status === "warn" || check.status === "fail") {
      if (isCarried) for (const p of pages) carriedIssuePages.add(p);
      else for (const p of pages) freshIssuePages.add(p);
    }
  }
  // Disjoint the two buckets: a page counted as a carried issue can't also
  // count toward "checked clean", even if some other check passed it fresh.
  const trulyClean = [...freshPassPages].filter((p) => !carriedIssuePages.has(p)).length;
  if (trulyClean === 0 || carriedIssuePages.size === 0 || freshIssuePages.size > 0) {
    return undefined;
  }
  const pending = carriedIssuePages.size;
  return `Fixed on all ${trulyClean} page${trulyClean === 1 ? "" : "s"} checked this run; ${pending} page${pending === 1 ? "" : "s"} pending re-check.`;
}
