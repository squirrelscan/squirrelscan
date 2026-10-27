import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PiArrowSquareOut,
  PiCaretRight,
  PiCheck,
  PiCopy,
  PiLockSimple,
  PiWarning,
  PiX,
} from "react-icons/pi";

import type {
  CheckItem,
  EditorSummaryPriority,
  ReportBranding,
  ReportStructure,
  SitemapDiscovery,
} from "@squirrelscan/core-contracts";

import {
  affectedPages,
  isPageUrl,
  isRedundantPageItem,
  itemsNotListed,
  itemsNotListedLine,
  ruleAffectedPageCount,
  ruleAffectedRollup,
  ruleCarriedPageCount,
} from "../affected-pages";
import { cacheHitRatePercent, cacheReasonsLabel } from "../cache-stats";
import {
  describeRoot,
  fixRollupLine,
  fixUnits,
  isRenderableFixGroup,
  ruleFixCoverage,
  type FixCoverage,
} from "../component-presentation";
import {
  getBadgeName,
  getBadgeTitle,
  getCategoryGroup,
  getGroupName,
  getGroupTitle,
  severityLabel,
} from "../categories";
import {
  REPORT_COLLAPSE_THRESHOLD,
  REPORT_ITEMS_COLLAPSE_THRESHOLD,
  REPORT_PAGES_HARD_CAP,
  REPORT_PAGES_INLINE_CAP,
  REPORT_SOURCE_PAGES_PREVIEW,
} from "../constants";
import {
  auditLevelLine,
  checkCarriedLabel,
  checkUnrenderedLabel,
  coverageLine,
  fullScanHint,
  publishedReportNote,
  ruleCarriedRollupLine,
  scanScopeUnfetched,
  seedRedirectLine,
  clampedPageLimit,
} from "../coverage";
import { getDocsUrl } from "../docs";
import { allPositionBands, domainStatRows } from "../domain-stats";
import { editorSummaryView, priorityEffortLabel } from "../editor-summary";
import { entitySummaryLine } from "../entities";
import {
  ENTITY_VIEWER_STYLES,
  entityViewerData,
  entityViewerMarkup,
  entityViewerScript,
} from "../entities-viewer";
import { getAuditFailureNotice, reportFailureReasonCode } from "../failure-notice";
import {
  flattenIssuesBySeverity,
  groupIssuesByCategory,
  passedRuleScope,
  reportPassedRules,
  type FlatIssue,
  type GroupedCheck,
  type PassedRule,
} from "../grouping";
import {
  affectedPagesSuffix,
  hasItemSources,
  itemSourceView,
  moreSourcePages,
  type ItemSourceRow,
} from "../item-sources";
import { lockedRulesMessage } from "../locked-rules";
import { notCheckedLines } from "../not-checked";
import { privateTargetLine } from "../private-target";
import {
  checkPagesScopedAway,
  checkScopeLine,
  itemLabel,
  itemRegionScope,
  regionScopeLine,
} from "../region-scope";
import { GROUP_COLORS, getGroupColor, getScoreGrade } from "../scoring";
import { siteProfileFlags, siteProfileRows } from "../site-metadata";
import {
  ruleSiteResourceCoverage,
  siteResourceFixLine,
  withSiteResourceCoverage,
  type SiteResourceCoverage,
} from "../site-resource-presentation";
import {
  structureChromeLine,
  structureDegradedLine,
  structurePageTypesLine,
  structureRowDetail,
  structureRows,
  structureTotalsLine,
} from "../structure";
import { groupTechnologies, techChangeSummary, techIconUrl } from "../technologies";
import type { AuditReport } from "../types";
import { getPathname } from "../url";
import { formatBytes, sanitizeUrl } from "../utils";
import {
  coverageGap,
  fixPlanPrompt,
  fixPrompt,
  inlineJson,
  issuePromptBody,
  NOTE_TOKEN,
  sharedPromptParts,
  type CoverageGap,
  type PromptContext,
} from "./page/prompts";
import { REPORT_CSS } from "./page/styles.generated";
// Design-system pieces copied from the squirrelscan UI kit (MIT, like this package).
import { Badge, type BadgeColor } from "./page/ui/badge";
import { SquirrelLogo } from "./page/ui/brand";
import { Card } from "./page/ui/card";
import { DecorativeHeader } from "./page/ui/decorative-header";
import { GroupBadge } from "./page/ui/group-badge";
import { Metrics } from "./page/ui/metrics";
import { Panel } from "./page/ui/panel";
import { Progress } from "./page/ui/progress";
import { ScoreCircle } from "./page/ui/score-circle";

export interface HtmlRenderOptions {
  /** Published report id: OG tags, the agent .md/.json links and the report link in fix prompts. */
  reportId?: string;
  /** White-label branding (#810): Team orgs hide squirrelscan branding. */
  branding?: ReportBranding;
  /**
   * The site's favicon, from a first-party host. Used only when `offline` is
   * false; otherwise (and when absent) the header shows the initial-letter tile.
   */
  faviconUrl?: string;
  /**
   * Default true: the page loads no remote images, so opening a local report
   * makes no network request. No favicon, no technology icons. The cloud
   * passes false to show first-party tech icons and `faviconUrl`. A screenshot
   * (`report.screenshotUrl`) or a white-label logo renders whenever the report
   * or the caller supplies one, as before; a local audit carries neither.
   */
  offline?: boolean;
  /** List the rules that passed after the issues (`--include-passed`). */
  includePassed?: boolean;
  /**
   * The published report's own URL (squirrelscan/repo#3182): `og:url`,
   * `og:image`, the agent `.md`/`.json` links, the report link in fix prompts,
   * and a `<link rel="canonical">`. Without it a report with a `reportId`
   * links to `https://reports.squirrelscan.com/<reportId>` and has no canonical
   * link, as before.
   */
  reportUrl?: string;
  /**
   * Where the technology logos are served from (squirrelscan/repo#3182), so a
   * report page loads nothing from another host. Default
   * `https://squirrelscan.com/tech-icons`. Only used when `offline` is false.
   */
  techIconBaseUrl?: string;
}

/** Render-wide asset hosts, read by deep components without prop drilling. */
const RenderAssets = React.createContext<{ techIconBaseUrl?: string }>({});

/** The default link for a published report id, before #3182's per-org hosts. */
function defaultReportUrl(reportId: string): string {
  return `https://reports.squirrelscan.com/${reportId}`;
}

/**
 * Pages the audit knows exist: every sitemap URL plus the crawled pages no
 * sitemap lists, or the crawled pages plus the in-scope URLs the crawl queued
 * but never fetched (`scanScope.unfetched`), whichever is larger. The links on
 * the pages still queued are unknown and sitemap intake is capped, so a capped
 * crawl's count is a floor.
 */
function discoveredPages(report: AuditReport): {
  total: number;
  sitemap: number;
  crawlOnly: number;
  unfetched: number;
} {
  // Written by the engine's report stream but not on the AuditReport type; read defensively.
  const sm = (
    report as AuditReport & {
      sitemaps?: Partial<Pick<SitemapDiscovery, "totalUrls" | "missingPages">>;
    }
  ).sitemaps;
  const sitemap = count(sm?.totalUrls);
  const crawlOnly = Array.isArray(sm?.missingPages) ? sm.missingPages.length : 0;
  const unfetched = scanScopeUnfetched(report);
  const total = Math.max(
    count(report.totalPages),
    count(report.coverage?.knownPages),
    sitemap + crawlOnly,
    // Fetched and still-queued URLs are disjoint, so their sum is a floor too.
    count(report.scanScope?.pagesCrawled) + unfetched,
  );
  return { total, sitemap, crawlOnly, unfetched };
}

/** A non-negative whole number off report JSON, or 0 (stored reports of any origin). */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

const STRATEGIC_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const EFFORTS = new Set(["quick-win", "moderate", "significant"]);

/** Strategic issues off report JSON, keeping only well-formed rows (cloud-only, unchecked shape). */
function strategicIssues(report: AuditReport): StrategicIssueView[] {
  const raw = (report as AuditReport & { strategicIssues?: unknown }).strategicIssues;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v: unknown): v is StrategicIssueView => {
    if (!v || typeof v !== "object") return false;
    const s = v as Record<string, unknown>;
    return (
      typeof s.slug === "string" &&
      typeof s.title === "string" &&
      typeof s.description === "string" &&
      typeof s.actions === "string" &&
      STRATEGIC_SEVERITIES.has(s.severity as string) &&
      EFFORTS.has(s.effort as string) &&
      Array.isArray(s.ruleIds) &&
      s.ruleIds.every((id) => typeof id === "string")
    );
  });
}

/** Cloud features a local audit goes without (docs: cloud/index). No em-dashes: public copy. */
const CLOUD_FEATURES: Array<[string, string]> = [
  [
    "Summary and ranked issues",
    "An AI summary of the audit, with the fixes ranked for your stack and one fix plan to hand your coding agent.",
  ],
  [
    "Browser rendering",
    "Every page rendered in a real headless browser, so JavaScript-heavy sites are audited as visitors see them.",
  ],
  ["AI analysis", "Page classification, site profile, parsability scoring and authority checks."],
  [
    "Shared data",
    "Full adblock and privacy filter lists, a global dead-link cache and search demand data.",
  ],
  [
    "Tech stack history",
    "The CMS, framework, CDN and analytics behind the site, with what changed between audits.",
  ],
  [
    "Publishing and history",
    "Shareable reports, issues tracked over time, scheduled audits and your team in the dashboard.",
  ],
];

type Severity = "error" | "warning" | "info";

const SEVERITY: Record<Severity, { color: BadgeColor; title: string; blurb: string }> = {
  error: { color: "red", title: "Errors", blurb: "Broken or harmful. Fix these first." },
  info: { color: "blue", title: "Recommendations", blurb: "Worth doing, not hurting you today." },
  warning: { color: "yellow", title: "Warnings", blurb: "Likely to cost you over time." },
};
const BAND_ORDER: Severity[] = ["error", "info", "warning"];
const GROUPS = ["seo", "performance", "security", "ai"] as const;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** The timestamp as ISO 8601, or undefined when it does not parse (toISOString would throw). */
const isoTime = (ts: string | number | Date): string | undefined => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** "16 Jun 2026, 14:30 UTC". Built by hand: Intl wording differs between runtimes (ICU builds). */
const formatWhen = (ts: string | number | Date): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
};

const hostOf = (report: AuditReport): string => {
  try {
    return new URL(report.baseUrl).hostname.replace(/^www\./, "");
  } catch {
    return report.baseUrl;
  }
};

const SectionHead = ({ title, sub }: { title: string; sub?: string }) => (
  <div className="mb-4 mt-12 flex flex-wrap items-baseline gap-x-3 border-b border-border pb-3">
    <h2 className="text-xl font-bold tracking-tight">{title}</h2>
    {sub && <span className="text-sm text-muted-foreground">{sub}</span>}
  </div>
);

