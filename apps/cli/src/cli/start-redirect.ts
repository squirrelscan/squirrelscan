// Start URL redirects (squirrelscan/squirrelscan#1281): resolve the start URL's
// chain before the audit and decide what the run audits.
//
//   same site (http to https, apex to www, a path)  followed silently
//   another registrable domain                      needs consent: a prompt on
//                                                   a TTY, else --follow-redirect
//                                                   or [crawler] follow_redirect
//   a loop, more than five hops, a refused hop      never followed
//
// `-y` is deliberately not an input: it approves credit spend, agents pass it
// routinely, and an off-site redirect may land on somebody else's site.

import {
  redactUrl,
  redirectedOutcome,
  type SeedRedirectRecord,
  type SeedRedirectResolution,
  type SeedRedirectedOutcome,
} from "@squirrelscan/core-contracts/seed-redirect";
import { resolveStartRedirect } from "@squirrelscan/crawler/seed-redirect";
import {
  renderRedirectedOutcome,
  type RedirectedOutcomeFormat,
} from "@squirrelscan/report";
import { writeFileSync } from "node:fs";

import { promptForInput } from "@/cli/prompt";

export type StartRedirectDecision =
  /** Audit `url`; `record` is set when a cross-domain redirect was followed. */
  | { action: "audit"; url: string; record?: SeedRedirectRecord }
  /** Ask the user whether to audit the destination. */
  | { action: "ask"; resolution: SeedRedirectResolution }
  /** Do not audit: print the outcome and exit with status `redirected`. */
  | { action: "stop"; outcome: SeedRedirectedOutcome };

export interface StartRedirectContext {
  /** `--follow-redirect`, else `[crawler] follow_redirect`. */
  follow: boolean;
  /** A person can be asked: stdin and stdout are a terminal and stdout is not the report. */
  interactive: boolean;
}

/** What a resolved chain means for the run. Pure; see the header for the rules. */
export function decideStartRedirect(
  resolution: SeedRedirectResolution,
  context: StartRedirectContext
): StartRedirectDecision {
  if (resolution.kind === "none")
    return { action: "audit", url: resolution.originalUrl };
  if (resolution.kind === "same-site")
    return { action: "audit", url: resolution.finalUrl };
  if (resolution.kind === "cross-domain") {
    if (context.follow) {
      return {
        action: "audit",
        url: resolution.finalUrl,
        record: {
          originalUrl: redactUrl(resolution.originalUrl),
          redirectChain: resolution.chain,
        },
      };
    }
    if (context.interactive) return { action: "ask", resolution };
  }
  const outcome = redirectedOutcome(resolution);
  // `redirectedOutcome` is null only for none and same-site, handled above.
  return outcome
    ? { action: "stop", outcome }
    : { action: "audit", url: resolution.originalUrl };
}

/** `bit.ly/x redirects to https://example.com/pricing. Audit example.com instead? [Y/n]` */
export function startRedirectPrompt(
  resolution: SeedRedirectResolution
): string {
  const shown = redactUrl(resolution.originalUrl).replace(/^https?:\/\//i, "");
  // The destination is the site's choice: only origin and path are echoed.
  const finalUrl = redactUrl(resolution.finalUrl);
  let host = finalUrl;
  try {
    host = new URL(finalUrl).host;
  } catch {
    // Kept as the placeholder.
  }
  return `${shown} redirects to ${finalUrl}. Audit ${host} instead? [Y/n] `;
}

export interface ResolvedAuditStart {
  /** What the audit runs against. */
  url: string;
  /** Set when a cross-domain redirect was followed. */
  record?: SeedRedirectRecord;
  /** Set when the run must not audit. */
  stop?: SeedRedirectedOutcome;
  resolution: SeedRedirectResolution;
}

export interface ResolveAuditStartInput extends StartRedirectContext {
  url: string;
  userAgent?: string;
  /** False where an environment proxy carries requests (see `ownHostsPinned`). */
  pin?: boolean;
  resolve?: typeof resolveStartRedirect;
  /** The yes/no prompt; tests inject one. Default: stdin. */
  ask?: (question: string) => Promise<string>;
}

/**
 * Resolve the start URL and apply the user's consent: the flag or config, a
 * prompt on a terminal, or a stop with the outcome.
 */
export async function resolveAuditStart(
  input: ResolveAuditStartInput
): Promise<ResolvedAuditStart> {
  const resolution = await (input.resolve ?? resolveStartRedirect)(input.url, {
    ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    ...(input.pin === false ? { pin: false } : {}),
  });
  const decision = decideStartRedirect(resolution, input);
  if (decision.action === "audit") {
    return {
      url: decision.url,
      ...(decision.record ? { record: decision.record } : {}),
      resolution,
    };
  }
  if (decision.action === "stop") {
    return { url: input.url, stop: decision.outcome, resolution };
  }
  const answer = (
    await (input.ask ?? promptForInput)(startRedirectPrompt(resolution))
  )
    .trim()
    .toLowerCase();
  if (answer === "" || answer === "y" || answer === "yes") {
    return {
      url: resolution.finalUrl,
      record: {
        originalUrl: redactUrl(resolution.originalUrl),
        redirectChain: resolution.chain,
      },
      resolution,
    };
  }
  const outcome = redirectedOutcome(resolution);
  return { url: input.url, ...(outcome ? { stop: outcome } : {}), resolution };
}

export interface EmitRedirectedOptions {
  /** `--format`; console (or unset) prints the plain text form. */
  format?: string;
  /** `--output`: the file to write instead of stdout. */
  output?: string;
}

const REDIRECTED_FORMATS: ReadonlySet<string> = new Set([
  "text",
  "markdown",
  "json",
  "llm",
  "xml",
  "html",
]);

/**
 * Print what stopped the run in the format asked for: to `--output` (with the
 * message on stderr, where a person is looking) or to stdout.
 */
export function emitRedirectedOutcome(
  outcome: SeedRedirectedOutcome,
  options: EmitRedirectedOptions
): void {
  const format: RedirectedOutcomeFormat =
    options.format && REDIRECTED_FORMATS.has(options.format)
      ? (options.format as RedirectedOutcomeFormat)
      : "console";
  const text = renderRedirectedOutcome(outcome, format);
  if (options.output) {
    writeFileSync(options.output, `${text}\n`);
    console.error(
      outcome.rerunCommand
        ? `${outcome.message} Run: ${outcome.rerunCommand}`
        : outcome.message
    );
    return;
  }
  console.log(text);
}
