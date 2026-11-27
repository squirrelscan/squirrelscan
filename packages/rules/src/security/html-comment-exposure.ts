// security/html-comment-exposure - sensitive information left in HTML comments

import type { CheckItem } from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { scanContent } from "./leaked-secrets";

const COMMENT_NODE = 8;
const ELEMENT_NODE = 1;
/** Comments read per page, and characters of each: a page can hold tens of thousands of them. */
const MAX_COMMENTS = 500;
const MAX_COMMENT_CHARS = 20_000;
/** Items reported per page, and the longest quoted snippet. */
const MAX_ITEMS = 25;
export const SNIPPET_MAX_LENGTH = 160;
export const REDACTED = "[redacted]";

export type CommentSignal =
  | "secret"
  | "internal-host"
  | "exposure-note"
  | "commented-markup";

/** Comments that are markers or directives, never author notes: IE conditionals, framework and build markers. */
const MARKER_RES: readonly RegExp[] = [
  /^\[if[\s\S]*$/i, // IE conditional comment, downlevel-hidden
  /^<!\[endif\]$/i,
  /^\[endif\]$/i,
  /^<!\[endif\]/i,
  /^\[if[^\]]{0,200}\]><!$/i, // downlevel-revealed opener
  /^[[\]$?!#/]{1,3}$/, // Vue, Svelte, React SSR boundaries: <!--[-->, <!--]-->, <!--$-->, <!--/$-->
  /^v-(?:if|else|for|show)$/i,
  /^(?:more|nextpage)$/i,
  /^\/?wp:/i, // WordPress blocks
  /^(?:ko|\/ko)(?:\s|$)/i, // Knockout
  /^astro:/i,
  /^(?:head|body)_(?:start|end)$/i,
  /^\/?(?:ngIf|ngFor|ng-container)/i,
  /^(?:end|begin|start)\s+(?:of\s+)?[\w .:-]{1,80}$/i, // build and template section markers
  /^\/?(?:google\s+tag\s+manager|gtm)\b/i,
  /^(?:global\s+site\s+tag|this\s+site\s+is\s+optimized|generated\s+by\b|built\s+with\b|rendered\s+(?:at|on|by)\b|saved\s+in\s+\d)/i,
  /^#?(?:end)?region\b/i,
  /^(?:main|content|header|footer|sidebar|nav(?:igation)?)\b[\w\s-]{0,40}$/i,
];

/** True when the comment is an IE conditional or a common framework or build marker. */
export function isMarkerComment(data: string): boolean {
  const text = data.trim();
  if (text === "") return true;
  if (/<!\[endif\]/i.test(text)) return true;
  return MARKER_RES.some((re) => re.test(text));
}

const RFC1918 =
  /(?<![\w.])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2})(?![\w.]*\d)/;
const INTERNAL_TLD =
  /(?<![\w-])[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9-]{1,63}){0,6}\.(?:internal|local|lan|corp|intranet)(?![\w-])/i;
const STAGING_HOST =
  /(?<![\w.-])(?:staging|stage|stg|uat|qa|preprod|pre-prod|sandbox|dev|test)\d{0,2}(?:-[a-z0-9-]{1,40})?\.(?:[a-z0-9-]{1,63}\.){1,5}[a-z]{2,24}(?![\w-])/i;
const LOCALHOST = /(?<![\w.-])localhost(?::\d{2,5})?(?![\w-])/i;