type Effort = "quick-win" | "moderate" | "significant";
const EFFORT_COLOR: Record<Effort, BadgeColor> = {
  "quick-win": "green",
  moderate: "blue",
  significant: "purple",
};

/**
 * Strategic issues (repo#3064): changes that fix several findings at once,
 * from the detected stack. Cloud-only and not on the AuditReport type yet, so
 * read defensively; a local report never has them.
 */
interface StrategicIssueView {
  slug: string;
  title: string;
  description: string;
  actions: string;
  severity: "critical" | "high" | "medium" | "low";
  effort: Effort;
  ruleIds: string[];
}
const STRATEGIC_SEVERITY: Record<StrategicIssueView["severity"], BadgeColor> = {
  critical: "red",
  high: "orange",
  medium: "yellow",
  low: "neutral",
};

/** Model-authored markdown, shown as plain text (React escapes it; never HTML). */
const plainInline = (s: string): string =>
  s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
const actionSteps = (md: string): string[] =>
  md
    .split("\n")
    .map((l) => plainInline(l.trim().replace(/^(\d+[.)]|[-*+])\s+/, "")))
    .filter(Boolean);

/**
 * Copy-to-agent button. With script it copies the prompt and says so; without
 * (or if the clipboard is refused) it opens to show the prompt for selection.
 */
function CopyPrompt({ text, label = "Copy fix prompt" }: { text: string; label?: string }) {
  return (
    <details className="copy-prompt">
      <summary
        data-copy
        className="inline-flex cursor-pointer select-none items-center gap-1.5 border border-border bg-card px-2 py-1 text-xs font-medium text-foreground hover:border-primary/40"
        title="Copy a prompt for your coding agent"
      >
        <Sym id="copy" className="copy-icon size-3.5" />
        <Sym id="check" className="copied-icon size-3.5 text-primary" />
        <span data-copy-label>{label}</span>
      </summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed">
        {text}
      </pre>
    </details>
  );
}

/**
 * Finding copy buttons: the prompt is the shared head, then the finding's body
 * from #fix-prompts with the data note expanded. Everything in the JSON was
 * bounded and sanitised on the server; the script only joins strings.
 */
const FINDING_COPY_SCRIPT = `(function(){var el=document.getElementById("fix-prompts");if(!el||!navigator.clipboard)return;var data;try{data=JSON.parse(el.textContent)}catch(e){return}document.querySelectorAll("[data-copy-rule]").forEach(function(b){if(data.rules[b.getAttribute("data-copy-rule")])b.hidden=false});document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-copy-rule]");if(!b)return;var body=data.rules[b.getAttribute("data-copy-rule")];if(!body)return;var text=data.head+"\\n\\n"+body.split("\\n").map(function(l){return l===data.token?data.note:l}).join("\\n");navigator.clipboard.writeText(text).then(function(){var l=b.querySelector("[data-copy-label]"),t=l.textContent;l.textContent="Copied";b.setAttribute("data-copied","");clearTimeout(b._t);b._t=setTimeout(function(){l.textContent=t;b.removeAttribute("data-copied")},1600)})})})();`;

/** Builds the Pages view from the finding rows (DOM APIs and textContent only). */
const PAGES_SCRIPT = `(function(){var sec=document.getElementById("pages"),list=document.getElementById("pages-list");if(!sec||!list)return;var by={};document.querySelectorAll("details.issue").forEach(function(d){var id=d.id.slice(5),n=d.querySelector("summary .font-semibold"),name=n?n.textContent:id,sev=d.getAttribute("data-sev"),lab=d.getAttribute("data-sev-label"),g=d.getAttribute("data-group"),seen={};d.querySelectorAll("a.pg").forEach(function(a){var u=a.href;if(seen[u])return;seen[u]=1;(by[u]=by[u]||{u:u,p:(a.firstChild&&a.firstChild.nodeValue)||"/",r:[]}).r.push({id:id,name:name,sev:sev,lab:lab,g:g})})});var rows=Object.keys(by).map(function(k){var x=by[k];x.e=x.r.filter(function(r){return r.sev==="error"}).length;x.o=x.r.length-x.e;return x}).sort(function(a,b){return b.e-a.e||b.o-a.o||(a.u<b.u?-1:1)});if(!rows.length)return;var CAP=40,NS="http://www.w3.org/2000/svg";function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e}function icon(id,c){var s=document.createElementNS(NS,"svg");s.setAttribute("class",c);s.setAttribute("aria-hidden","true");s.setAttribute("fill","currentColor");var u=document.createElementNS(NS,"use");u.setAttribute("href","#i-"+id);s.appendChild(u);return s}var SEV={error:"tag tag-red",info:"tag tag-blue",warning:"tag tag-yellow"};rows.slice(0,CAP).forEach(function(x){var det=el("details","prow group border-b border-border last:border-b-0"),sum=el("summary","flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-muted/50 group-open:bg-muted/50");sum.appendChild(icon("caret","chev size-3.5 shrink-0 text-muted-foreground transition-transform"));var path=el("span","min-w-0 flex-1 truncate font-mono text-[13px]",x.p);path.title=x.u;sum.appendChild(path);if(x.e)sum.appendChild(el("span",SEV.error,x.e+(x.e===1?" error":" errors")));if(x.o)sum.appendChild(el("span",SEV.warning,x.o+" other"));var out=el("a","text-muted-foreground hover:text-foreground");out.href=x.u;out.target="_blank";out.rel="noreferrer";out.setAttribute("aria-label","Open page");out.appendChild(icon("out","size-3.5"));sum.appendChild(out);det.appendChild(sum);var ul=el("ul","grid gap-1.5 px-4 pb-4 pl-11 text-sm");x.r.forEach(function(r){var li=el("li","row");li.appendChild(el("span",SEV[r.sev]||SEV.warning,r.lab));var gt=el("span","gtag",r.g==="ai"?"Agents":r.g==="seo"?"SEO":r.g==="performance"?"Performance":r.g==="security"?"Security":r.g);gt.setAttribute("data-g",r.g);li.appendChild(gt);var a=el("a","lnk",r.name);a.href="#rule-"+r.id;li.appendChild(a);ul.appendChild(li)});det.appendChild(ul);list.appendChild(det)});if(rows.length>CAP){var note=document.getElementById("pages-note");if(note)note.textContent="Showing "+CAP+" of "+rows.length+" pages with findings. "+note.textContent}sec.hidden=false})();`;

const COPY_SCRIPT = `document.addEventListener("click",function(e){var s=e.target.closest&&e.target.closest("[data-copy]");if(!s)return;var d=s.parentElement,pre=d&&d.querySelector("pre");if(!pre||!navigator.clipboard||d.open)return;e.preventDefault();navigator.clipboard.writeText(pre.textContent).then(function(){var l=s.querySelector("[data-copy-label]"),t=l.textContent;l.textContent="Copied";s.setAttribute("data-copied","");clearTimeout(s._t);s._t=setTimeout(function(){l.textContent=t;s.removeAttribute("data-copied")},1600)},function(){d.open=true})});`;

/**
 * Report time in the reader's own timezone; the server renders UTC, which stays
 * as the fallback without script. An image that fails to load (favicon, tech
 * icon, a screenshot not captured yet) is hidden, with its frame when it has one.
 */
const LOCAL_TIME_SCRIPT = `document.querySelectorAll("time[data-local-time]").forEach(function(t){var d=new Date(t.getAttribute("datetime"));if(isNaN(d))return;t.textContent=new Intl.DateTimeFormat(undefined,{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",timeZoneName:"short"}).format(d);t.title=d.toISOString()});document.querySelectorAll("img[data-favicon],img[data-hide-broken]").forEach(function(i){function h(){(i.closest("[data-hide-scope]")||i).style.display="none"}if(i.complete&&!i.naturalWidth)h();else i.addEventListener("error",h)});`;

/** The audit levels guide: what each level reads and how to raise the depth. */
export const AUDIT_LEVELS_DOCS_URL = "https://docs.squirrelscan.com/guides/audit-levels";

/** localStorage key prefix for a dismissed notice; the notice's key follows it. */
export const NOTICE_STORAGE_PREFIX = "squirrelscan:notice-dismissed:";

/**
 * The dismiss control on every notice line (the coverage notice, pub#1046, and
 * the notes under it). A notice is visible as rendered; this only hides it, for
 * this report in this browser. The button stays hidden without script (it could
 * do nothing), and every storage access is guarded: a private window, blocked
 * site data or a file:// page that refuses storage still renders the notice and
 * still dismisses it for the visit. The prefix is a literal (no interpolation
 * into script text); a test pins it to NOTICE_STORAGE_PREFIX.
 */
const NOTICE_SCRIPT = `(function(){var p="squirrelscan:notice-dismissed:";document.querySelectorAll("[data-notice-key]").forEach(function(n){var k=p+n.getAttribute("data-notice-key"),b=n.querySelector("[data-dismiss-notice]");try{if(window.localStorage.getItem(k)==="1"){n.hidden=true;return}}catch(e){}if(!b)return;b.hidden=false;b.addEventListener("click",function(){n.hidden=true;try{window.localStorage.setItem(k,"1")}catch(e){}})})})();`;

/** 32-bit FNV-1a, hex: a stable, short storage key from report fields. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Math.imul keeps it a signed 32-bit int: read it as unsigned.
  return (h < 0 ? h + 0x1_0000_0000 : h).toString(16).padStart(8, "0");
}

/**
 * Which report a dismissal belongs to: the published report id, or for a local
 * report (no id) a hash of the site and the time it was generated, so a new
 * audit of the same site shows its notice again.
 */
