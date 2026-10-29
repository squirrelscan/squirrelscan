// Start URL redirects (squirrelscan/squirrelscan#1281): how every renderer says
// that the audit began at another URL, and what a run that was stopped by a
// redirect prints in place of a report.
//
// Every URL here came from a `Location` header the start URL's site chose, so
// each is re-serialised by the URL parser (or replaced by a fixed placeholder)
// before it reaches a terminal, markdown, XML or JSON. Escaping for the output
// format stays with the caller of the `*Line` helpers; the outcome renderers
// below escape their own.

import { stripControlChars } from "@squirrelscan/core-contracts/control-chars";
import type { SeedRedirectedOutcome } from "@squirrelscan/core-contracts/seed-redirect";

import { chainText, printableReportUrl as printable, safeChain } from "./coverage";

// ---------------------------------------------------------------------------
// A run stopped by a redirect: no crawl, no score.
// ---------------------------------------------------------------------------

export type RedirectedOutcomeFormat =
  | "console"
  | "text"
  | "markdown"
  | "json"
  | "llm"
  | "xml"
  | "html";

/** The outcome with every URL made safe to print and the prose rebuilt from them. */
function safeOutcome(outcome: SeedRedirectedOutcome): SeedRedirectedOutcome {
  const originalUrl = printable(outcome.originalUrl);
  const finalUrl = printable(outcome.finalUrl);
  const rerunCommand =
    outcome.rerunCommand && stripControlChars(outcome.rerunCommand) === outcome.rerunCommand
      ? outcome.rerunCommand
      : null;
  return {
    ...outcome,
    originalUrl,
    finalUrl,
    redirectChain: safeChain(outcome.redirectChain),
    rerunCommand,
    // Whatever else the message quotes is dropped to its printable characters.
    message: stripControlChars(
      // Replacer functions: a `$&` or `$'` in a URL is text, not a replacement pattern.
      outcome.message
        .replace(outcome.originalUrl, () => originalUrl)
        .replace(outcome.finalUrl, () => finalUrl),
    ),
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+!|<>~])/g, "\\$1");
}

/**
 * What `squirrel audit` prints when the start URL redirected and the run was
 * not allowed to follow it (exit status {@link EXIT_CODE_REDIRECTED}): the
 * destination, the chain and the command to run next. There is no score.
 */
export function renderRedirectedOutcome(
  input: SeedRedirectedOutcome,
  format: RedirectedOutcomeFormat,
): string {
  const outcome = safeOutcome(input);
  const chain = outcome.redirectChain;
  switch (format) {
    case "json":
      return JSON.stringify(outcome, null, 2);
    case "xml":
    case "llm": {
      const lines = [
        `<audit status="redirected" reason="${escapeXml(outcome.reason)}">`,
        `  <original-url>${escapeXml(outcome.originalUrl)}</original-url>`,
        `  <final-url>${escapeXml(outcome.finalUrl)}</final-url>`,
        "  <redirect-chain>",
        ...chain.map(
          (hop) => `    <hop status="${hop.status}">${escapeXml(hop.url)}</hop>`,
        ),
        "  </redirect-chain>",
        ...(outcome.rerunCommand
          ? [`  <rerun-command>${escapeXml(outcome.rerunCommand)}</rerun-command>`]
          : []),
        `  <note>${escapeXml(outcome.message)} No audit ran and there is no score.</note>`,
        "</audit>",
      ];
      return lines.join("\n");
    }
    case "html": {
      const e = escapeXml;
      return [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8"><title>Not audited: the start URL redirects</title></head><body>',
        "<h1>Not audited: the start URL redirects</h1>",
        `<p>${e(outcome.message)}</p>`,
        "<ul>",
        `<li>Original URL: <code>${e(outcome.originalUrl)}</code></li>`,
        `<li>Final URL: <code>${e(outcome.finalUrl)}</code></li>`,
        ...chain.map((hop) => `<li>${hop.status || "?"} <code>${e(hop.url)}</code></li>`),
        "</ul>",
        ...(outcome.rerunCommand ? [`<p>Re-run: <code>${e(outcome.rerunCommand)}</code></p>`] : []),
        "</body></html>",
      ].join("\n");
    }
    case "markdown": {
      const lines = [
        "# Not audited: the start URL redirects",
        "",
        escapeMarkdown(outcome.message),
        "",
        `- Original URL: \`${outcome.originalUrl}\``,
        `- Final URL: \`${outcome.finalUrl}\``,
        ...(chain.length > 0
          ? ["- Chain:", ...chain.map((hop) => `  - ${hop.status || "?"} \`${hop.url}\``)]
          : []),
        // The command carries the URL the user typed, which may hold a backtick.
        ...(outcome.rerunCommand ? ["", `Re-run: ${escapeMarkdown(outcome.rerunCommand)}`] : []),
      ];
      return lines.join("\n");
    }
    default: {
      const lines = [
        "Not audited: the start URL redirects.",
        outcome.message,
        `Original URL: ${outcome.originalUrl}`,
        `Final URL: ${outcome.finalUrl}`,
        ...(chain.length > 0 ? [`Chain: ${chainText(chain)}`] : []),
        ...(outcome.rerunCommand ? [`Re-run: ${outcome.rerunCommand}`] : []),
      ];
      return lines.join("\n");
    }
  }
}
