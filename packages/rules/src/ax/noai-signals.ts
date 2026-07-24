// ax/noai-signals - report declared noai / noimageai opt-outs and the
// nosnippet / max-snippet:0 directives that gate AI-search quoting. Purely
// informational: it says what a page declares and never penalizes.

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

interface AiOptOutFlags {
  noai: boolean;
  noimageai: boolean;
  nosnippet: boolean;
  maxSnippet0: boolean;
}

const EMPTY_FLAGS: AiOptOutFlags = {
  noai: false,
  noimageai: false,
  nosnippet: false,
  maxSnippet0: false,
};

/** Detect the AI opt-out / snippet-limit tokens in one robots-directive string. */
export function detectAiOptOuts(text: string | null | undefined): AiOptOutFlags {
  if (!text) return { ...EMPTY_FLAGS };
  const t = text.toLowerCase();
  return {
    // \bnoai\b never matches inside "noimageai" (preceded by "noimage").
    noai: /\bnoai\b/.test(t),
    noimageai: /\bnoimageai\b/.test(t),
    nosnippet: /\bnosnippet\b/.test(t),
    maxSnippet0: /\bmax-snippet\s*:\s*0\b/.test(t),
  };
}

/** Robots-directive sources on a page: the X-Robots-Tag header + robots/ai meta names. */
const META_NAMES = new Set(["robots", "ai", "googlebot", "bingbot"]);

interface DirectiveSource {
  origin: string;
  flags: AiOptOutFlags;
}

function collectSources(ctx: RuleContext): DirectiveSource[] {
  const sources: DirectiveSource[] = [];

  const header = ctx.page.headers["x-robots-tag"];
  if (header) sources.push({ origin: "X-Robots-Tag header", flags: detectAiOptOuts(header) });

  const doc = ctx.parsed.document;
  if (doc) {
    for (const meta of doc.querySelectorAll("meta[name]")) {
      const name = meta.getAttribute("name")?.trim().toLowerCase();
      if (!name || !META_NAMES.has(name)) continue;
      sources.push({
        origin: `<meta name="${name}">`,
        flags: detectAiOptOuts(meta.getAttribute("content")),
      });
    }
  } else if (ctx.parsed.meta.robots) {
    // No DOM (error page / stored parse) — fall back to the extracted robots meta.
    sources.push({ origin: '<meta name="robots">', flags: detectAiOptOuts(ctx.parsed.meta.robots) });
  }

  return sources.filter((s) => Object.values(s.flags).some(Boolean));
}

function anyFlag(sources: DirectiveSource[], key: keyof AiOptOutFlags): boolean {
  return sources.some((s) => s.flags[key]);
}

export const noaiSignalsRule: Rule = {
  meta: {
    id: "ax/noai-signals",
    name: "noai Signals",
    description:
      "Reports declared noai / noimageai opt-outs and nosnippet / max-snippet:0 directives that limit AI-search quoting — informational only",
    solution:
      "noai and noimageai are an informal convention some AI companies said they'd honor for text and image use; nosnippet and max-snippet:0 are long-standing snippet-control directives that AI-search answer engines treat as 'don't quote this page verbatim.' To keep a page out of AI answers and snippets, declare it explicitly, e.g. `<meta name=\"robots\" content=\"noai, noimageai, nosnippet\">` or the same via an X-Robots-Tag header. Remember noai/noimageai are advisory with no enforcement — use robots.txt crawler blocks (see ax/ai-crawlers) as the enforcement layer and these tags as the declared-intent layer on top.",
    category: "ax",
    scope: "page",
    severity: "info",
    weight: 1,
  },

  run(ctx: RuleContext): RuleResult {
    const sources = collectSources(ctx);

    // No opt-out signals → pass quietly (one terse check, not per-signal noise).
    if (sources.length === 0) {
      return {
        checks: [
          {
            name: "noai-signals",
            status: "pass",
            message: "No noai / noimageai / snippet-limit signals declared",
            value: "none",
          },
        ],
      };
    }

    const noai = anyFlag(sources, "noai");
    const noimageai = anyFlag(sources, "noimageai");
    const nosnippet = anyFlag(sources, "nosnippet");
    const maxSnippet0 = anyFlag(sources, "maxSnippet0");

    const declared: string[] = [];
    if (noai) declared.push("noai (advisory opt-out from AI text use)");
    if (noimageai) declared.push("noimageai (advisory opt-out from AI image use)");
    if (nosnippet) declared.push("nosnippet (limits AI-search quoting)");
    if (maxSnippet0) declared.push("max-snippet:0 (limits AI-search quoting)");

    const advisory = noai || noimageai;
    const caveat = advisory
      ? " noai/noimageai are advisory only — honoring them is up to each crawler, with no enforcement behind the tag."
      : "";

    const checks: CheckResult[] = [
      {
        name: "noai-signals",
        status: "info",
        message: `Declares AI opt-out signals: ${declared.join(", ")}.${caveat}`,
        value: declared.length === 1 ? "1 signal" : `${declared.length} signals`,
        items: sources.flatMap((s) =>
          (Object.keys(s.flags) as (keyof AiOptOutFlags)[])
            .filter((k) => s.flags[k])
            .map((k) => ({ id: `${s.origin}:${k}`, label: `${k} in ${s.origin}` })),
        ),
        details: { noai, noimageai, nosnippet, maxSnippet0, sources: sources.map((s) => s.origin) },
      },
    ];

    return { checks };
  },
};