export function coverageNoticeKey(
  report: Pick<AuditReport, "baseUrl" | "timestamp">,
  reportId?: string,
): string {
  const id = (reportId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (id) return `r-${id}`;
  return `h-${fnv1a(`${String(report.baseUrl ?? "")}\n${String(report.timestamp ?? "")}`)}`;
}

/** A notice's dismiss button; NOTICE_SCRIPT reveals and wires it. */
function DismissButton() {
  return (
    <button
      type="button"
      data-dismiss-notice
      hidden
      aria-label="Dismiss this notice"
      title="Dismiss"
      className="-my-0.5 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"
    >
      <PiX className="size-3.5" />
    </button>
  );
}

/** A note's dismiss key: the report's key plus a hash of its text, so each note is dismissed on its own. */
export function noteKey(reportKey: string, text: string): string {
  return `${reportKey}:${fnv1a(text)}`;
}

/**
 * The one-line partial-coverage notice (pub#1046): the report may not cover the
 * whole site, how to raise the audit depth, and the audit levels guide. A count
 * is printed only when pages beyond the scanned set are known; a capped crawl
 * with nothing known past it never reads "0+ pages".
 */
function CoverageNotice({
  gap,
  carried,
  clamped,
  noticeKey,
}: {
  gap: CoverageGap;
  /** The rest of the known pages are carried from earlier audits (smart audits). */
  carried: boolean;
  /** The page limit was reduced below the one requested (#1909). */
  clamped: { requested: number; effective: number } | null;
  noticeKey: string;
}) {
  const more = gap.moreKnown;
  const known =
    more > 0
      ? carried
        ? ` (${more.toLocaleString("en-US")} more known ${more === 1 ? "page" : "pages"} carried from earlier audits)`
        : ` (${more.toLocaleString("en-US")}+ more ${more === 1 ? "page" : "pages"} known)`
      : "";
  const code = "bg-muted px-1 py-px font-mono text-[11px] text-foreground";
  return (
    <>
      <div
        id="coverage-notice"
        role="note"
        data-notice-key={noticeKey}
        className="mb-6 flex items-start gap-2 border border-border border-l-[3px] border-l-accent bg-card px-3 py-1.5 text-xs leading-5 text-muted-foreground"
      >
        <PiWarning className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="min-w-0 flex-1">
          {`This report may not cover the whole site${known}. `}
          {clamped ? (
            `This run was limited to ${clamped.effective.toLocaleString("en-US")} of the ${clamped.requested.toLocaleString("en-US")} pages requested, so raising the limit alone will not extend it. `
          ) : (
            <>
              Raise the audit depth in the CLI (<code className={code}>--level full</code>,{" "}
              <code className={code}>--max-pages N</code>) or in the cloud website settings.{" "}
            </>
          )}
          <a href={AUDIT_LEVELS_DOCS_URL} target="_blank" rel="noreferrer" className="lnk">
            Audit levels
          </a>
        </p>
        <DismissButton />
      </div>
    </>
  );
}

/** Rule id → its parent group (the rule's row when on this page, else its category). */
type Known = Map<string, string>;
const ruleGroup = (id: string, known: Known): string =>
  known.get(id) ?? getCategoryGroup(id.split("/")[0] ?? "");

/** Group colour as a CSS variable, so Tailwind classes can use `var(--gc)`. */
const gcVar = (group: string) =>
  ({
    "--gc": getGroupColor(group).base,
    "--gc-bg": getGroupColor(group).bg,
  }) as React.CSSProperties;

/** The distinct parent groups a list of rule ids touches, most-cited first (ties in group order). */
const groupsOf = (ids: string[], known: Known): string[] => {
  const count = new Map<string, number>();
  for (const id of new Set(ids)) {
    const g = ruleGroup(id, known);
    count.set(g, (count.get(g) ?? 0) + 1);
  }
  return GROUPS.filter((g) => count.has(g)).sort((a, b) => count.get(b)! - count.get(a)!);
};

/** Rule ids as chips in their group's colour; the ones with a row on this page link to it. */
function RuleChips({ ids, known }: { ids: string[]; known: Known }) {
  if (ids.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const c = getGroupColor(ruleGroup(id, known));
        const style = { color: c.text, background: c.bg, borderColor: c.border };
        const cls = "border px-1.5 py-0.5 font-mono text-[11px]";
        return known.has(id) ? (
          <a key={id} href={`#rule-${id}`} className={`${cls} hover:underline`} style={style}>
            {id}
          </a>
        ) : (
          <span key={id} className={cls} style={style}>
            {id}
          </span>
        );
      })}
    </div>
  );
}

/**
 * One merged issue: an editor's-summary priority, a strategic fix, or both when
 * they cover the same rules. All text but the rule ids is model-written.
 */
interface TopIssue {
  key: string;
  title: string;
  why?: string;
  action?: string;
  steps: string[];
  severity?: StrategicIssueView["severity"];
  effort: Effort;
  ruleIds: string[];
  technologies: string[];
}