const NOTE_CASE_SENSITIVE = /\b(?:TODO|FIXME|HACK|XXX)\b/;
const NOTE_INSENSITIVE =
  /\b(?:remove\s+before|do\s+not\s+ship|don'?t\s+ship|password|passwd|debug)\b/i;

const MARKUP_TAG = /<\s*(?:script|form)\b/i;
const ADMIN_MARKUP =
  /<\s*[a-z][a-z0-9-]{0,20}\b[^<>]{0,300}(?:href|action|src|id|class)\s*=\s*["']?[^"'<>\s]{0,200}admin/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

interface Hit {
  signal: CommentSignal;
  index: number;
}

/** Signals found in text that has already had its secrets redacted. */
export function findSignals(text: string, pageHost: string): Hit[] {
  const hits: Hit[] = [];
  const add = (signal: CommentSignal, m: RegExpExecArray | null) => {
    if (m) hits.push({ signal, index: m.index });
  };
  add("internal-host", RFC1918.exec(text));
  add("internal-host", INTERNAL_TLD.exec(text));
  add("internal-host", LOCALHOST.exec(text));
  const staging = STAGING_HOST.exec(text);
  // The page's own host is not a leak, even when it is a staging host.
  if (staging && staging[0].toLowerCase() !== pageHost)
    add("internal-host", staging);
  add("exposure-note", NOTE_CASE_SENSITIVE.exec(text));
  add("exposure-note", NOTE_INSENSITIVE.exec(text));
  add("commented-markup", MARKUP_TAG.exec(text));
  add("commented-markup", ADMIN_MARKUP.exec(text));
  return hits;
}

/** Replace every secret the leaked-secrets matchers find with {@link REDACTED}. Returns the text and whether any matched. */
export function redactSecrets(data: string): {
  text: string;
  found: boolean;
} {
  const secrets = scanContent(data, "html-comment").filter(
    (s) => s.confidence !== "info" && !s.publicByDesign
  );
  if (secrets.length === 0) return { text: data, found: false };
  let text = data;
  let floor = data.length;
  // From the end, so earlier offsets stay valid; overlapping matches are skipped.
  for (const s of [...secrets].sort((a, b) => b.offset - a.offset)) {
    const end = s.offset + s.length;
    if (end > floor || s.offset < 0) continue;
    text = text.slice(0, s.offset) + REDACTED + text.slice(end);
    floor = s.offset;
  }
  return { text, found: true };
}

function snippetAround(text: string, index: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX_LENGTH) return flat;
  const room = SNIPPET_MAX_LENGTH - 2;
  const start = Math.max(0, Math.min(index - 40, flat.length - room));
  const end = start + room;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

function commentsOf(root: Node): string[] {
  const out: string[] = [];
  const stack: Node[] = [];
  for (let c = root.lastChild; c; c = c.previousSibling) stack.push(c);
  while (stack.length > 0 && out.length < MAX_COMMENTS) {
    const node = stack.pop()!;
    if (node.nodeType === COMMENT_NODE)
      out.push((node as Comment).data.slice(0, MAX_COMMENT_CHARS));
    else if (node.nodeType === ELEMENT_NODE)
      for (let c = node.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return out;
}

const SIGNAL_LABEL: Record<CommentSignal, string> = {
  secret: "a secret",
  "internal-host": "an internal host or IP",
  "exposure-note": "a note suggesting exposure",
  "commented-markup": "commented-out script, form or admin markup",
};

export const htmlCommentExposureRule: Rule = {
  meta: {
    id: "security/html-comment-exposure",
    name: "Sensitive information in HTML comments",
    description:
      "Flags HTML comments that hold internal hosts or IPs, exposure notes, secrets or commented-out script, form and admin markup",
    solution:
      "HTML comments are sent to every visitor. Delete comments that name internal hosts or IPs, carry TODO, FIXME, HACK or password notes, or hold commented-out script, form or admin markup, and strip comments from production builds (an HTML minifier option). Rotate any secret that was in a comment.",
    category: "security",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
    checks: [
      { name: "html-comment-exposure", outcome: "problem" },
      {
        name: "html-comment-exposure",
        outcome: "clean",
        clears: ["html-comment-exposure"],
      },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const pageHost = hostOf(ctx.page.url);
    const comments = commentsOf(doc);

    const items: CheckItem[] = [];
    let flagged = 0;
    let assessed = 0;
    for (const [i, data] of comments.entries()) {
      if (isMarkerComment(data)) continue;
      assessed++;
      const redacted = redactSecrets(data);
      const found = redacted.found;
      // Flat, so a signal's index is also its index in the snippet's source.
      const text = redacted.text.replace(/\s+/g, " ").trim();
      const hits = findSignals(text, pageHost);
      const signals = new Set<CommentSignal>(hits.map((h) => h.signal));
      if (found) signals.add("secret");
      if (signals.size === 0) continue;
      flagged++;
      if (items.length >= MAX_ITEMS) continue;
      const list = [...signals];
      items.push({
        id: `comment ${i + 1}`,
        label: `Comment ${i + 1} of ${comments.length} on ${ctx.page.url} holds ${list.map((s) => SIGNAL_LABEL[s]).join(", ")}`,
        snippet: snippetAround(text, hits[0]?.index ?? text.indexOf(REDACTED)),
        meta: { signals: list, position: i + 1, comments: comments.length },
      });
    }

    const checks: CheckResult[] = [];
    if (flagged > 0) {
      checks.push({
        name: "html-comment-exposure",
        status: "warn",
        message: `${flagged} HTML comment(s) on ${ctx.page.url} hold sensitive information`,
        items,
        details: { commentsChecked: assessed, flagged },
      });
    } else {
      checks.push({
        name: "html-comment-exposure",
        status: "pass",
        message: "No HTML comment holds sensitive information",
        details: { commentsChecked: assessed },
      });
    }
    return { checks };
  },
};
