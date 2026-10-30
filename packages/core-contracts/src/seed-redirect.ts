/**
 * Start URL redirects (squirrelscan/squirrelscan#1281).
 *
 * `squirrel audit bit.ly/x` used to grade the shortener. The start URL's
 * redirect chain is now resolved before the crawl, and the destination is the
 * audit target: silently when the chain stays on one site, with the user's
 * consent when it changes site. These are the shapes every surface shares: the
 * CLI, the local MCP tool, the renderers, and the hosted API and MCP server
 * (which carry `follow_redirect` on a run request and answer `redirected`).
 *
 * Leaf module (one import, within this package), so the API Worker and the
 * renderers can pull it without the crawler.
 */
import { shellWord } from "./offsite-redirect";

/** Hops a start URL's chain may take before it is reported instead of followed. */
export const MAX_SEED_REDIRECT_HOPS = 5;

/**
 * `squirrel audit` exit code when the start URL redirected to another site and
 * the run was not told to follow it. 1 stays the operational failure, 2 the
 * `--fail-on` gate and 3 a WAF block.
 */
export const EXIT_CODE_REDIRECTED = 4;

/** One response in a start URL's chain: the URL asked, and the status it answered. */
export interface SeedRedirectHop {
  url: string;
  /** HTTP status of the answer: 3xx for a hop that redirected, the destination's own status for the last. */
  status: number;
}

/**
 * How resolving the chain ended.
 *  - `none`: the start URL did not redirect.
 *  - `same-site`: it redirected within one registrable domain (http to https,
 *    apex to www, a path change). Followed without asking.
 *  - `cross-domain`: it ended on another registrable domain or port. Needs consent.
 *  - `loop`: the chain revisited a URL.
 *  - `too-many`: the chain passed {@link MAX_SEED_REDIRECT_HOPS}.
 *  - `refused`: a hop was refused by the egress guard (a private, link-local or
 *    metadata address) and was never requested.
 */
export type SeedRedirectKind =
  | "none"
  | "same-site"
  | "cross-domain"
  | "loop"
  | "too-many"
  | "refused";

export interface SeedRedirectResolution {
  kind: SeedRedirectKind;
  /** The URL as the user gave it. */
  originalUrl: string;
  /**
   * Where the chain ended: the audit target. For `loop`, `too-many` and
   * `refused` it is the URL the chain was headed to, which was not requested
   * (or, for a loop, was requested already).
   */
  finalUrl: string;
  /**
   * Every URL requested, in order, with the status each answered. The last
   * entry is the destination's own answer when it gave one, so a start URL that
   * does not redirect has one entry and a followed redirect has two or more.
   * Empty when the first request got no answer at all.
   */
  chain: SeedRedirectHop[];
  /** Why a `refused` chain stopped: the guard's wording. Absent otherwise. */
  refusal?: string;
}

/**
 * The record of a followed start redirect, carried by the report
 * (`originalUrl`, `redirectChain`) and by a cloud run, whose website belongs to
 * the final domain with `originalUrl` kept as an alias. `redirectChain` has the
 * shape of {@link SeedRedirectResolution.chain}: the last entry is the
 * destination.
 */
export interface SeedRedirectRecord {
  originalUrl: string;
  redirectChain: SeedRedirectHop[];
}

/**
 * The answer for a run that did not audit because the start URL redirected
 * (CLI exit status {@link EXIT_CODE_REDIRECTED}, hosted MCP
 * `confirmation_required`/`redirected`). It names the destination and the exact
 * command to run again; there is no score.
 */
export interface SeedRedirectedOutcome {
  status: "redirected";
  reason: SeedRedirectKind;
  originalUrl: string;
  finalUrl: string;
  redirectChain: SeedRedirectHop[];
  /** What to run to audit the destination, or null when the chain did not end on a usable URL. */
  rerunCommand: string | null;
  /** What happened, ready to print. The command to run is `rerunCommand`, kept out of it. */
  message: string;
}

/**
 * The outcome for a resolution that must not be audited as it stands, or null
 * when the run can go on (`none` and `same-site`, and a `cross-domain` the
 * caller has consent for: it decides that, not this).
 *
 * `rerunCommand` is the CLI command that audits the start URL as the user
 * typed it with the follow consent given (`cross-domain`), or the redacted
 * destination where the chain could not be followed to its end (`too-many`);
 * null for a loop or a refused hop, where there is nothing to re-run.
 */
