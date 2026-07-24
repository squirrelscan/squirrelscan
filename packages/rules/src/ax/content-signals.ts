// ax/content-signals - parse `Content-Signal:` directives in robots.txt
// (contentsignals.org) and flag policy that contradicts the site's own
// crawler-level Disallow rules.

import type { RobotsTxtData } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";
import { type CrawlerClass, evaluateAiCrawlers } from "./ai-crawlers";

/** The three defined content signals (contentsignals.org) and what each governs. */
const KNOWN_SIGNALS = ["search", "ai-input", "ai-train"] as const;
type KnownSignal = (typeof KNOWN_SIGNALS)[number];

/** Which crawler class a declared `<signal>=yes` implies access for — used to
 * spot a signal that opts a purpose IN while the matching crawler class is
 * fully Disallow-ed. */
const SIGNAL_TO_CLASS: Record<KnownSignal, CrawlerClass> = {
  search: "ai-search",
  "ai-input": "user-action",
  "ai-train": "training",
};

const SIGNAL_DESCRIPTION: Record<KnownSignal, string> = {
  search: "search-result display & answer-engine citation",
  "ai-input": "input to an AI system at inference time",
  "ai-train": "training / fine-tuning a model",
};

/** Auxiliary keys that are valid Content-Signal syntax but carry no
 * crawl-permission semantics. Cloudflare's managed robots.txt (contentsignals
 * rollout) emits `use=<immediate|reference|full>` — how AI systems may consume
 * collected content — so treating it as unknown would flag millions of
 * Cloudflare-managed domains as invalid. */
const AUX_SIGNALS: Record<string, readonly string[]> = {
  use: ["immediate", "reference", "full"],
};

export interface ParsedContentSignal {
  /** Lower-cased user-agents of the robots.txt group this directive sits under. */
  userAgents: string[];
  /** The declared known signals, in file order. */
  signals: { key: KnownSignal; value: "yes" | "no" }[];
  /** Recognized auxiliary keys (e.g. Cloudflare's `use=`) with their values. */
  aux: { key: string; value: string }[];
  /** Tokens whose key is not a defined signal. */
  unknownKeys: string[];
  /** Tokens that are not `key=value` or carry a value other than yes/no. */
  malformed: string[];
}

/**
 * Extract every `Content-Signal:` line from raw robots.txt, associating each
 * with the user-agent group it appears under (standard robots grouping: runs of
 * `User-agent:` lines start a group; the first non-UA directive closes the UA
 * run). Comments (`#…`) are stripped.
 */
export function parseContentSignals(content: string): ParsedContentSignal[] {
  const out: ParsedContentSignal[] = [];
  let currentAgents: string[] = [];
  // A run of consecutive `User-agent:` lines shares one group; the next UA line
  // after any other directive opens a fresh group.
  let uaRunOpen = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!uaRunOpen) currentAgents = [];
      currentAgents.push(value.toLowerCase());
      uaRunOpen = true;
      continue;
    }

    uaRunOpen = false;
    if (field === "content-signal") {
      out.push({ userAgents: [...currentAgents], ...parseSignalValue(value) });
    }
  }
  return out;
}

function parseSignalValue(value: string): Omit<ParsedContentSignal, "userAgents"> {
  const signals: ParsedContentSignal["signals"] = [];
  const aux: ParsedContentSignal["aux"] = [];
  const unknownKeys: string[] = [];
  const malformed: string[] = [];

  for (const rawToken of value.split(",")) {
    const token = rawToken.trim();
    if (token === "") continue;
    const eq = token.indexOf("=");
    if (eq === -1) {
      malformed.push(token);
      continue;
    }
    const key = token.slice(0, eq).trim().toLowerCase();
    const val = token.slice(eq + 1).trim().toLowerCase();
    const auxValues = AUX_SIGNALS[key];
    if (auxValues) {
      if (auxValues.includes(val)) aux.push({ key, value: val });
      else malformed.push(token);
      continue;
    }
    if (!KNOWN_SIGNALS.includes(key as KnownSignal)) {
      unknownKeys.push(key);
      continue;
    }
    if (val !== "yes" && val !== "no") {
      malformed.push(token);
      continue;
    }
    signals.push({ key: key as KnownSignal, value: val });
  }
  return { signals, aux, unknownKeys, malformed };
}

/** A declared `<signal>=yes` while the crawler class it implies is fully blocked. */
export interface ContentSignalContradiction {
  signal: KnownSignal;
  crawlerClass: CrawlerClass;
  blockedTokens: string[];
}

/** Compare the declared "yes" signals against fully-blocked crawler classes.
 * A directive only contradicts blocks its own user-agent scope covers: a
 * Content-Signal under `User-agent: *` (or outside any group) speaks for every
 * crawler, while one under a named group speaks only for those agents. */
