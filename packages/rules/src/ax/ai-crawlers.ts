// ax/ai-crawlers - report which AI agent crawlers robots.txt allows vs blocks,
// classified into the three purposes those crawlers actually serve.

import type { RobotsTxtData } from "@squirrelscan/core-contracts";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/**
 * The three distinct purposes an AI crawler serves — each its own robots.txt
 * user-agent token, so blocking one never blocks another (blocking ClaudeBot,
 * training, does NOT block Claude-User, user-action). Blocking implication
 * differs per class: training = a policy choice (info), ai-search/user-action =
 * lost citations / broken live fetches (warning).
 */
export type CrawlerClass = "training" | "ai-search" | "user-action" | "archive";

/** A well-known AI/agent crawler user-agent token. */
interface AiCrawler {
  /** robots.txt user-agent token (matched case-insensitively). */
  token: string;
  /** Operator / product behind the bot. */
  vendor: string;
  /** What the bot is for (training, search index, live agent fetch). */
  purpose: string;
  /** Which of the three crawler purposes this UA serves. */
  crawlerClass: CrawlerClass;
}

// Curated list of AI-agent crawler UAs (publicly documented), each tagged with
// its crawler class. Ambiguous data-harvesters default to "training" — the
// class whose blocking never penalizes — so we only warn on a block when the UA
// is unambiguously an answer-engine (ai-search) or a live user fetch
// (user-action).
export const AI_CRAWLERS: AiCrawler[] = [
  { token: "GPTBot", vendor: "OpenAI", purpose: "model training", crawlerClass: "training" },
  { token: "OAI-SearchBot", vendor: "OpenAI", purpose: "ChatGPT search index", crawlerClass: "ai-search" },
  { token: "ChatGPT-User", vendor: "OpenAI", purpose: "user-triggered fetch", crawlerClass: "user-action" },
  { token: "ClaudeBot", vendor: "Anthropic", purpose: "model training", crawlerClass: "training" },
  { token: "anthropic-ai", vendor: "Anthropic", purpose: "model training (legacy)", crawlerClass: "training" },
  { token: "Claude-User", vendor: "Anthropic", purpose: "user-triggered fetch", crawlerClass: "user-action" },
  { token: "Claude-SearchBot", vendor: "Anthropic", purpose: "Claude search index", crawlerClass: "ai-search" },
  { token: "Google-Extended", vendor: "Google", purpose: "Gemini/Vertex training", crawlerClass: "training" },
  { token: "CCBot", vendor: "Common Crawl", purpose: "open crawl corpus", crawlerClass: "archive" },
  { token: "ia_archiver", vendor: "Internet Archive", purpose: "Wayback Machine archiving", crawlerClass: "archive" },
  { token: "archive.org_bot", vendor: "Internet Archive", purpose: "Wayback Machine archiving", crawlerClass: "archive" },
  { token: "PerplexityBot", vendor: "Perplexity", purpose: "search index", crawlerClass: "ai-search" },
  { token: "Perplexity-User", vendor: "Perplexity", purpose: "user-triggered fetch", crawlerClass: "user-action" },
  { token: "Applebot-Extended", vendor: "Apple", purpose: "Apple Intelligence training", crawlerClass: "training" },
  { token: "Bytespider", vendor: "ByteDance", purpose: "model training", crawlerClass: "training" },
  { token: "Amazonbot", vendor: "Amazon", purpose: "Alexa/AI training", crawlerClass: "training" },
  { token: "Meta-ExternalAgent", vendor: "Meta", purpose: "model training", crawlerClass: "training" },
  { token: "Meta-ExternalFetcher", vendor: "Meta", purpose: "user-triggered fetch", crawlerClass: "user-action" },
  { token: "cohere-ai", vendor: "Cohere", purpose: "model training", crawlerClass: "training" },
  { token: "DuckAssistBot", vendor: "DuckDuckGo", purpose: "DuckAssist answers", crawlerClass: "ai-search" },
  { token: "MistralAI-User", vendor: "Mistral", purpose: "user-triggered fetch", crawlerClass: "user-action" },
  { token: "AI2Bot", vendor: "Allen AI", purpose: "model training", crawlerClass: "training" },
  { token: "Diffbot", vendor: "Diffbot", purpose: "knowledge graph", crawlerClass: "training" },
  { token: "YouBot", vendor: "You.com", purpose: "search index", crawlerClass: "ai-search" },
];

