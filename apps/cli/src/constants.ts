// CLI app constants - re-exports shared constants + CLI-specific ones

// Re-export all shared constants from @squirrelscan/utils
export {
  RESOURCE_SIZE_LIMITS,
  SCRIPT_FETCH_LIMITS,
  HTTP_PROBE_LIMITS,
  SQUIRRELSCAN_USER_AGENT,
  SECRET_CONTEXT_WINDOW_SIZE,
  GOOGLEBOT_HTML_MAX_BYTES,
  GOOGLEBOT_HTML_WARN_BYTES,
  GOOGLEBOT_PDF_MAX_BYTES,
  GOOGLEBOT_PDF_WARN_BYTES,
  MIN_INTERNAL_LINKS,
  KEY_SEPARATOR,
  CHROME_USER_AGENT,
  CHROME_VERSION,
  CHROME_SEC_CH_UA,
  SITEMAP_COVERAGE_WARN_PERCENT,
  SITEMAP_COVERAGE_WARN_COUNT,
  LOCAL_BUSINESS_TYPES,
  type LocalBusinessType,
  EEAT_PAGE_PATTERNS,
  SCORING_CURVE_EXPONENT,
  SCORE_SCALE,
  PENALTY_NO_ROBOTS_TXT,
  PENALTY_ROBOTS_BLOCKS_ALL,
  PENALTY_NO_SITEMAP,
  RULE_ID_ROBOTS_TXT,
  RULE_ID_SITEMAP_EXISTS,
  CHECK_NAME_ROBOTS_DISALLOW,
  CHECK_NAME_ROBOTS_EXISTS,
  CHECK_NAME_SITEMAP_EXISTS,
  ISSUE_PENALTY_THRESHOLD,
  ISSUE_PENALTY_WARNING_WEIGHT,
  ISSUE_PENALTY_FAIL_WEIGHT,
  ISSUE_PENALTY_SCALE,
  ISSUE_PENALTY_MAX,
  DEFAULT_EXCLUDE_PATTERNS,
  REPORT_COLLAPSE_THRESHOLD,
  REPORT_ITEMS_COLLAPSE_THRESHOLD,
  REPORT_TEXT_WRAP_WIDTH,
  REPORT_SOURCE_PAGES_PREVIEW,
} from "@squirrelscan/utils/constants";

// Re-export operational limits from core-contracts
export {
  TELEMETRY,
  MAX_PAGES_CAP,
  MAX_CRAWL_CONCURRENCY,
  COVERAGE_PAGE_LIMITS,
} from "@squirrelscan/core-contracts/limits";

// ============================================
// CLI-specific constants (not shared)
// ============================================

// Telemetry — keep legacy name for existing callers
import { TELEMETRY as _TEL } from "@squirrelscan/core-contracts/limits";
export const TELEMETRY_TIMEOUT_MS = _TEL.timeoutMs;

// Web dashboard — linked from account/credit lines
export const DASHBOARD_URL = "https://app.squirrelscan.com";

// Public pricing page — linked from Team-plan upsell messaging (#739)
export const PRICING_URL = "https://squirrelscan.com/pricing";

// Informational status requests (whoami, balance preflight) must never stall
// a command — a wedged local dev API hangs an un-timed fetch indefinitely.
export const STATUS_REQUEST_TIMEOUT_MS = 10_000;

// CLI reserved names - reject these as domain inputs
export const CLI_RESERVED_NAMES = [
  "agent",
  "audit",
  "crawl",
  "analyze",
  "report",
  "init",
  "config",
  "feedback",
  "self",
  "help",
  "list",
  "version",
] as const;

// Output formats
export const OUTPUT_FORMATS = [
  "console",
  "text",
  "json",
  "html",
  "markdown",
  "xml",
  "llm",
] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export const OUTPUT_FORMATS_HELP = OUTPUT_FORMATS.join(", ");

// Terminal/progress display constants
export const DEFAULT_TERMINAL_COLUMNS = 80;
export const PROGRESS_DETAIL_PADDING = 5;
export const PROGRESS_SPINNER_INTERVAL_MS = 80;
export const MIN_DETAIL_LENGTH = 10;

// Update notification constants
export const UPDATE_SNOOZE_HOURS = 24;
export const UPDATE_NOTIFICATION_MAX_WIDTH = 80;
export const AUTO_UPDATE_DISABLED_REMINDER_DAYS = 7;
// Failed background auto-update attempts (same target version, never applied)
// after which the CLI stops the reassuring "updating in the background" line
// and shows the loud manual-update box instead (#1085/#1074).
export const AUTO_UPDATE_FALLBACK_THRESHOLD = 2;

// Breadth-first crawling constants
export const CRAWL_BREADTH_DEPTH_PENALTY = 1000;
export const CRAWL_BREADTH_MAX_PREFIX_PENALTY = 500;
export const CRAWL_BREADTH_PENALTY_MULTIPLIER = 200;

// Coverage mode defaults — re-exported from core-contracts
import { COVERAGE_PAGE_LIMITS as _CPL } from "@squirrelscan/core-contracts/limits";
export const COVERAGE_QUICK_MAX_PAGES = _CPL.quick;
export const COVERAGE_SURFACE_MAX_PAGES = _CPL.surface;
export const COVERAGE_FULL_MAX_PAGES = _CPL.full;

// Pattern sampling (surface mode)
export const PATTERN_SAMPLED_PENALTY = 2000;
export const PATTERN_SAMPLE_LIMIT = 1;

// Log rotation constants
export const LOG_COMPRESS_AFTER_DAYS = 14;
export const LOG_DELETE_AFTER_DAYS = 60;
export const LOG_MAX_STRING_LENGTH = 1000;
export const LOG_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// Content store limits
export const CONTENT_STORE_MAX_BYTES = 1024 * 1024 * 1024; // 1GB
export const CONTENT_STORE_PRUNE_THRESHOLD = 0.9;

// Crawl-phase wall-clock backstop — a last-resort total cap so a wedged crawl
// (e.g. a cloud render that never returns) can't hang the CLI indefinitely.
// Sized to (almost) never fire on a healthy-but-slow crawl: the per-URL
// watchdog inside the crawler is the primary self-heal. See #294.
/** Generous per-page allowance; well above ~15–30s renders + the 120s per-URL watchdog. */
export const CRAWL_PHASE_PER_PAGE_BUDGET_MS = 60_000;
/** Fixed setup slack on top of the per-page budget (robots/sitemap/redirects). */
export const CRAWL_PHASE_SETUP_SLACK_MS = 60_000;
/** Floor — never cap a crawl below this regardless of page count. */
export const CRAWL_PHASE_MIN_TIMEOUT_MS = 120_000;
/** Ceiling — absolute backstop for very large crawls. */
export const CRAWL_PHASE_MAX_TIMEOUT_MS = 1_800_000; // 30 min

// CSR-shell thresholds (#294) moved to @squirrelscan/fetchers csr-detect.ts.
