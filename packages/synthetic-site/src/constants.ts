// Numeric thresholds the issue classes are built to exceed. Exported so tests
// (and consumers asserting on generated content) don't hardcode magic numbers.

/** Long h1 issue class targets h1 text longer than this many characters. */
export const LONG_H1_MIN_LENGTH = 1000;

/** Oversize meta title issue class targets title text longer than this. */
export const OVERSIZE_TITLE_MIN_LENGTH = 300;

/** Oversize meta description issue class targets description text longer than this. */
export const OVERSIZE_DESCRIPTION_MIN_LENGTH = 500;

/** Long URL issue class targets full href length longer than this (the >2048 char class). */
export const LONG_URL_MIN_LENGTH = 2048;

export const DEFAULT_TEMPLATE_COUNT = 5;
export const DEFAULT_MIN_PAGE_SIZE_BYTES = 30_000;
export const DEFAULT_MAX_PAGE_SIZE_BYTES = 80_000;
export const DEFAULT_CLEAN_RATIO = 0.5;

/** Reserved path prefixes the page-path generator never produces, so issue
 * injection can safely use them for links that must NOT resolve to a real page. */
export const RESERVED_BROKEN_LINK_PREFIX = "/broken";
export const RESERVED_REDIRECT_CHAIN_PREFIX = "/redirect-chain";