export interface AiCrawlerVerdict extends AiCrawler {
  /** robots.txt names this UA in its own group (vs only covered by `*`). */
  explicitlyListed: boolean;
  /** Fully blocked from the site root (`Disallow: /` with no `Allow: /`). */
  blocked: boolean;
}

/** Resolve the robots.txt groups that apply to a UA (specific wins over `*`). */
function groupsForToken(robotsTxt: RobotsTxtData, token: string) {
  const lower = token.toLowerCase();
  const exact = robotsTxt.rules.filter((g) => g.userAgent.toLowerCase() === lower);
  if (exact.length > 0) return { groups: exact, explicit: true };
  // "*" is always literal, no case-folding needed.
  return { groups: robotsTxt.rules.filter((g) => g.userAgent === "*"), explicit: false };
}

/** A search-engine crawler token. Not an AI crawler: reported beside them for context. */
interface SearchEngineBot {
  /** robots.txt user-agent token (matched case-insensitively). */
  token: string;
  vendor: string;
}

/** The search-engine bot class: the crawlers that index a site for web search. */
export const SEARCH_ENGINE_BOTS: SearchEngineBot[] = [
  { token: "Googlebot", vendor: "Google" },
  { token: "Bingbot", vendor: "Microsoft" },
  { token: "Applebot", vendor: "Apple" },
];

/**
 * How robots.txt treats a bot for the audited URL, against the site root:
 * - `allowed`: the audited path is allowed and so is the root.
 * - `root-blocked`: the root is disallowed and so is the audited path.
 * - `path-blocked`: the root is allowed, but a rule disallows the audited path.
 * - `allow-override`: the root is disallowed, but an `Allow` rule re-permits the audited path.
 */
export type SearchEngineVerdictKind = "allowed" | "root-blocked" | "path-blocked" | "allow-override";

export interface SearchEngineVerdict extends SearchEngineBot {
  crawlerClass: "search-engine";
  /** robots.txt names this token in its own group (vs only covered by `*`). */
  explicitlyListed: boolean;
  rootBlocked: boolean;
  pathBlocked: boolean;
  verdict: SearchEngineVerdictKind;
}

/** Per-bot verdict for `auditedUrl`, using the same longest-match evaluation as the crawl rules. */
export function evaluateSearchEngineBots(
  robotsTxt: RobotsTxtData,
  auditedUrl: string,
): SearchEngineVerdict[] {
  let rootUrl = auditedUrl;
  try {
    rootUrl = new URL("/", auditedUrl).toString();
  } catch {
    // An unparseable URL is never disallowed (isRobotsTxtDisallowed returns false for it too).
  }
  return SEARCH_ENGINE_BOTS.map((bot) => {
    // Per Apple, Applebot with no group of its own follows the Googlebot group before `*`.
    const evalToken =
      bot.token === "Applebot" && !groupsForToken(robotsTxt, "Applebot").explicit
        ? groupsForToken(robotsTxt, "Googlebot").explicit
          ? "Googlebot"
          : bot.token
        : bot.token;
    const rootBlocked = isRobotsTxtDisallowed(rootUrl, robotsTxt, evalToken);
    const pathBlocked = isRobotsTxtDisallowed(auditedUrl, robotsTxt, evalToken);
    const verdict: SearchEngineVerdictKind = pathBlocked
      ? rootBlocked
        ? "root-blocked"
        : "path-blocked"
      : rootBlocked
        ? "allow-override"
        : "allowed";
    return {
      ...bot,
      crawlerClass: "search-engine",
      explicitlyListed: groupsForToken(robotsTxt, bot.token).explicit,
      rootBlocked,
      pathBlocked,
      verdict,
    };
  });
}

