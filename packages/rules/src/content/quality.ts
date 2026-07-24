// content/quality - LLM-based content quality analysis

import { z } from "zod";
import { stripHtmlForText } from "@squirrelscan/utils";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { isLLMAvailable, llmCallWithSystem } from "../tools";

const QualitySchema = z.object({
  score: z.number().min(0).max(100),
  feedback: z.string(),
});

const BASIC_ENTITIES = new Map([
  ["&nbsp;", " "],
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
]);

// Extract clean text from HTML for LLM analysis. Decode each source entity at
// most once so text such as &amp;lt; cannot turn into markup in a later pass.
export function extractTextFromHtml(html: string): string {
  const visible = stripHtmlForText(html, {
    exclude: ["script", "style", "nav", "footer", "header"],
  });
  const output: string[] = [];
  let pendingSpace = false;

  for (let i = 0; i < visible.length; i++) {
    let char = visible[i];
    if (char === "&") {
      for (const [entity, decoded] of BASIC_ENTITIES) {
        if (visible.startsWith(entity, i)) {
          char = decoded;
          i += entity.length - 1;
          break;
        }
      }
    }

    if (char.trim() === "") {
      pendingSpace = output.length > 0;
    } else {
      if (pendingSpace) output.push(" ");
      output.push(char);
      pendingSpace = false;
    }
  }

  return output.join("");
}

export const contentQualityRule: Rule = {
  meta: {
    id: "content/quality",
    name: "Content Quality",
    description: "LLM-based content quality analysis for SEO",
    solution:
      "Content quality affects both user engagement and search rankings. High-quality content is clear, well-structured, informative, and free of errors. Review flagged pages for clarity and depth. Ensure content provides genuine value to readers. Check for grammar and spelling errors. Break up long paragraphs, use subheadings, and include relevant examples. Consider whether the content fully answers user questions.",
    category: "content",
    scope: "page",
    severity: "info",
    weight: 3,
    disabled: true,
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];

    // Skip if LLM not available
    if (!isLLMAvailable()) {
      checks.push({
        name: "content-quality",
        status: "skipped",
        message: "Content quality analysis skipped",
        skipReason: "OPENROUTER_API_KEY not set",
      });
      return { checks };
    }

    const content = extractTextFromHtml(ctx.page.html).slice(0, 3000);
    if (!content.trim()) {
      checks.push({
        name: "content-quality",
        status: "skipped",
        message: "No content to analyze",
        skipReason: "Page has no text content",
      });
      return { checks };
    }

    const systemPrompt = `You are an SEO content quality analyst. Evaluate web page content for SEO quality.
Score from 0-100 based on:
- Clarity and readability
- Depth of information
- Structure and organization
- Engagement and value to readers
- Grammar and spelling
- Originality and uniqueness

Respond with a JSON object containing score (0-100) and feedback (2-3 sentences).`;

    const userPrompt = `Evaluate this web page content for SEO quality (URL: ${ctx.page.url}):

${content}`;

    const result = await llmCallWithSystem(systemPrompt, userPrompt, QualitySchema);

    if (!result.success) {
      checks.push({
        name: "content-quality",
        status: "fail",
        message: `LLM analysis failed: ${result.error}`,
      });
      return { checks };
    }

    const { score, feedback } = result.data;
    let status: CheckResult["status"] = "pass";
    let message: string;

    if (score >= 70) {
      status = "pass";
      message = `Content quality score: ${score}/100`;
    } else if (score >= 40) {
      status = "warn";
      message = `Content quality needs improvement: ${score}/100`;
    } else {
      status = "fail";
      message = `Poor content quality: ${score}/100`;
    }

    checks.push({
      name: "content-quality",
      status,
      message,
      value: feedback.slice(0, 200),
    });

    return { checks };
  },
};