export function redirectedOutcome(
  resolution: SeedRedirectResolution,
): SeedRedirectedOutcome | null {
  if (resolution.kind === "none" || resolution.kind === "same-site") return null;
  const { kind } = resolution;
  // Every URL that is printed or recorded is redacted: a Location header can
  // carry a token in its query or credentials in its userinfo.
  const originalUrl = redactUrl(resolution.originalUrl);
  const finalUrl = redactUrl(resolution.finalUrl);
  const chain = resolution.chain.map((hop) => ({ url: redactUrl(hop.url), status: hop.status }));
  let rerunCommand: string | null = null;
  let message: string;
  switch (kind) {
    case "cross-domain":
      // The URL the user typed, not the destination: nothing of theirs is lost.
      rerunCommand = `squirrel audit ${shellWord(resolution.originalUrl)} --follow-redirect`;
      message = `${originalUrl} redirects to ${finalUrl}, a different site, so nothing was audited.`;
      break;
    case "loop":
      message = `${originalUrl} redirects in a loop (back to ${finalUrl}), so nothing was audited.`;
      break;
    case "too-many":
      rerunCommand = `squirrel audit ${shellWord(finalUrl)}`;
      message = `${originalUrl} redirects more than ${MAX_SEED_REDIRECT_HOPS} times, so nothing was audited. The chain was heading to ${finalUrl}.`;
      break;
    default: {
      const scheme = /^refused scheme ([a-z][a-z0-9+.-]*:)$/i.exec(resolution.refusal ?? "")?.[1];
      message = scheme
        ? `${originalUrl} redirects to a ${scheme} URL, which was refused and never requested, so nothing was audited. The last URL requested was ${finalUrl}.`
        : `${originalUrl} redirects to ${finalUrl}, which was not requested (${resolution.refusal ?? "refused"}), so nothing was audited.`;
    }
  }
  return {
    status: "redirected",
    reason: kind,
    originalUrl,
    finalUrl,
    redirectChain: chain,
    rerunCommand,
    message,
  };
}

/**
 * `value` without userinfo, query and fragment: scheme, host, port and path.
 * A redirect's query often carries a token or a return address, and userinfo is
 * a credential; neither belongs in a report that may be published, a prompt, a
 * log or an agent's context. Anything that is not an http(s) URL becomes a
 * fixed placeholder.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.href;
    }
  } catch {
    // Falls through to the placeholder.
  }
  return "(unprintable URL)";
}

/** Characters that end a URL inside error text: whitespace, quotes and closing brackets. */
const TOKEN_LEAD = new Set(["(", '"', "'", "`", "<", "[", "{"]);
const TOKEN_TRAIL = new Set([".", ",", ";", ":", "!", "?", ")", '"', "'", "`", ">", "]", "}"]);
const URL_PLACEHOLDER = "(redacted URL)";

function redactTokenCore(core: string): string {
  const urlish =
    core.includes(":/") ||
    core.includes(":\\") ||
    core.startsWith("//") ||
    core.startsWith("\\\\") ||
    core.includes("@") ||
    (/[?#]./.test(core) && /[/.]/.test(core));
  if (!urlish) return core;
  if (/^https?:/i.test(core)) {
    const redacted = redactUrl(core);
    if (redacted !== "(unprintable URL)") return redacted;
  }
  return URL_PLACEHOLDER;
}

/**
 * `text` with every URL-like whitespace-delimited token redacted, so error text that echoes a start
 * URL (a DNS, TLS or fetch failure) never carries userinfo, a query token or a fragment into a
 * report, a log or an agent's context. Fails closed: a token that is an http(s) URL the WHATWG
 * parser accepts goes through {@link redactUrl} (its own view of userinfo, so no differential);
 * any other token that looks like a URL (other scheme, `//` or `\\` prefix, `@`, a `?`/`#` tail
 * on a path) or that does not parse is replaced whole. Linear: one split, no backtracking.
 */
export function redactUrlsInText(text: string): string {
  return text
    .split(/(\s+)/)
    .map((token, index) => {
      if (index % 2 === 1 || token === "") return token;
      let start = 0;
      let end = token.length;
      while (start < end && TOKEN_LEAD.has(token[start]!)) start++;
      while (end > start && TOKEN_TRAIL.has(token[end - 1]!)) end--;
      return token.slice(0, start) + redactTokenCore(token.slice(start, end)) + token.slice(end);
    })
    .join("");
}