const SEARCH_VERDICT_LABEL: Record<SearchEngineVerdictKind, string> = {
  allowed: "allowed",
  "root-blocked": "blocked from the site root",
  "path-blocked": "blocked for this path only",
  "allow-override": "root blocked, this path allowed by an Allow rule",
};

/** Classify every known AI crawler against the parsed robots.txt. */
export function evaluateAiCrawlers(robotsTxt: RobotsTxtData): AiCrawlerVerdict[] {
  return AI_CRAWLERS.map((bot) => {
    const { groups, explicit } = groupsForToken(robotsTxt, bot.token);
    const rules = groups.flatMap((g) => g.rules);
    // Root access only: a full block is `Disallow: /` not re-permitted by `Allow: /`.
    const disallowRoot = rules.some((r) => r.type === "disallow" && r.path === "/");
    const allowRoot = rules.some((r) => r.type === "allow" && r.path === "/");
    return { ...bot, explicitlyListed: explicit, blocked: disallowRoot && !allowRoot };
  });
}

const CLASS_LABEL: Record<CrawlerClass, string> = {
  training: "training crawler",
  "ai-search": "AI-search indexer",
  "user-action": "user-action fetcher",
  archive: "archive crawler",
};

/** The one row for the crawlers that only the wildcard group blocks (#1780), and its stable item id. */
const WILDCARD_CHECK = "ai-crawlers-wildcard-blocked";
const WILDCARD_LOCATOR = "User-agent: *";