const SEVERITY_RANK: Record<StrategicIssueView["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Share of the smaller rule set the two cover together (0 when either is empty). */
const overlap = (a: string[], b: string[]): number => {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  return a.filter((id) => sb.has(id)).length / Math.min(a.length, new Set(b).size);
};

/**
 * Priorities keep the editor's ranking; each strategic fix that shares at least
 * half of its rules with an unmatched priority folds into it (its steps and
 * severity join the priority). The rest follow, most severe first.
 */
function mergeIssues(
  priorities: EditorSummaryPriority[],
  strategic: StrategicIssueView[],
): TopIssue[] {
  const out: TopIssue[] = priorities.map((p, i) => ({
    key: `p${i}`,
    title: p.title,
    why: p.why || undefined,
    action: p.action,
    steps: [],
    effort: p.effort,
    ruleIds: [...p.ruleIds],
    technologies: [...new Set(p.technologies)],
  }));
  const taken = new Set<number>();
  const rest: TopIssue[] = [];
  for (const s of strategic) {
    let best = -1;
    let bestScore = 0;
    for (const [i, t] of out.entries()) {
      const score = taken.has(i) ? 0 : overlap(s.ruleIds, t.ruleIds);
      if (score > bestScore) [best, bestScore] = [i, score];
    }
    const steps = actionSteps(s.actions);
    if (best >= 0 && bestScore >= 0.5) {
      taken.add(best);
      const t = out[best]!;
      t.steps = steps;
      t.severity = s.severity;
      t.ruleIds = [...new Set([...t.ruleIds, ...s.ruleIds])];
    } else {
      rest.push({
        key: `s-${s.slug}`,
        title: s.title,
        why: plainInline(s.description),
        steps,
        severity: s.severity,
        effort: s.effort,
        ruleIds: s.ruleIds,
        technologies: [],
      });
    }
  }
  rest.sort((a, b) => SEVERITY_RANK[a.severity ?? "low"] - SEVERITY_RANK[b.severity ?? "low"]);
  return [...out, ...rest];
}

function TopIssues({
  items,
  known,
  ctx,
  techName,
  techIcon,
  offline,
}: {
  items: TopIssue[];
  known: Known;
  ctx: PromptContext;
  techName: Map<string, string>;
  techIcon: Map<string, string | undefined>;
  offline: boolean;
}) {
  return (
    <section id="issues" data-issues="ranked">
      <div className="mb-4 mt-12 flex flex-wrap items-baseline gap-x-3 gap-y-2 border-b border-border pb-3">
        <h2 className="text-xl font-bold tracking-tight">Issues</h2>
        <span className="text-sm text-muted-foreground">
          What to fix, in order. Each one may clear several findings.
        </span>
        <span className="flex-1" />
        <CopyPrompt text={fixPlanPrompt(items, ctx)} label="Copy fix plan" />
      </div>
      <ol className="grid gap-3">
        {items.map((t, i) => {
          const gs = groupsOf(t.ruleIds, known);
          return (
            <li key={t.key}>
              <Panel
                className="grid grid-cols-[2rem_minmax(0,1fr)] gap-4 border-l-[3px] border-l-[var(--gc)]"
                style={gcVar(gs[0] ?? "")}
              >
                <span className="flex size-8 items-center justify-center border border-border bg-muted text-sm font-bold text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold tracking-tight">{t.title}</h3>
                    {t.severity && (
                      <Badge color={STRATEGIC_SEVERITY[t.severity] ?? "neutral"} appearance="tag">
                        {t.severity}
                      </Badge>
                    )}
                    <Badge color={EFFORT_COLOR[t.effort] ?? "blue"} appearance="tag">
                      {priorityEffortLabel(t.effort)}
                    </Badge>
                    {gs.map((g) => (
                      <GroupBadge key={g} group={g} />
                    ))}
                    {t.technologies.map((id) => (
                      <Badge key={id} color="neutral" size="md">
                        <TechIcon icon={techIcon.get(id)} offline={offline} />
                        {techName.get(id) ?? id}
                      </Badge>
                    ))}
                  </div>
                  {t.why && (
                    <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">{t.why}</p>
                  )}
                  {t.action && <p className="mt-1.5 max-w-prose text-sm">{t.action}</p>}
                  {t.steps.length > 0 && (
                    <ol className="mt-2 max-w-prose list-decimal space-y-1 pl-5 text-sm">
                      {t.steps.map((step, j) => (
                        <li key={j}>{step}</li>
                      ))}
                    </ol>
                  )}
                  <RuleChips ids={t.ruleIds} known={known} />
                  <div className="mt-3">
                    <CopyPrompt text={fixPrompt(t, ctx)} />
                  </div>
                </div>
              </Panel>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Local (signed-out) audits: what the cloud adds, spelled out, plus the checks that did not run. */
function CloudUpsell({ report }: { report: AuditReport }) {
  const locked = report.lockedRules ?? [];
  return (
    <section id="cloud" className="mt-8">
      <Panel className="border-t-[3px] border-t-primary">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-2xl">
            <h2 className="text-lg font-bold tracking-tight">
              Get the full audit with squirrelscan cloud
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This audit ran on your machine, without the cloud checks. A free account adds these to
              the same report, with 500 free credits every month and no card needed.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2">
            <code className="border border-border bg-muted px-3 py-1.5 font-mono text-sm">
              squirrel auth login
            </code>
            <a
              href="https://squirrelscan.com"
              target="_blank"
              rel="noreferrer"
              className="text-sm font-semibold text-primary hover:underline"
            >
              Create a free account
            </a>
          </div>
        </div>
        <ul className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {CLOUD_FEATURES.map(([name, what]) => (
            <li key={name}>
              <p className="font-semibold">{name}</p>
              <p className="text-muted-foreground">{what}</p>
            </li>
          ))}
        </ul>
        {locked.length > 0 && (
          <div className="mt-5 border-t border-border pt-4">
            <p className="mb-2 text-sm text-muted-foreground">
              {plural(locked.length, "check")} on this site {locked.length === 1 ? "needs" : "need"}{" "}
              the cloud and did not run:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {locked.map((r) => (
                <Badge color="neutral" size="md" key={r.id}>
                  <PiLockSimple className="size-3.5" /> {r.name}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </section>
  );
}

const groupCard =
  "flex flex-col items-center gap-2 border border-border border-t-[3px] border-t-[var(--gc)] bg-card p-4 text-center";

/** The header's small .md / .json links for agents. */
const agentLink =
  "inline-flex min-h-8 items-center gap-1.5 border border-border bg-card px-3 py-1.5 font-mono text-xs transition-colors hover:border-primary/40";

function PageLinks({
  pages,
  count,
  carried,
  summary,
  collapsed,
}: {
  pages: string[];
  count: number;
  carried?: string[];
  /**
   * Replaces the default "N pages affected" label where the list is NOT the check's whole
   * affected set (#2307): a fix group's own pages, or the remainder no group accounted for.
   */
  summary?: (total: number) => string;
  /** Start closed whatever the count: the check's findings name their region (pub#846). */
  collapsed?: boolean;
}) {
  if (pages.length === 0) return null;
  const total = Math.max(count, pages.length);
  const carriedSet = carried && carried.length > 0 ? new Set(carried) : undefined;
  const shown = pages.slice(0, REPORT_PAGES_HARD_CAP);
  const inline = shown.slice(0, REPORT_PAGES_INLINE_CAP);
  const overflow = shown.slice(REPORT_PAGES_INLINE_CAP);
  const link = (p: string, i: number) => (
    <a key={i} href={sanitizeUrl(p)} target="_blank" rel="noreferrer" className="lnk-b pg">
      {getPathname(p) || "/"}
      {carriedSet?.has(p) && (
        <span className="sub-tag" title="Not re-checked this run">
          carried
        </span>
      )}
    </a>
  );
  return (
    <details className="mt-1" open={!collapsed && total <= REPORT_COLLAPSE_THRESHOLD}>
      <summary className="more">
        {summary ? summary(total) : `${plural(total, "page")} affected`}
      </summary>
      <div className="plist">
        {total > shown.length && (
          <p className="text-muted-foreground">
            Showing {shown.length.toLocaleString()} of {total.toLocaleString()} affected pages.
          </p>
        )}
        {inline.map(link)}
        {overflow.length > 0 && (
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              +{overflow.length} more
            </summary>
            <div className="mt-1 grid gap-0.5">
              {overflow.map((p, i) => link(p, i + inline.length))}
            </div>
          </details>
        )}
        {shown.length > REPORT_COLLAPSE_THRESHOLD && (
          <details>
            <summary className="cursor-pointer text-muted-foreground">Copy as text</summary>
            <textarea
              readOnly
              rows={Math.min(shown.length, 10)}
              defaultValue={shown.join("\n")}
              className="mt-1 block w-full resize-y border border-border bg-muted p-2 text-xs"
            />
          </details>
        )}
      </div>
    </details>
  );
}

/**
 * The shared sentence, with the block's own name lifted out for emphasis.
 *
 * The STRING comes from `fixRollupLine`, the one the markdown, text, llm and
 * console surfaces print, called with the same page limit and the same path
 * formatter markdown uses, so the five cannot drift and this file decides
 * nothing about wording. The only thing done here is presentational: the label
 * `describeRoot` produced is located in that finished sentence and wrapped, so
 * the most useful token in the card ("Downloads") reads as a name. Splitting a
 * string into two text nodes cannot change its text, so the card still says
 * exactly what markdown says, and a label the sentence does not contain (or no
 * label at all) renders the sentence untouched.
 */
function FixSentence({ unit }: { unit: ReturnType<typeof fixUnits>[number] }) {
  const sentence = fixRollupLine(unit, REPORT_SOURCE_PAGES_PREVIEW, (page) => getPathname(page) || "/");
  const label = describeRoot(unit);
  const at = label ? sentence.indexOf(label) : -1;
  if (!label || at < 0) return <>{sentence}</>;
  return (
    <>
      {sentence.slice(0, at)}
      <span className="fix-group-name">{label}</span>
      {sentence.slice(at + label.length)}
    </>
  );
}

/**
 * Shared-component fix cards (#2307): the finding the legacy per-page list was
 * approximating, one defect, one repair, N pages.
 *
 * Cards are derived per RULE, not per check: coverage arithmetic is per-rule,
 * and checks merge by message, so keying a card to a check row would print the
 * same repair once per merged row. They sit directly above the check list they
 * replace.
 *
 * Every string here is site-controlled (defect values are crawled text, block
 * names and pages are crawled too) and reaches the page as a React text child
 * or through `sanitizeUrl` inside PageLinks. No hashes, signatures or
 * family/variant keys: the element slot the sentence carries is the humane tail
 * of the locator. Exported so a test can hand it a rolled-up component
 * directly, rather than reconstructing a seven-slot block through the whole
 * grouping stage to reach the one branch that differs.
 */
export function FixGroupCards({ coverage }: { coverage: FixCoverage }) {
  // `ruleFixCoverage` has already applied this filter; re-applying it means the
  // card renderer cannot be made to phrase an attribution it does not know,
  // whatever hands it a coverage.
  const groups = coverage.groups.filter(isRenderableFixGroup);
  if (groups.length === 0) return null;
  return (
    <ul className="fix-groups">
      {/* Rolled up the same way and in the same order as every other surface,
          including the family level: one block with two structural variants is
          one card that says so, never two cards this file merged itself. */}
      {fixUnits(groups).map((unit) => {
        const group = unit.representative;
        const repeated = group.attribution === "repeated-subtree";
        return (
          <li className={`fix-group${repeated ? " fix-group-weak" : ""}`} key={group.id}>
            <div className="fix-group-head">
              <span className={`fix-badge${repeated ? " fix-badge-weak" : ""}`}>
                {repeated ? "Likely shared block" : "Fix once"}
              </span>
              {/* The paragraph holds the shared sentence and NOTHING else, so
                  its text can be compared with markdown's, character for
                  character, by a test. */}
              <p className="fix-group-line">
                <FixSentence unit={unit} />
              </p>
            </div>
            <PageLinks
              pages={unit.affectedPages}
              count={unit.affectedPageCount}
              summary={(total) => `Affected pages (${total})`}
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Shared-resource fix cards (#2341).
 *
 * Deliberately the same markup as {@link FixGroupCards}, down to the class
 * names, because it is the same claim about a different kind of evidence: one
 * defect, one repair, N pages. The SENTENCE comes from `siteResourceFixLine`,
 * the one markdown, text, llm and console print, called with the same page
 * limit and the same path formatter markdown uses, so this file decides no
 * wording of its own and the five surfaces cannot drift.
 */
export function SiteResourceFixCards({ coverage }: { coverage: SiteResourceCoverage }) {
  if (coverage.groups.length === 0) return null;
  return (
    <ul className="fix-groups">
      {coverage.groups.map((group) => (
        <li className="fix-group" key={group.id}>
          <div className="fix-group-head">
            <span className="fix-badge">Fix once</span>
            {/* The paragraph holds the shared sentence and NOTHING else, so its
                text can be compared with markdown's, character for character. */}
            <p className="fix-group-line">
              {siteResourceFixLine(
                group,
                REPORT_SOURCE_PAGES_PREVIEW,
                (page) => getPathname(page) || "/",
              )}
            </p>
          </div>
          <PageLinks
            pages={group.affectedPages}
            count={group.affectedPageCount}
            summary={(total) => `Affected pages (${total})`}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * The pages an item was found on, one row each (pub#837): "from: /about (2 links, in the
 * footer)". The first few show; the rest expand in place, so the full list sits inside the item
 * rather than in the check's page list, which lists the check's pages, not this item's. Rows past
 * the hard cap, and pages a published report does not list, are counted, never dropped silently.
 */
function ItemSources({
  item,
  structure,
}: {
  item: CheckItem;
  structure: ReportStructure | undefined;
}) {
  const view = itemSourceView(item, structure);
  const renderRow = (row: ItemSourceRow, j: number) => (
    <p key={j} className="ind">
      from{" "}
      <a href={sanitizeUrl(row.page)} target="_blank" rel="noreferrer" className="lnk">
        {getPathname(row.page) || "/"}
      </a>
      {row.detail ? ` (${row.detail})` : ""}
    </p>
  );
  if (view.scope) {
    // pub#846: one line for the region; every listed page stays in the item, collapsed.
    const all = view.all.slice(0, REPORT_PAGES_HARD_CAP);
    const total = Math.max(view.scope.pages + view.scope.otherPages, view.all.length);
    return (
      <div>
        <p className="ind region-scope">{regionScopeLine(view.scope)}</p>
        {all.length > 0 && (
          <details className="ind">
            <summary className="more">
              {all.length < total ? `${all.length} of ${total} pages` : `All ${all.length} pages`}
            </summary>
            {all.map(renderRow)}
          </details>
        )}
      </div>
    );
  }
  const { rows } = view;
  if (rows.length === 0 && view.total === 0) return null;
  const materialized = rows.slice(0, REPORT_PAGES_HARD_CAP);
  const shown = materialized.slice(0, REPORT_SOURCE_PAGES_PREVIEW);
  const rest = materialized.slice(REPORT_SOURCE_PAGES_PREVIEW);
  const notShown = Math.max(0, view.total - materialized.length);
  return (
    <div>
      {shown.map(renderRow)}
      {rest.length > 0 && (
        <details className="ind">
          <summary className="more">{moreSourcePages(rest.length)}</summary>
          {rest.map((row, j) => renderRow(row, REPORT_SOURCE_PAGES_PREVIEW + j))}
        </details>
      )}
      {notShown > 0 && <p className="ind">{moreSourcePages(notShown)} not listed here</p>}
    </div>
  );
}

function CheckBlock({
  check,
  coverage,
  structure,
}: {
  check: GroupedCheck;
  coverage: FixCoverage;
  structure: ReportStructure | undefined;
}) {
  const ap = affectedPages(check);
  const items = check.items?.filter((i) => !isRedundantPageItem(i));
  // Items a capped report dropped (#2661): counted, so a short list never reads as the whole set.
  const notListed = itemsNotListed(check);
  const carriedLabel = checkUnrenderedLabel(check) ?? checkCarriedLabel(check);
  const partial =
    !carriedLabel && (check.carriedCount ?? 0) > 0
      ? `${check.carriedCount} of ${check.count} carried from previous crawls.`
      : null;
  // pub#846/#857: a check that only reads one shared region, or sits on every page of one page
  // type, names it.
  const checkScope = checkScopeLine(check, ap.count, structure);
  // #2307: a fully covered rule has already named every affected page, once per repair, and
  // repeating them per check is the noise the cards replace. Partial coverage keeps the
  // remainder, labelled, so "not grouped" never reads as "not affected".
  const legacyPages =
    coverage.mode === "full"
      ? []
      : coverage.mode === "partial"
        ? ap.sample.filter((page) => coverage.uncoveredPages.includes(page))
        : ap.sample;
  return (
    <div className="flex gap-2 text-sm">
      <span className={check.status === "fail" ? "cb-mark cb-fail" : "cb-mark cb-warn"} aria-hidden>
        {check.status === "fail" ? "✗" : "!"}
      </span>
      <div className="min-w-0">
        <p>
          {check.message}
          {/* pub#837: a check whose items are links says how many pages carry them. */}
          {hasItemSources(check)
            ? affectedPagesSuffix(check, ap.count)
            : ap.count > 1 && (
                <span className="text-muted-foreground"> · {plural(ap.count, "page")}</span>
              )}
        </p>
        {(carriedLabel || partial) && (
          <p className="text-xs text-muted-foreground">{carriedLabel ?? partial}</p>
        )}
        {checkScope && <p className="region-scope">{checkScope}</p>}
        <PageLinks
          pages={legacyPages}
          // Partial coverage: the authoritative total for THIS list is the remainder, not the
          // check's whole affected set.
          count={coverage.mode === "partial" ? legacyPages.length : ap.count}
          carried={check.carriedPages}
          collapsed={checkPagesScopedAway(check, ap.count, structure)}
          {...(coverage.mode === "partial"
            ? {
                summary: (total: number) => `Pages not attributed to a shared component (${total})`,
              }
            : {})}
        />
        {items && items.length > 0 && (
          <details className="mt-1" open={items.length <= REPORT_ITEMS_COLLAPSE_THRESHOLD}>
            <summary className="more">
              {plural(items.length, "item")}
              {notListed > 0 ? `, ${notListed.toLocaleString("en-US")} more not listed` : ""}
            </summary>
            <div className="mt-2 grid gap-2 font-mono text-xs">
              {items.map((item, i) => {
                // pub#846: a scoped item's label drops the section phrase its region line says.
                const ownLabel = itemLabel(item, itemRegionScope(item, structure));
                return (
                  <div key={i}>
                    {isPageUrl(item.id) ? (
                      <a
                        href={sanitizeUrl(item.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="lnk-b"
                      >
                        {getPathname(item.id) || "/"}
                        {ownLabel ? ` · ${ownLabel}` : ""}
                      </a>
                    ) : (
                      <span className="break-all">{ownLabel ?? item.id}</span>
                    )}
                    <ItemSources item={item} structure={structure} />
                  </div>
                );
              })}
            </div>
          </details>
        )}
        {(!items || items.length === 0) && notListed > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">{itemsNotListedLine(notListed)}</p>
        )}
      </div>
    </div>
  );
}

function reach(rule: FlatIssue, totalPages: number) {
  const rollup = ruleAffectedRollup(rule.checks);
  const sampleCount = ruleAffectedPageCount(rule.checks);
  const carried = ruleCarriedPageCount(rule.checks);
  return {
    count: rollup.count,
    hasMore: rollup.hasMore,
    pct: totalPages > 0 ? Math.min(100, Math.round((rollup.count / totalPages) * 100)) : 0,
    label:
      rollup.count === 0
        ? "site-wide"
        : `${rollup.count}${rollup.hasMore ? "+" : ""} ${rollup.count === 1 && !rollup.hasMore ? "page" : "pages"}`,
    carriedRollup: ruleCarriedRollupLine(carried, sampleCount),
    fullyCarried: carried > 0 && carried >= sampleCount,
  };
}

function IssueRow({
  rule,
  totalPages,
  structure,
}: {
  rule: FlatIssue;
  totalPages: number;
  structure: ReportStructure | undefined;
}) {
  const r = reach(rule, totalPages);
  const live = rule.checks.filter((c) => c.status === "fail" || c.status === "warn");
  // #2307: which pages, if any, a shared-component fix already accounts for. `none` (no
  // evidence, one-page groups, an attribution this build cannot phrase) leaves everything
  // below exactly as it was before the feature existed. #2341: shared-resource units
  // narrow that coverage, so a page a resource card names is not also listed below as
  // unattributed.
  const siteResources = ruleSiteResourceCoverage(rule);
  const coverage = withSiteResourceCoverage(ruleFixCoverage(rule), siteResources, rule);
  return (
    <details
      className="issue ir group"
      id={`rule-${rule.id}`}
      data-group={rule.group}
      data-sev={rule.severity}
      data-sev-label={severityLabel(rule.severity)}
      style={gcVar(rule.group)}
    >
      <summary className="ir-sum">
        <Sym id="caret" className="chev ir-chev" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{rule.name}</span>
            <GTag group={rule.group} category={rule.categoryCode} />
            {r.fullyCarried && (
              <Badge color="neutral" appearance="tag" className="carried-badge">
                carried
              </Badge>
            )}
          </div>
          {live[0] && <p className="issue-msg ir-msg">{live[0].message}</p>}
        </div>
        <div className="ir-reach">
          {r.label}
          {totalPages > 1 && (
            <div className="mt-1.5 h-1 overflow-hidden bg-muted sm:ml-auto">
              <div className="h-full bg-[var(--gc)]" style={{ width: `${Math.max(r.pct, 4)}%` }} />
            </div>
          )}
        </div>
      </summary>
      <div className="grid gap-4 px-4 pb-5 pt-1 sm:pl-11">
        {rule.description && (
          <p className="max-w-prose text-sm text-muted-foreground">{rule.description}</p>
        )}
        {rule.solution && live.length > 0 && (
          <Panel tone="selected" padded={false} className="max-w-prose p-3">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-primary">
              How to fix
            </p>
            <p className="text-sm">{rule.solution}</p>
          </Panel>
        )}
        {live.length > 0 && (
          <div>
            {/* Built from #fix-prompts on click; hidden until the page script runs. */}
            <button type="button" className="cp-btn" data-copy-rule={rule.id} hidden>
              <Sym id="copy" className="copy-icon size-3.5" />
              <Sym id="check" className="copied-icon size-3.5 text-primary" />
              <span data-copy-label>Copy fix prompt</span>
            </button>
          </div>
        )}
        {r.carriedRollup && <p className="text-xs text-muted-foreground">{r.carriedRollup}</p>}
        {rule.mixedProvenanceNote && (
          <p className="text-xs text-primary">{rule.mixedProvenanceNote}</p>
        )}
        <SiteResourceFixCards coverage={siteResources} />
        <FixGroupCards coverage={coverage} />
        <div className="grid gap-3">
          {rule.checks.map((c, i) => (
            <CheckBlock check={c} coverage={coverage} structure={structure} key={i} />
          ))}
        </div>
        <div className="ir-foot">
          <code className="font-mono">{rule.id}</code>
          <a href={getDocsUrl(rule.id)} target="_blank" rel="noreferrer" className="ir-docs">
            Rule docs <Sym id="out" className="size-3" />
          </a>
        </div>
      </div>
    </details>
  );
}

function Issues({
  issues,
  totalPages,
  ctx,
  structure,
}: {
  issues: FlatIssue[];
  totalPages: number;
  ctx: PromptContext;
  structure: ReportStructure | undefined;
}) {
  const counts: Record<string, number> = {};
  for (const i of issues) counts[i.group] = (counts[i.group] ?? 0) + 1;
  const present = GROUPS.filter((g) => counts[g]);
  return (
    <section id="findings">
      <SectionHead
        title="Findings"
        sub={`${plural(issues.length, "rule")} flagged, ranked by severity then impact`}
      />
      <span className="filter-anchor group-filter" id="g-all" />
      {present.map((g) => (
        <span className="filter-anchor group-filter" id={`g-${g}`} key={g} />
      ))}
      <div className="chips mb-5 flex flex-wrap gap-2">
        <a className="chip-link" href="#g-all">
          All <b>{issues.length}</b>
        </a>
        {present.map((g) => (
          <a className="chip-link chip-group" href={`#g-${g}`} key={g} style={gcVar(g)}>
            {getGroupName(g)} <b>{counts[g]}</b>
          </a>
        ))}
      </div>
      <script
        type="application/json"
        id="fix-prompts"
        dangerouslySetInnerHTML={{
          __html: inlineJson({
            ...sharedPromptParts(ctx),
            token: NOTE_TOKEN,
            rules: Object.fromEntries(
              issues
                .filter((r) => r.checks.some((c) => c.status === "fail" || c.status === "warn"))
                .map((r) => [r.id, issuePromptBody(r, ctx)]),
            ),
          }),
        }}
      />
      <div className="bands">
        {BAND_ORDER.map((sev) => {
          const rows = issues.filter((i) => i.severity === sev);
          if (rows.length === 0) return null;
          return (
            <div className="band mb-7" key={sev}>
              <div className="mb-2 flex items-baseline gap-3">
                <Badge color={SEVERITY[sev].color} appearance="tag" size="md">
                  {SEVERITY[sev].title} {rows.length}
                </Badge>
                <span className="text-sm text-muted-foreground">{SEVERITY[sev].blurb}</span>
              </div>
              <Card flat>
                {rows.map((r) => (
                  <IssueRow rule={r} totalPages={totalPages} structure={structure} key={r.id} />
                ))}
              </Card>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// The same findings pivoted by URL, built from each rule's listed example pages.
/**
 * The same findings pivoted by URL. Built in the browser from the finding rows'
 * page links (it is a second view of data already on the page), so it costs no
 * markup; without script the section stays hidden.
 */
function PagesLens() {
  return (
    <section id="pages" hidden>
      <SectionHead title="Pages" sub="The same findings, by URL. Worst first." />
      <Card flat>
        <div id="pages-list" />
      </Card>
      <p id="pages-note" className="mt-2 text-xs text-muted-foreground">
        Built from each rule&apos;s listed examples, so a very widespread rule may not name every
        page.
      </p>
    </section>
  );
}

/**
 * The rules that passed (`--include-passed`), after the findings: one closed
 * line that opens to a row per rule with where it held. Rendered only with the
 * flag, so the default page, and the published one that never has it, stays
 * byte-identical. Its classes are all used elsewhere on the page, so the
 * compiled stylesheet does not change either.
 */
function PassedRules({ rules }: { rules: PassedRule[] }) {
  return (
    <section id="passed">
      <details className="mt-12 border border-border bg-card p-4">
        <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
          <Sym id="check" className="size-4 shrink-0 text-primary" />
          {`${plural(rules.length, "rule")} passed with no issues`}
        </summary>
        <ul className="mt-3 grid text-sm">
          {rules.map((r) => (
            <li
              key={r.id}
              data-passed-rule={r.id}
              className="flex flex-wrap items-center gap-2 border-b border-border py-2 last:border-b-0"
            >
              <span className="font-semibold">{r.name}</span>
              <GTag group={getCategoryGroup(r.categoryCode)} category={r.categoryCode} />
              <span className="text-xs text-muted-foreground">{r.categoryName}</span>
              <code className="font-mono text-xs text-muted-foreground">{r.id}</code>
              <span className="text-xs text-muted-foreground sm:ml-auto">{passedRuleScope(r)}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/**
 * A technology logo from our own asset host; hidden by the page script if it
 * fails to load. Never in an offline (local) report: that would be a remote request.
 */
function TechIcon({ icon, offline }: { icon?: string | null; offline: boolean }) {
  const { techIconBaseUrl } = React.useContext(RenderAssets);
  if (offline) return null;
  const url = techIconUrl(icon, techIconBaseUrl);
  if (!url || sanitizeUrl(url) === "#") return null;
  return (
    <img
      src={sanitizeUrl(url)}
      alt=""
      width={14}
      height={14}
      loading="lazy"
      className="size-3.5 shrink-0 object-contain"
      data-hide-broken
    />
  );
}

/** GroupBadge colours as one stylesheet, keyed by data-g (instead of inline styles on every tag). */
const GROUP_TAG_CSS = Object.entries(GROUP_COLORS)
  .map(
    ([g, c]) => `.gtag[data-g="${g}"]{color:${c.text};background:${c.bg};border-color:${c.border}}`,
  )
  .join("");

/** Light GroupBadge for rows repeated many times. */
const GTag = ({ group, category }: { group: string; category?: string }) => (
  <span
    className="gtag"
    data-g={group}
    title={category ? getBadgeTitle(category) : getGroupTitle(group)}
  >
    {category ? getBadgeName(category) : getGroupName(group)}
  </span>
);

/**
 * Icons repeated on every row, drawn once as an SVG sprite and referenced with
 * <use>, instead of a full inline SVG per row.
 */
const SPRITE: Record<string, React.ComponentType> = {
  caret: PiCaretRight,
  out: PiArrowSquareOut,
  copy: PiCopy,
  check: PiCheck,
};
/**
 * One <symbol> from an icon component's markup. Throws (at module load) when
 * the markup is not the `<svg viewBox="..."><path .../></svg>` shape expected,
 * so an icon-library change breaks the build loudly instead of shipping
 * blank icons.
 */
export function spriteSymbol(id: string, svg: string): string {
  const open = /^<svg\b[^>]*>/.exec(svg);
  const viewBox = open ? /\bviewBox="([^"]+)"/.exec(open[0])?.[1] : undefined;
  const inner = open && svg.endsWith("</svg>") ? svg.slice(open[0].length, -"</svg>".length) : "";
  if (!viewBox) throw new Error(`report sprite: icon "${id}" has no viewBox`);
  if (!/<(path|circle|rect|polyline|polygon|line|g)\b/.test(inner)) {
    throw new Error(`report sprite: icon "${id}" has no drawable markup`);
  }
  return `<symbol id="i-${id}" viewBox="${viewBox}">${inner}</symbol>`;
}

const SPRITE_MARKUP = Object.entries(SPRITE)
  .map(([id, C]) => spriteSymbol(id, renderToStaticMarkup(<C />)))
  .join("");
const Sym = ({ id, className }: { id: keyof typeof SPRITE & string; className?: string }) => (
  <svg className={className} aria-hidden="true" fill="currentColor">
    <use href={`#i-${id}`} />
  </svg>
);

const PanelTitle = ({ children }: { children: React.ReactNode }) => (
  <h3 className="mb-3 text-base font-semibold tracking-tight">{children}</h3>
);

/** Site profile and tech stack, the search footprint, and the entity graph: each its own titled section. */
function SiteContext({ report, offline }: { report: AuditReport; offline: boolean }) {
  const tech = report.technologies;
  const meta = report.siteMetadata;
  const stats = report.domainStats;
  const statRows = stats ? domainStatRows(stats.metrics) : [];
  const bands = stats ? allPositionBands(stats.metrics.positions) : [];
  const maxBand = Math.max(1, ...bands.map((b) => b.count));
  const map = report.entityMap;
  const profileRows = meta ? siteProfileRows(meta) : [];
  const flags = meta ? siteProfileFlags(meta) : null;
  const cs = report.cacheStats;
  const hasTech = !!tech && tech.items.length > 0;
  const techSummary = tech ? techChangeSummary(tech) : null;
  return (
    <>
      {(profileRows.length > 0 || hasTech || cs) && (
        <section id="site">
          <SectionHead
            title="Site"
            sub="What we detected about the site. None of it affects the score."
          />
          <div className="grid gap-4 md:grid-cols-2">
            {profileRows.length > 0 && (
              <Panel>
                <PanelTitle>Profile</PanelTitle>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2 text-sm">
                  {profileRows.map((row) => (
                    <React.Fragment key={row.key}>
                      <dt className="text-muted-foreground">{row.label}</dt>
                      <dd className="break-words">
                        {row.url ? (
                          <a
                            href={sanitizeUrl(row.url)}
                            target="_blank"
                            rel="noreferrer"
                            className="lnk"
                          >
                            {row.value}
                          </a>
                        ) : (
                          row.value
                        )}
                      </dd>
                    </React.Fragment>
                  ))}
                </dl>
                {flags && (
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {flags.split(" · ").map((f) => (
                      <Badge color="orange" appearance="tag" key={f}>
                        {f}
                      </Badge>
                    ))}
                  </div>
                )}
              </Panel>
            )}
            {hasTech && (
              <Panel className={profileRows.length > 0 ? "" : "md:col-span-2"}>
                <PanelTitle>
                  Tech stack
                  {techSummary && (
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      {techSummary}
                    </span>
                  )}
                </PanelTitle>
                <div className="grid gap-4">
                  {groupTechnologies(tech!.items).map((grp) => (
                    <div key={grp.category}>
                      <p className="mb-1.5 text-xs text-muted-foreground">{grp.label}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {grp.items.map((t) => (
                          <Badge variant="outline" size="md" key={t.id} className="bg-card">
                            <TechIcon icon={t.icon} offline={offline} />
                            {t.name}
                            {t.version && (
                              <span className="text-muted-foreground">{t.version}</span>
                            )}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>
            )}
          </div>
          {cs && (
            <p className="mt-3 text-xs text-muted-foreground">
              Cache: {cacheHitRatePercent(cs)}% hit rate · {cs.hits.toLocaleString()}/
              {cs.total.toLocaleString()} reused · {formatBytes(cs.bytesSaved)} saved
              {cacheReasonsLabel(cs) ? ` (${cacheReasonsLabel(cs)})` : ""}
            </p>
          )}
        </section>
      )}

      {statRows.length > 0 && (
        <section id="footprint">
          <SectionHead title="Search footprint" sub="How the domain shows up in search" />
          <Panel>
            <Metrics items={statRows.map((r) => ({ value: String(r.value), label: r.label }))} />
            {bands.some((b) => b.count > 0) && (
              <div
                data-position-chart
                className="mt-5 grid max-w-md gap-1.5 text-xs text-muted-foreground"
              >
                {bands.map((b) => (
                  <div key={b.label} className="grid grid-cols-[4rem_1fr_3rem] items-center gap-3">
                    <span className="text-right">{b.label}</span>
                    <Progress value={b.count === 0 ? 0 : Math.max(2, (b.count / maxBand) * 100)} />
                    <span className="font-semibold text-foreground">
                      {b.count.toLocaleString("en-US")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </section>
      )}

      {map && (
        <section id="entities">
          <SectionHead
            title="Entities"
            sub={`The site's JSON-LD collapsed into one graph. ${entitySummaryLine(map)}.`}
          />
          <Panel>
            <style dangerouslySetInnerHTML={{ __html: ENTITY_VIEWER_STYLES }} />
            <div dangerouslySetInnerHTML={{ __html: entityViewerMarkup() }} />
            <script
              type="application/json"
              id="em-data"
              dangerouslySetInnerHTML={{ __html: entityViewerData(map) }}
            />
            <script dangerouslySetInnerHTML={{ __html: entityViewerScript() }} />
          </Panel>
        </section>
      )}
    </>
  );
}

/**
 * Page structure (#2307): where the links on the audited pages sit, from the page classifier and
 * the markup. Informational, never scored; absent for a report built from an older crawl.
 */
function PageStructure({ structure }: { structure: ReportStructure | undefined }) {
  if (!structure) return null;
  const rows = structureRows(structure);
  const lines = [
    structurePageTypesLine(structure),
    structureChromeLine(structure),
    structureTotalsLine(structure),
    structureDegradedLine(structure),
  ].filter((line): line is string => line !== null);
  return (
    <section id="structure">
      <SectionHead
        title="Page structure"
        sub="Where the links on your pages sit. None of it affects the score."
      />
      <Panel>
        {rows.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {rows.map((row) => (
              <Badge variant="outline" size="md" className="bg-card" key={row.section}>
                {row.section}
                <span className="text-muted-foreground">{structureRowDetail(row)}</span>
              </Badge>
            ))}
          </div>
        )}
        {lines.map((line) => (
          <p key={line} className="mt-3 text-sm">
            {line}
          </p>
        ))}
      </Panel>
    </section>
  );
}

/**
 * The white-label header brand (#810): the org's logo, or its name as plain
 * text when there is no logo, linked to the org's website when it set one.
 * Only an https website is linked; anything else renders the brand unlinked.
 */
function WhiteLabelBrand({ branding }: { branding: ReportBranding }) {
  const logo =
    branding.orgLogoUrl && sanitizeUrl(branding.orgLogoUrl) !== "#" ? (
      <img
        src={sanitizeUrl(branding.orgLogoUrl)}
        alt={branding.orgName ?? "Logo"}
        className="wl-logo h-6 w-auto"
      />
    ) : null;
  const brand =
    logo ??
    (branding.orgName ? (
      <span className="wl-wordmark font-mono font-semibold">{branding.orgName}</span>
    ) : null);
  if (!brand) return null;
  const website = whiteLabelWebsite(branding);
  if (!website) return brand;
  return (
    <a href={website} target="_blank" rel="noopener noreferrer" className="wl-brand-link">
      {brand}
    </a>
  );
}

/** The org's website when it is an https URL, else null (never linked). */
function whiteLabelWebsite(branding: ReportBranding): string | null {
  const website = branding.websiteUrl?.trim();
  if (!website || !/^https:\/\//i.test(website) || sanitizeUrl(website) === "#") return null;
  return website;
}

/**
 * The white-label footer (#810): the org's footer text (plain text, escaped)
 * and a link to its website, where the squirrelscan credit was. Nothing when
 * neither is set.
 */
function WhiteLabelFooter({ branding }: { branding: ReportBranding }) {
  const website = whiteLabelWebsite(branding);
  if (!branding.footerText && !website) return null;
  let host = website;
  try {
    if (website) host = new URL(website).host;
  } catch {
    // An https URL the URL parser refuses still shows, as written.
  }
  return (
    <span className="wl-footer">
      {branding.footerText}
      {branding.footerText && website && " · "}
      {website && (
        <a href={website} target="_blank" rel="noopener noreferrer" className="lnk wl-footer-link">
          {host}
        </a>
      )}
    </span>
  );
}

function ReportPage({
  report,
  reportId,
  reportUrl,
  branding,
  faviconUrl,
  offline,
  includePassed,
}: {
  report: AuditReport;
  reportId?: string;
  reportUrl?: string;
  branding?: ReportBranding;
  faviconUrl?: string;
  offline: boolean;
  includePassed: boolean;
}) {
  const host = hostOf(report);
  const favicon = !offline && faviconUrl ? sanitizeUrl(faviconUrl) : "#";
  // Counts off stored report JSON, as whole numbers (never NaN in the copy).
  const totalPages = count(report.totalPages);
  const passed = count(report.passed);
  const warnings = count(report.warnings);
  const failed = count(report.failed);
  const found = discoveredPages(report);
  // A crawl cut short knows only part of the site: its discovered count is a
  // floor, so it reads "N+" wherever it is printed.
  const discoveredFloor =
    (!!report.scanScope?.capped || report.scanScope?.stopReason === "time") &&
    found.total > totalPages;
  const discoveredCount = `${found.total.toLocaleString()}${discoveredFloor ? "+" : ""}`;
  const localRun =
    !branding?.whiteLabel &&
    (report.cloudPlan ?? "anonymous") === "anonymous" &&
    report.scanScope?.origin !== "cloud";
  const title = report.homepage?.title?.trim() || host;
  const description = report.homepage?.description?.trim();
  const score = report.healthScore?.overall;
  const groups = report.healthScore?.groups ?? [];
  const failedRun = report.status === "failed" || report.status === "blocked";
  const issues = flattenIssuesBySeverity(
    groupIssuesByCategory(report.ruleResults, report.checkTallies),
  );
  const es = editorSummaryView(report.editorSummary, report);
  const priorities = es?.priorities ?? [];
  const passedRules = reportPassedRules(report, includePassed);
  const known: Known = new Map(issues.map((i) => [i.id, i.group]));
  const techName = new Map((report.technologies?.items ?? []).map((t) => [t.id, t.name]));
  const techIcon = new Map(
    (report.technologies?.items ?? []).map((t) => [t.id, t.icon ?? undefined]),
  );
  const gap = failedRun
    ? null
    : coverageGap({
        scanned: totalPages,
        discovered: found.total,
        capped: !!report.scanScope?.capped,
        timeStopped: report.scanScope?.stopReason === "time",
      });
  // A page limit reduced below the one requested (#1909): a bigger --max-pages
  // is reduced the same way, so neither the notice nor a fix prompt suggests one.
  const clamped = report.scanScope ? clampedPageLimit(report.scanScope) : null;
  // A smart audit re-checked only some known pages and carried the rest forward:
  // those pages are in the report, with earlier results, not missing from it.
  // (Same test as fullScanHint: a rate-limited run's gap is pages never fetched.)
  // Only while the known pages explain the whole gap: URLs still queued
  // (`scanScope.unfetched`) were never audited, so nothing of theirs is carried.
  const carriedRest =
    !!gap &&
    gap.moreKnown > 0 &&
    !!report.coverage &&
    report.coverage.auditedPages < report.coverage.knownPages &&
    found.total <= count(report.coverage.knownPages) &&
    (report.rateLimited?.unfetched ?? 0) <= 0;
  const reportBase = reportUrl ?? (reportId ? defaultReportUrl(reportId) : null);
  const ctx: PromptContext = {
    url: report.baseUrl,
    reportMd: reportBase ? `${reportBase}.md` : null,
    stack: [...new Set(techName.values())],
    issues: new Map(issues.map((i) => [i.id, i])),
    gap,
    canRerun: !clamped,
  };
  const strategic = strategicIssues(report);
  const top = failedRun ? [] : mergeIssues(priorities, strategic);
  const notice = getAuditFailureNotice(
    report.status,
    report.baseUrl,
    report.rateLimited,
    reportFailureReasonCode(report),
  );
  const issueGroups = new Set(issues.map((i) => i.group));
  const signedIn = report.cloudPlan === "free" || report.cloudPlan === "paid";
  const lockedAi =
    signedIn && report.coverageMode === "quick" && !groups.some((g) => g.group === "ai");
  const locked = branding?.whiteLabel ? null : lockedRulesMessage(report);
  const level = auditLevelLine(report);
  const cov =
    report.coverage &&
    (report.coverage.carriedFindings > 0 || (report.coverage.unrenderedFindings ?? 0) > 0)
      ? coverageLine(report)
      : null;
  // The coverage notice replaces the generic partial-scan hint.
  const hint = gap ? null : fullScanHint(report);
  const seed = seedRedirectLine(report);
  const priv = privateTargetLine(report);
  // repo#2729: checks this audit did not run, so a skipped check never reads as a clean one.
  const notChecked = notCheckedLines(report);
  // repo#2661: a capped published report lists samples; said once, in the footer.
  const capped = publishedReportNote(report);
  // The header already says how many pages were scanned and at what level, and
  // the coverage notice says when that is partial, so no scope line here.
  const notes = [cov, priv, ...notChecked, seed, hint].filter((t): t is string => !!t);
  const reportKey = coverageNoticeKey(report, reportId);
  const byReach = (a: FlatIssue, b: FlatIssue) =>
    reach(b, totalPages).count - reach(a, totalPages).count;
  const fixFirst = [
    ...issues.filter((i) => i.severity === "error").sort(byReach),
    ...issues.filter((i) => i.severity === "warning").sort(byReach),
  ].slice(0, 4);
  const shotSrc = report.screenshotUrl ? sanitizeUrl(report.screenshotUrl) : "#";
  const shot = shotSrc === "#" ? null : shotSrc;
  const base = reportBase;
  const groupsPart = groups.length
    ? ` · ${groups.map((g) => `${getGroupName(g.group)} ${g.score}`).join(" · ")}`
    : "";
  const metaDescription =
    score != null
      ? `Health score ${score} (${getScoreGrade(score)})${groupsPart} · ${plural(totalPages, "page")} audited`
      : `Website audit report · ${plural(totalPages, "page")} · ${failed} failed, ${warnings} warnings`;

  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{`Audit Report - ${host}`}</title>
        <meta name="description" content={metaDescription} />
        {reportUrl && <link rel="canonical" href={reportUrl} />}
        {base && (
          <>
            <meta property="og:type" content="website" />
            <meta property="og:title" content={`Audit Report - ${host}`} />
            <meta property="og:description" content={metaDescription} />
            <meta property="og:url" content={base!} />
            <meta property="og:image" content={`${base}/og.png`} />
            <meta property="og:image:width" content="1200" />
            <meta property="og:image:height" content="630" />
            {/* White-label (#810): the org name as site_name, or none. */}
            {branding?.whiteLabel ? (
              branding.orgName && <meta property="og:site_name" content={branding.orgName} />
            ) : (
              <meta property="og:site_name" content="squirrelscan" />
            )}
            <meta name="twitter:card" content="summary_large_image" />
          </>
        )}
        <style dangerouslySetInnerHTML={{ __html: REPORT_CSS }} />
        <style dangerouslySetInnerHTML={{ __html: GROUP_TAG_CSS }} />
      </head>
      <body>
        <svg
          width="0"
          height="0"
          style={{ position: "absolute" }}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: SPRITE_MARKUP }}
        />
        <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
          <div className="mx-auto flex h-13 max-w-6xl items-center gap-5 px-4">
            {/* White-label (#810): the org's logo or name, linked to its website
                when it set one, and no squirrelscan link. */}
            {branding?.whiteLabel ? (
              <WhiteLabelBrand branding={branding} />
            ) : (
              // oxlint-disable-next-line github/a11y-aria-label-is-well-formatted -- brand name is always lowercase
              <a
                href="https://squirrelscan.com"
                target="_blank"
                rel="noreferrer"
                aria-label="squirrelscan"
              >
                <SquirrelLogo height="h-6" />
              </a>
            )}
            {!failedRun && (
              <nav
                className="hidden items-center gap-1 text-sm md:flex"
                aria-label="Report sections"
              >
                {[
                  ["#top", "Overview"],
                  ...(es ? [["#summary", "Summary"]] : []),
                  ...(top.length > 0 ? [["#issues", "Issues"]] : []),
                  ...(issues.length > 0
                    ? [
                        ["#findings", "Findings"],
                        ["#pages", "Pages"],
                      ]
                    : []),
                  ...(passedRules.length > 0 ? [["#passed", "Passed"]] : []),
                  ...(report.technologies?.items.length || report.siteMetadata
                    ? [["#site", "Site"]]
                    : []),
                  ...(report.domainStats ? [["#footprint", "Search"]] : []),
                  ...(report.entityMap ? [["#entities", "Entities"]] : []),
                ].map(([href, label]) => (
                  <a
                    key={href}
                    href={href}
                    className="px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {label}
                  </a>
                ))}
              </nav>
            )}
            <div className="flex-1" />
            {base && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="hidden sm:inline">For your agent</span>
                <a href={`${base}.md`} className={agentLink}>
                  .md
                </a>
                <a href={`${base}.json`} className={agentLink}>
                  .json
                </a>
              </div>
            )}
          </div>
        </header>

        <DecorativeHeader compact>
          <div className="mx-auto max-w-6xl px-4 py-10" id="top">
            <div className="flex flex-wrap items-center justify-between gap-6">
              <div className="min-w-0 flex-1 basis-96">
                <div className="flex items-center gap-3">
                  {/* A first-party favicon (repo#3080) online only; otherwise the initial tile. */}
                  {favicon !== "#" ? (
                    <img
                      src={favicon}
                      alt=""
                      width={32}
                      height={32}
                      className="site-favicon size-8 shrink-0 border border-border bg-white p-1"
                      data-favicon
                    />
                  ) : (
                    <span
                      className="site-favicon flex size-8 shrink-0 items-center justify-center border border-border bg-white text-sm font-semibold text-muted-foreground"
                      aria-hidden
                    >
                      {host.charAt(0).toUpperCase()}
                    </span>
                  )}
                  <h1 className="text-2xl font-bold leading-tight tracking-tight md:text-3xl">
                    {title}
                  </h1>
                </div>
                <a
                  href={sanitizeUrl(report.baseUrl)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 break-all font-mono text-sm text-primary hover:underline"
                >
                  {report.baseUrl} <Sym id="out" className="size-3.5 shrink-0" />
                </a>
                {description && (
                  <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
                    {description}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-1.5">
                  <Badge color="neutral" size="md">
                    <span
                      title={`${found.sitemap.toLocaleString()} in sitemaps, ${found.crawlOnly.toLocaleString()} more found by crawling${found.unfetched > 0 ? `; this crawl fetched ${count(report.scanScope?.pagesCrawled).toLocaleString()} and left ${found.unfetched.toLocaleString()} queued` : ""}`}
                    >
                      Scanned {totalPages.toLocaleString()} of {discoveredCount} discovered{" "}
                      {found.total === 1 && !discoveredFloor ? "page" : "pages"}
                    </span>
                  </Badge>
                  <Badge color="neutral" size="md">
                    <time dateTime={isoTime(report.timestamp)} data-local-time>
                      {formatWhen(report.timestamp)}
                    </time>
                  </Badge>
                  {level && (
                    <Badge color="neutral" size="md">
                      {level.replace(/\.$/, "")}
                    </Badge>
                  )}
                  {report.generatorVersion && (
                    <Badge color="neutral" size="md">
                      v{report.generatorVersion}
                    </Badge>
                  )}
                </div>
              </div>
              {shot && (
                <a
                  href={shot}
                  target="_blank"
                  rel="noreferrer"
                  className="screenshot-section hidden shrink-0 border border-border bg-card p-1.5 transition-colors hover:border-primary/40 md:block"
                  aria-label="Open full screenshot"
                  data-hide-scope
                >
                  {/* Captured after the audit, so it may not exist yet: hidden with its frame on error. */}
                  <img
                    src={shot}
                    alt={`Screenshot of ${report.baseUrl}`}
                    loading="lazy"
                    className="block aspect-[16/10] w-56 object-cover object-top"
                    data-hide-broken
                  />
                </a>
              )}
              {failedRun ? (
                <div className="flex size-24 items-center justify-center border-2 border-destructive text-sm font-bold uppercase text-destructive">
                  {report.status === "blocked" ? "Blocked" : "Failed"}
                </div>
              ) : (
                score != null && (
                  <div className="shrink-0 border border-border bg-white p-3">
                    <ScoreCircle score={score} size={148} />
                  </div>
                )
              )}
            </div>
          </div>
        </DecorativeHeader>

        <main className="mx-auto max-w-6xl px-4 pb-16 pt-6">
          {gap && (
            <CoverageNotice
              gap={gap}
              carried={carriedRest}
              clamped={clamped}
              noticeKey={reportKey}
            />
          )}

          {notes.length > 0 && (
            <div className="mb-6 grid gap-2">
              {notes.map((t, i) => (
                <div
                  key={i}
                  role="note"
                  data-notice-key={noteKey(reportKey, t)}
                  className="flex items-start gap-2 border border-border bg-card px-3 py-2 text-sm text-muted-foreground"
                >
                  <PiWarning className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">{t}</span>
                  <DismissButton />
                </div>
              ))}
            </div>
          )}
          {(gap || notes.length > 0) && (
            // Right after the notices, so a dismissed one never flashes.
            <script dangerouslySetInnerHTML={{ __html: NOTICE_SCRIPT }} />
          )}

          {notice && (
            <Card id="failure-notice" tone="destructive" flat className="mb-6 space-y-3 p-4 md:p-6">
              <h2 className="text-lg font-semibold text-destructive">{notice.heading}</h2>
              <p className="text-sm text-muted-foreground">{notice.body[0]}</p>
              {notice.tone === "blocked" ? (
                <>
                  <p className="text-sm text-muted-foreground">{notice.stepsIntro}</p>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {notice.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                    <li>
                      Run the audit from a trusted network with{" "}
                      <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                        {notice.cliCommand}
                      </code>
                      .
                    </li>
                  </ul>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {(notice.body[1] ?? "").replace(/\.\s*$/, "")}, or run it locally with{" "}
                  <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                    {notice.cliCommand}
                  </code>
                  .
                </p>
              )}
              {report.statusReason && (
                <p className="text-xs text-muted-foreground">Reason: {report.statusReason}</p>
              )}
            </Card>
          )}

          {groups.length > 0 && (
            <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {groups.map((g) => {
                const body = (
                  <>
                    <ScoreCircle score={g.score} size={88} />
                    <GroupBadge group={g.group} />
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {g.failed === 0 && g.warnings === 0 ? (
                        "No issues"
                      ) : (
                        <>
                          {g.failed > 0 && (
                            <span className="text-destructive">{plural(g.failed, "error")}</span>
                          )}
                          {g.failed > 0 && g.warnings > 0 && " · "}
                          {g.warnings > 0 && (
                            <span className="text-amber-600">{plural(g.warnings, "warning")}</span>
                          )}
                        </>
                      )}
                    </p>
                  </>
                );
                return issueGroups.has(g.group) ? (
                  <a
                    key={g.group}
                    href={`#g-${g.group}`}
                    className={`${groupCard} transition-colors hover:border-[var(--gc)] hover:bg-[var(--gc-bg)]`}
                    style={gcVar(g.group)}
                    data-group-score={g.group}
                  >
                    {body}
                  </a>
                ) : (
                  <div
                    key={g.group}
                    className={groupCard}
                    style={gcVar(g.group)}
                    data-group-score={g.group}
                  >
                    {body}
                  </div>
                );
              })}
              {lockedAi && (
                <div
                  data-group-locked="ai"
                  className="flex flex-col items-center gap-2 border border-dashed border-border border-t-[3px] border-t-[var(--gc)] p-4 text-center text-muted-foreground"
                  style={gcVar("ai")}
                >
                  <div
                    className="flex size-[88px] items-center justify-center rounded-full border-[7px]"
                    style={{
                      borderColor: getGroupColor("ai").border,
                      color: getGroupColor("ai").text,
                    }}
                  >
                    <PiLockSimple className="size-6" />
                  </div>
                  <GroupBadge group="ai" />
                  <p className="mt-1.5 text-xs">
                    Not scored at the quick level. Re-run at surface or full.
                  </p>
                </div>
              )}
            </div>
          )}

          {!failedRun && (
            <Metrics
              items={[
                { value: totalPages.toLocaleString(), label: "Scanned" },
                { value: discoveredCount, label: "Discovered" },
                { value: passed.toLocaleString(), label: "Passed", color: "#16a34a" },
                { value: warnings.toLocaleString(), label: "Warnings", color: "#ca8a04" },
                { value: failed.toLocaleString(), label: "Failed", color: "#dc2626" },
              ]}
            />
          )}

          {!failedRun && es && (
            <section id="summary">
              <SectionHead
                title="Summary"
                sub="Auto-generated from this audit's findings and the detected stack. Informational, not scored."
              />
              <Panel>
                <div className="grid gap-x-8 gap-y-3 text-sm leading-relaxed text-muted-foreground md:grid-cols-2">
                  {es.paragraphs.map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
                {top.length === 0 && es.bigTicket.length > 0 && (
                  <ul
                    data-big-ticket
                    className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground"
                  >
                    {es.bigTicket.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}
                {es.verdict && (
                  <p className="mt-4 border-t border-border pt-3 text-sm font-semibold">
                    {es.verdict}
                  </p>
                )}
              </Panel>
            </section>
          )}

          {top.length > 0 ? (
            <TopIssues
              items={top}
              known={known}
              ctx={ctx}
              techName={techName}
              techIcon={techIcon}
              offline={offline}
            />
          ) : (
            !failedRun &&
            fixFirst.length > 0 && (
              <section id="issues" data-issues="widespread">
                <SectionHead
                  title="Issues"
                  sub="The most widespread errors and warnings, worst first"
                />
                <Panel>
                  <ol className="grid gap-4">
                    {fixFirst.map((r, i) => (
                      <li key={r.id} className="grid grid-cols-[1.5rem_1fr] gap-3">
                        <span className="flex size-6 items-center justify-center border border-border bg-muted text-xs font-semibold text-muted-foreground">
                          {i + 1}
                        </span>
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <a
                              href={`#rule-${r.id}`}
                              className="text-sm font-semibold text-primary hover:underline"
                            >
                              {r.name}
                            </a>
                            <Badge color={SEVERITY[r.severity].color} appearance="tag">
                              {severityLabel(r.severity)}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {reach(r, totalPages).label}
                            </span>
                          </div>
                          {r.solution && (
                            <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">
                              {r.solution}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </Panel>
              </section>
            )
          )}

          {localRun && <CloudUpsell report={report} />}

          {issues.length > 0 ? (
            <>
              <Issues
                issues={issues}
                totalPages={totalPages}
                ctx={ctx}
                structure={report.structure}
              />
              <PagesLens />
            </>
          ) : failedRun ? null : (
            <Panel className="mt-8 text-center text-primary">✓ No issues found</Panel>
          )}

          {passedRules.length > 0 && <PassedRules rules={passedRules} />}

          <SiteContext report={report} offline={offline} />

          <PageStructure structure={report.structure} />

          {locked && !localRun && (
            <details id="locked-rules" className="mt-12 border border-dashed border-border p-4">
              <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                <PiLockSimple className="size-4" /> {locked.heading}
              </summary>
              <p className="my-3 text-sm text-muted-foreground">
                {locked.action}
                {locked.cta && (
                  <>
                    {" "}
                    <a
                      href={sanitizeUrl(locked.cta.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="lnk"
                    >
                      {locked.cta.label}
                    </a>
                    .
                  </>
                )}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {locked.rules.map((r) => (
                  <Badge color="neutral" size="md" key={r.id}>
                    {r.name}
                  </Badge>
                ))}
              </div>
            </details>
          )}

          <footer className="mt-14 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5 text-sm text-muted-foreground">
            {capped && (
              <p id="published-report-note" className="basis-full text-xs leading-5">
                {capped}
              </p>
            )}
            <span>
              {passed.toLocaleString()} passed · {warnings.toLocaleString()} warnings ·{" "}
              {failed.toLocaleString()} failed across {plural(totalPages, "page")}
            </span>
            {branding?.whiteLabel ? (
              <WhiteLabelFooter branding={branding} />
            ) : (
              <span>
                Generated by{" "}
                <a href="https://squirrelscan.com" target="_blank" rel="noreferrer" className="lnk">
                  squirrelscan.com
                </a>
              </span>
            )}
          </footer>
        </main>
        <script
          dangerouslySetInnerHTML={{
            __html: COPY_SCRIPT + FINDING_COPY_SCRIPT + PAGES_SCRIPT + LOCAL_TIME_SCRIPT,
          }}
        />
      </body>
    </html>
  );
}

/**
 * The body of every executable inline `<script>` the HTML report can render,
 * exactly as rendered (squirrelscan/repo#3182). A host serving these reports
 * hashes them into a `script-src` CSP, so a script that is not one of ours
 * never runs, even if an escaping bug let one into the page. The
 * `type="application/json"` data blocks are not executable and not listed.
 */
export function reportInlineScripts(): readonly string[] {
  return [
    COPY_SCRIPT + FINDING_COPY_SCRIPT + PAGES_SCRIPT + LOCAL_TIME_SCRIPT,
    NOTICE_SCRIPT,
    entityViewerScript(),
  ];
}

/**
 * Render an audit report as one self-contained HTML page: the CLI's HTML
 * output and the published cloud report. Pure function, no I/O; the CSS is
 * compiled ahead of time (scripts/build-css.ts).
 * Changing this output? Bump REPORT_HTML_VERSION (constants.ts) so cached HTML invalidates.
 */
export function renderHtml(report: AuditReport, options?: HtmlRenderOptions): string {
  return (
    "<!DOCTYPE html>" +
    renderToStaticMarkup(
      <RenderAssets.Provider value={{ techIconBaseUrl: options?.techIconBaseUrl }}>
        <ReportPage
          report={report}
          reportId={options?.reportId}
          reportUrl={options?.reportUrl}
          branding={options?.branding}
          faviconUrl={options?.faviconUrl}
          offline={options?.offline ?? true}
          includePassed={options?.includePassed ?? false}
        />
      </RenderAssets.Provider>,
    )
  );
}