export function findContradictions(
  signals: ParsedContentSignal[],
  robotsTxt: RobotsTxtData,
): ContentSignalContradiction[] {
  const blocked = evaluateAiCrawlers(robotsTxt).filter((v) => v.blocked);
  const out: ContentSignalContradiction[] = [];
  const seen = new Set<KnownSignal>();
  for (const directive of signals) {
    const global = directive.userAgents.length === 0 || directive.userAgents.includes("*");
    for (const s of directive.signals) {
      if (s.value !== "yes" || seen.has(s.key)) continue;
      const cls = SIGNAL_TO_CLASS[s.key];
      const blockedInScope = blocked.filter(
        (b) =>
          b.crawlerClass === cls &&
          (global || directive.userAgents.includes(b.token.toLowerCase())),
      );
      if (blockedInScope.length > 0) {
        seen.add(s.key);
        out.push({ signal: s.key, crawlerClass: cls, blockedTokens: blockedInScope.map((b) => b.token) });
      }
    }
  }
  return out;
}

export const contentSignalsRule: Rule = {
  meta: {
    id: "ax/content-signals",
    name: "Content Signals",
    description:
      "Parses Content-Signal directives in robots.txt (per-purpose AI policy) and flags policy that contradicts the site's own crawler blocks",
    solution:
      "Content-Signal (contentsignals.org) lets robots.txt declare AI policy per purpose — `search`, `ai-input`, `ai-train`, each `yes` or `no` — instead of allow/disallow-ing named bots one at a time. Add a line like `Content-Signal: search=yes, ai-input=yes, ai-train=no` under `User-agent: *`. Keep it consistent with your crawler blocks: don't declare `ai-train=yes` while Disallow-ing GPTBot/ClaudeBot, or `search=yes` while blocking the AI-search indexers — a crawler then has to guess which directive wins. Declaring a signal is optional and never penalizes; only a contradiction warns.",
    category: "ax",
    scope: "site",
    // warning so a fired contradiction/syntax check carries a warning badge;
    // with only info checks the rule never enters the issues list at all.
    severity: "warning",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const robotsTxt = ctx.site?.robotsTxt;
    const content = robotsTxt?.content ?? "";

    const directives = content ? parseContentSignals(content) : [];

    // No Content-Signal anywhere → informational, never a failure.
    if (directives.length === 0) {
      checks.push({
        name: "content-signals",
        status: "info",
        message: "No Content-Signal declared in robots.txt (optional per-purpose AI policy)",
        value: "absent",
      });
      return { checks };
    }

    // Declared policy summary (info).
    const declared = new Map<KnownSignal, "yes" | "no">();
    for (const d of directives) for (const s of d.signals) declared.set(s.key, s.value);
    const policyParts = KNOWN_SIGNALS.filter((k) => declared.has(k)).map(
      (k) => `${k}=${declared.get(k)} (${SIGNAL_DESCRIPTION[k]})`,
    );
    const declaredAux = new Map<string, string>();
    for (const d of directives) for (const a of d.aux) declaredAux.set(a.key, a.value);
    for (const [k, v] of declaredAux) policyParts.push(`${k}=${v}`);
    checks.push({
      name: "content-signals-policy",
      status: "info",
      message:
        policyParts.length > 0
          ? `Content-Signal declares: ${policyParts.join("; ")}`
          : "Content-Signal present but declares no recognized signal",
      value: "present",
      details: {
        signals: Object.fromEntries(declared),
        scopedUserAgents: [...new Set(directives.flatMap((d) => d.userAgents))],
      },
    });

    // Unknown keys / malformed tokens → syntax warning (still advisory).
    const unknownKeys = [...new Set(directives.flatMap((d) => d.unknownKeys))];
    const malformed = [...new Set(directives.flatMap((d) => d.malformed))];
    if (unknownKeys.length > 0 || malformed.length > 0) {
      const notes: string[] = [];
      if (unknownKeys.length > 0) notes.push(`unknown key(s): ${unknownKeys.join(", ")}`);
      if (malformed.length > 0) notes.push(`malformed token(s): ${malformed.join(", ")}`);
      checks.push({
        name: "content-signals-syntax",
        status: "warn",
        message: `Content-Signal has invalid syntax — ${notes.join("; ")}. Valid form is comma-separated key=value using search/ai-input/ai-train with yes/no.`,
        value: "invalid-syntax",
        items: [...unknownKeys, ...malformed].map((t) => ({ id: t, label: t })),
        details: { unknownKeys, malformed },
      });
    }

    // Contradiction: a signal opts a purpose IN while its crawler class is blocked.
    const contradictions = robotsTxt ? findContradictions(directives, robotsTxt) : [];
    if (contradictions.length > 0) {
      checks.push({
        name: "content-signals-contradiction",
        status: "warn",
        message: contradictions
          .map(
            (c) =>
              `Content-Signal ${c.signal}=yes but robots.txt fully Disallow-s ${c.blockedTokens.join(", ")} — a crawler can't tell which directive wins`,
          )
          .join("; "),
        value: `${contradictions.length} contradiction(s)`,
        items: contradictions.map((c) => ({
          id: c.signal,
          label: `${c.signal}=yes contradicts blocking ${c.blockedTokens.join(", ")}`,
        })),
        details: { contradictions },
      });
    }

    return { checks };
  },
};