export const aiCrawlersRule: Rule = {
  meta: {
    id: "ax/ai-crawlers",
    name: "AI Crawler Access",
    description:
      "Classifies AI-agent crawlers (training, AI-search, user-action, archive) and reports which robots.txt allows or blocks",
    solution:
      "AI assistants and answer engines read your site through named crawlers, but 'AI crawlers' is really several policies. Blocking TRAINING crawlers (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, Meta-ExternalAgent, Amazonbot, Bytespider) only affects one vendor's future model training — a legitimate choice that never penalizes your score. ARCHIVE crawlers (CCBot, ia_archiver) are different: they feed the Common Crawl corpus and the Wayback Machine, the shared sources AI training sets are built from, so blocking them opts you out of every downstream model and archive at once — this rule warns on it. Blocking AI-SEARCH indexers (OAI-SearchBot, Claude-SearchBot, PerplexityBot) drops you from AI-generated search citations; blocking USER-ACTION fetchers (ChatGPT-User, Claude-User, Perplexity-User) breaks live requests a real person made inside an assistant — both are usually accidental, so this rule warns on them. Note these are separate user-agents: blocking ClaudeBot (training) does NOT block Claude-User (user-action). To opt out of training while staying answerable, block the training bots but keep the AI-search and user-action ones allowed.",
    category: "ax",
    scope: "site",
    // info by default (training-only blocks / all-allowed stay info); a blocked
    // AI-search or user-action bot emits a warn check, and the report's
    // effective-severity derivation only escalates a rule badge to "warning"
    // from a "warning" (or higher) meta — an "info" meta stays info even with
    // warn checks. So the meta sits at "warning" to let that escalation happen.
    severity: "warning",
    weight: 1,
    // One `User-agent: *` / `Disallow: /` used to give a warning row per crawler (#1780). The crawlers only the
    // wildcard blocks are now one row under one locator, so a finding stored for any of them continues in that
    // row: the merge and `report --diff` judge it by the successor `check@locator` and nothing is reported fixed.
    supersededChecks: {
      // `|crawlers`: only a crawler the wildcard row LISTS continues in it. One allowed by name while the wildcard
      // still blocks the others is not in the list and is judged on its own: fixed.
      "ai-answer-access": [`${WILDCARD_CHECK}@${WILDCARD_LOCATOR}|crawlers`],
      "archive-crawler-access": [`${WILDCARD_CHECK}@${WILDCARD_LOCATOR}|crawlers`],
    },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const robotsTxt = ctx.site?.robotsTxt;

    // No robots.txt (or unavailable) → nothing blocks AI crawlers.
    if (!robotsTxt || !robotsTxt.exists) {
      checks.push({
        name: "ai-crawler-access",
        status: "info",
        message: "No robots.txt — all AI crawlers are allowed by default",
      });
      return { checks };
    }

    const verdicts = evaluateAiCrawlers(robotsTxt);
    const blocked = verdicts.filter((v) => v.blocked);
    const allowed = verdicts.filter((v) => !v.blocked);

    // Always-on informational summary (never penalizes).
    checks.push({
      name: "ai-crawler-access",
      status: "info",
      message: `${allowed.length}/${verdicts.length} known AI crawlers allowed${
        blocked.length > 0
          ? `; ${blocked.length} blocked (${blocked.map((b) => b.token).join(", ")})`
          : ""
      }`,
      value: `${allowed.length}/${verdicts.length} allowed`,
      items: blocked.map((b) => ({
        id: b.token,
        label: `${b.token} (${b.vendor}, ${CLASS_LABEL[b.crawlerClass]}) — blocked`,
      })),
      details: {
        allowed: allowed.map((b) => b.token),
        blocked: blocked.map((b) => b.token),
        blockedByClass: {
          training: blocked.filter((b) => b.crawlerClass === "training").map((b) => b.token),
          "ai-search": blocked.filter((b) => b.crawlerClass === "ai-search").map((b) => b.token),
          "user-action": blocked.filter((b) => b.crawlerClass === "user-action").map((b) => b.token),
          archive: blocked.filter((b) => b.crawlerClass === "archive").map((b) => b.token),
        },
        explicitlyListed: verdicts.filter((v) => v.explicitlyListed).map((v) => v.token),
      },
    });

    // The crawlers only the wildcard group blocks (#1780): one decision of the owner, one row. A crawler the
    // file blocks by its own group is a separate decision and keeps its own row below.
    const wildcardBlocked = blocked.filter((b) => !b.explicitlyListed);
    const namedBlocked = blocked.filter((b) => b.explicitlyListed);
    if (wildcardBlocked.length > 0) {
      const wildcardClasses = (cls: CrawlerClass) =>
        wildcardBlocked.filter((b) => b.crawlerClass === cls).map((b) => b.token);
      // Warn when the wildcard takes an answer engine, a live fetch or an archive with it, as naming them would.
      const consequential = wildcardBlocked.some((b) => b.crawlerClass !== "training");
      checks.push({
        name: WILDCARD_CHECK,
        status: consequential ? "warn" : "info",
        message: `robots.txt blocks ${wildcardBlocked.length === verdicts.length ? "all" : wildcardBlocked.length} known AI crawlers through the wildcard group (User-agent: * with Disallow: /), not by name (${wildcardBlocked.map((b) => b.token).join(", ")}). This is the same rule crawl/robots-txt reports as blocking all crawling: removing it lets them all in, and naming a crawler in its own group decides it separately.`,
        value: `${wildcardBlocked.length} crawler(s) blocked by the wildcard`,
        // ONE item: a comparison counts every item as a finding, and this is one change.
        items: [
          {
            id: WILDCARD_LOCATOR,
            label: `User-agent: * (Disallow: /) blocks ${wildcardBlocked.length} AI crawlers: ${wildcardBlocked.map((b) => b.token).join(", ")}`,
            meta: { crawlers: wildcardBlocked.map((b) => b.token) },
          },
        ],
        details: {
          crawlers: wildcardBlocked.map((b) => b.token),
          blockedByClass: {
            training: wildcardClasses("training"),
            "ai-search": wildcardClasses("ai-search"),
            "user-action": wildcardClasses("user-action"),
            archive: wildcardClasses("archive"),
          },
          seeRule: "crawl/robots-txt",
        },
      });
    }

    // Blocking an answer-engine or live user fetch is usually accidental → warn.
    const answerBlocked = namedBlocked.filter(
      (b) => b.crawlerClass === "ai-search" || b.crawlerClass === "user-action",
    );
    if (answerBlocked.length > 0) {
      const search = answerBlocked.filter((b) => b.crawlerClass === "ai-search");
      const user = answerBlocked.filter((b) => b.crawlerClass === "user-action");
      const parts: string[] = [];
      if (search.length > 0)
        parts.push(`AI-search indexers (${search.map((b) => b.token).join(", ")}) : lost AI citations`);
      if (user.length > 0)
        parts.push(
          `user-action fetchers (${user.map((b) => b.token).join(", ")}) : breaks live requests users made inside an assistant`,
        );
      checks.push({
        name: "ai-answer-access",
        status: "warn",
        message: `robots.txt blocks ${parts.join("; ")}. These are separate user-agents from the training bots: blocking ClaudeBot (training) does not block Claude-User (user-action); check the block was intended.`,
        value: `${answerBlocked.length} answer-engine bot(s) blocked`,
        items: answerBlocked.map((b) => ({
          id: b.token,
          label: `${b.token} (${b.vendor}, ${CLASS_LABEL[b.crawlerClass]}) — blocked`,
        })),
        details: {
          aiSearch: search.map((b) => b.token),
          userAction: user.map((b) => b.token),
        },
      });
    }

    // Archive crawlers (CCBot, Internet Archive) feed the Wayback Machine and
    // the Common Crawl corpus — the sources AI labs train from. Blocking them
    // removes the site from those archives entirely, a bigger decision than
    // opting out of one vendor's training bot.
    const archiveBlocked = namedBlocked.filter((b) => b.crawlerClass === "archive");
    if (archiveBlocked.length > 0) {
      checks.push({
        name: "archive-crawler-access",
        status: "warn",
        message: `robots.txt blocks archive crawlers: this removes the site from the Wayback Machine and/or the Common Crawl corpus, the archives AI training sets are built from. Blocking CCBot opts you out of every model trained on Common Crawl, not just one vendor.`,
        value: `${archiveBlocked.length} archive crawler(s) blocked`,
        items: archiveBlocked.map((b) => ({
          id: b.token,
          label: `${b.token} (${b.vendor}, ${b.purpose}) — blocked`,
        })),
        details: { archive: archiveBlocked.map((b) => b.token) },
      });
    }

    // Search-engine bots: per-bot verdict for the audited URL. Googlebot blocked (from the root or for this
    // path) warns, since it usually means the site is deindexed, often by a staging `Disallow: /` left in; every
    // other engine stays info, as does an allowed Googlebot and an `Allow` override.
    const auditedUrl = ctx.site?.entryUrls?.[0] ?? ctx.site?.baseUrl ?? ctx.page.url;
    const search = evaluateSearchEngineBots(robotsTxt, auditedUrl);
    const searchBlocked = search.filter((v) => v.verdict !== "allowed");
    const googlebot = search.find((v) => v.token === "Googlebot");
    const googlebotBlocked = googlebot?.verdict === "root-blocked" || googlebot?.verdict === "path-blocked";
    checks.push({
      name: "search-engine-access",
      status: googlebotBlocked ? "warn" : "info",
      message: `${googlebotBlocked ? `robots.txt blocks Googlebot (${SEARCH_VERDICT_LABEL[googlebot.verdict]}), which usually means the site is not indexed: check the block was intended. ` : ""}Search-engine bots for ${auditedUrl}: ${search
        .map((v) => `${v.token} ${SEARCH_VERDICT_LABEL[v.verdict]}`)
        .join("; ")}`,
      value: `${search.length - searchBlocked.length}/${search.length} allowed`,
      items: searchBlocked.map((v) => ({
        id: v.token,
        label: `${v.token} (${v.vendor}, search engine): ${SEARCH_VERDICT_LABEL[v.verdict]}`,
      })),
      details: {
        auditedUrl,
        bots: search.map((v) => ({
          token: v.token,
          crawlerClass: v.crawlerClass,
          verdict: v.verdict,
          rootBlocked: v.rootBlocked,
          pathBlocked: v.pathBlocked,
          explicitlyListed: v.explicitlyListed,
        })),
      },
    });

    return { checks };
  },
};
