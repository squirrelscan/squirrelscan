// perf/framework-data-payload - A static page that ships a large framework data payload
// (squirrelscan/squirrelscan#1143)

import { z } from "zod";

import {
  findFrameworkPayloads,
  measureInteractivity,
  visibleTextLength,
} from "../shared/framework-payload";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

function formatKb(chars: number): string {
  return `${(chars / 1024).toFixed(chars >= 10 * 1024 ? 0 : 1)} KB`;
}

export const optionsSchema = z.object({
  min_bytes: z
    .number()
    .default(100 * 1024)
    .describe("Combined size in characters of the page's framework data payloads that is worth reporting"),
  min_text_ratio: z
    .number()
    .default(20)
    .describe("The payload must be at least this many times the page's visible text, so a page that is mostly data is not reported"),
  max_interactive: z
    .number()
    .default(5)
    .describe("Form controls plus embedded media a page may have and still count as static"),
  max_buttons: z
    .number()
    .default(50)
    .describe("Buttons a page may have and still count as static (navigation menus alone can add dozens)"),
});

export const frameworkDataPayloadRule: Rule = {
  meta: {
    id: "perf/framework-data-payload",
    name: "Large Framework Data Payload on a Static Page",
    description:
      "Flags a page that is mostly text but carries a large inline framework data payload (__NEXT_DATA__, the Next.js app router flight data, __NUXT__, Remix, Qwik, SvelteKit or Astro island state)",
    solution:
      "A hydrating framework serialises the data its components were rendered from into the HTML so the browser can re-render them. On a page with no interactive parts that data is the page's content shipped a second time, as markup and as JSON. Render the page without hydrating it: in Next.js keep it a server component and avoid passing large props to client components; in Astro leave out the client: directive; in Nuxt use server-only components or routeRules prerendering without payload extraction; in SvelteKit set export const csr = false on the route. Where the data has to stay, trim what is passed to the client to the fields the interactive part reads.",
    category: "perf",
    scope: "page",
    verdictScope: "page",
    severity: "info",
    weight: 2,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const opts = optionsSchema.parse(ctx.options);

    const payloads = findFrameworkPayloads(doc);
    const total = payloads.reduce((sum, p) => sum + p.bytes, 0);
    const checks: CheckResult[] = [];

    const pass = (message: string): RuleResult => {
      checks.push({ name: "framework-data-payload", status: "pass", message });
      return { checks };
    };

    if (total === 0) return pass("No framework data payload in the page");
    if (total < opts.min_bytes) {
      return pass(`Framework data payload is ${formatKb(total)}, under the ${formatKb(opts.min_bytes)} threshold`);
    }

    const text = visibleTextLength(doc);
    const ratio = text > 0 ? total / text : Number.POSITIVE_INFINITY;
    if (ratio < opts.min_text_ratio) {
      return pass(`Framework data payload is ${formatKb(total)} against ${formatKb(text)} of text: the page is mostly data`);
    }

    const interactivity = measureInteractivity(doc);
    if (
      interactivity.fields + interactivity.embedded > opts.max_interactive ||
      interactivity.buttons > opts.max_buttons
    ) {
      return pass("The page has interactive parts, so its framework data payload is not flagged");
    }

    const largest = payloads[0]!;
    checks.push({
      name: "framework-data-payload",
      status: "info",
      message: `${formatKb(total)} of framework data (${largest.label}) on a page with ${formatKb(text)} of text`,
      value: total,
      items: payloads.map((p) => ({
        id: p.label,
        meta: { kind: p.kind, size: formatKb(p.bytes), characters: p.bytes, elements: p.count },
      })),
      details: {
        payloadCharacters: total,
        textCharacters: text,
        ratio: Number.isFinite(ratio) ? Math.round(ratio) : null,
        formFields: interactivity.fields,
        embeddedMedia: interactivity.embedded,
        buttons: interactivity.buttons,
        suggestion:
          "Render this page without hydrating it, or pass the client only the fields the interactive part reads",
      },
    });
    return { checks };
  },
};
