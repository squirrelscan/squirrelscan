#!/usr/bin/env bun
/**
 * Currency-as-math guard (#2204). The docs renderer treats `$...$` as inline LaTeX,
 * so a line with two unescaped `$<digit>` amounts (`$89/month, or $890/year`)
 * renders as garbled math. Escape each amount as `\$89`. Fenced code and inline
 * code spans are skipped: math is not parsed there.
 */
import { Glob } from "bun";
import { join } from "node:path";

export interface CurrencyIssue {
  line: number;
  text: string;
}

export function findCurrencyMath(source: string): CurrencyIssue[] {
  const issues: CurrencyIssue[] = [];
  let fence: string | null = null;
  source.split("\n").forEach((raw, i) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const text = raw.replace(/`[^`]*`/g, "").replace(/\\\$/g, "");
    if ((text.match(/\$\d/g) ?? []).length >= 2) issues.push({ line: i + 1, text: raw.trim() });
  });
  return issues;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  let failed = 0;
  for (const file of new Glob("**/*.{mdx,md}").scanSync({ cwd: root })) {
    if (file.startsWith("node_modules/") || file.startsWith("dist/")) continue;
    for (const issue of findCurrencyMath(await Bun.file(join(root, file)).text())) {
      console.error(`${file}:${issue.line}: unescaped currency amounts render as math, write \\$ : ${issue.text}`);
      failed++;
    }
  }
  if (failed > 0) process.exit(1);
  console.log("check-currency: ok");
}
