// images/aspect-mismatch - Declared image aspect ratio conflicts with its CSS box

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  tolerance: z
    .number()
    .default(0.05)
    .describe("Allowed fractional difference between the two aspect ratios"),
});

// object-fit values that reshape the image so a box/ratio mismatch does not distort it.
const NON_DISTORTING_FIT = new Set(["cover", "contain", "scale-down", "none"]);

// Class-based object-fit (Tailwind / utility CSS) — we can't read external CSS, so a
// utility class is our only signal that a class sets a non-distorting object-fit.
const NON_DISTORTING_FIT_CLASS = /\bobject-(cover|contain|scale-down|none)\b/;

function parseIntAttr(value: string | null): number {
  if (!value || !/^\d+$/.test(value.trim())) return Number.NaN;
  return Number.parseInt(value, 10);
}

function parseCssPx(value: string | undefined): number {
  if (!value) return Number.NaN;
  const m = value.trim().match(/^([\d.]+)px$/);
  return m ? Number.parseFloat(m[1] as string) : Number.NaN;
}

// aspect-ratio: "4 / 3" | "1.5"
function parseAspectRatio(value: string | undefined): number {
  if (!value) return Number.NaN;
  const frac = value.trim().match(/^([\d.]+)\s*\/\s*([\d.]+)$/);
  if (frac) {
    const w = Number.parseFloat(frac[1] as string);
    const h = Number.parseFloat(frac[2] as string);
    return h > 0 ? w / h : Number.NaN;
  }
  const single = value.trim().match(/^([\d.]+)$/);
  return single ? Number.parseFloat(single[1] as string) : Number.NaN;
}

function parseStyle(style: string): Map<string, string> {
  const decls = new Map<string, string>();
  for (const part of style.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const val = part
      .slice(idx + 1)
      .trim()
      .toLowerCase();
    if (prop) decls.set(prop, val);
  }
  return decls;
}

// The CSS-declared aspect ratio, if the inline style fixes one explicitly:
// either via `aspect-ratio`, or via both width AND height in px. null otherwise.
function cssAspectRatio(decls: Map<string, string>): number | null {
  const ar = parseAspectRatio(decls.get("aspect-ratio"));
  if (!Number.isNaN(ar) && ar > 0) return ar;
  const w = parseCssPx(decls.get("width"));
  const h = parseCssPx(decls.get("height"));
  if (!Number.isNaN(w) && !Number.isNaN(h) && w > 0 && h > 0) return w / h;
  return null;
}

export const aspectMismatchRule: Rule = {
  meta: {
    id: "images/aspect-mismatch",
    name: "Image Aspect Ratio Mismatch",
    description:
      "Flags images whose width/height attributes declare a different aspect ratio than their CSS box",
    solution:
      "When an image's width/height attributes describe one aspect ratio but CSS forces a different one (via an explicit width+height in px, or an aspect-ratio property), the image is stretched or squished. Fix the mismatch: set width/height attributes to the image's true aspect ratio, and let CSS size it with `height: auto` (or match the ratio). If cropping is intended, add `object-fit: cover` so the image fills the box without distortion.",
    category: "images",
    scope: "page",
    severity: "warning",
    weight: 4,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const mismatched: CheckResult["items"] = [];

    for (const img of doc.querySelectorAll("img[style]")) {
      const w = parseIntAttr(img.getAttribute("width"));
      const h = parseIntAttr(img.getAttribute("height"));
      if (Number.isNaN(w) || Number.isNaN(h) || w === 0 || h === 0) continue;
      const attrRatio = w / h;

      const decls = parseStyle(img.getAttribute("style") || "");
      // object-fit cover/contain reshapes the image → no distortion, skip.
      if (NON_DISTORTING_FIT.has(decls.get("object-fit") ?? "")) continue;
      if (NON_DISTORTING_FIT_CLASS.test((img.getAttribute("class") || "").toLowerCase())) {
        continue;
      }

      const cssRatio = cssAspectRatio(decls);
      if (cssRatio === null) continue;

      if (Math.abs(attrRatio - cssRatio) / attrRatio > opts.tolerance) {
        const src = img.getAttribute("src") || "(inline)";
        mismatched?.push({
          id: src,
          label: `${src} (${w}x${h} attr vs ${cssRatio.toFixed(2)}:1 CSS)`,
          snippet: `<img src="${src}" width="${w}" height="${h}" style="${img.getAttribute("style")}">`,
        });
      }
    }

    if (mismatched && mismatched.length > 0) {
      checks.push({
        name: "aspect-mismatch",
        status: "warn",
        message: `${mismatched.length} image(s) with conflicting attribute vs CSS aspect ratio (distortion risk)`,
        items: mismatched.slice(0, 10),
        details: mismatched.length > 10 ? { additional: mismatched.length - 10 } : undefined,
      });
    } else {
      checks.push({
        name: "aspect-mismatch",
        status: "pass",
        message: "No conflicting image aspect ratios detected",
      });
    }

    return { checks };
  },
};
