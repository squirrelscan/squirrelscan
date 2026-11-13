import { loadKnownRules } from "@squirrelscan/rules";
// pub#695: a contributor's Shopify and Storyblok configurations, kept as regression fixtures. They must keep
// parsing and validating (every `[rule_options]` table and `[[ignore]]` entry names a real rule and a real option),
// so a rule renamed or an option dropped breaks here and not on a customer's site.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { showConfig, validateConfig } from "@/controllers/config";

const DIR = join(import.meta.dir, "../fixtures/stack-configs");

describe("stack configuration fixtures (#695)", () => {
  for (const name of ["shopify", "storyblok", "globals"]) {
    test(`${name}.toml parses and validates`, async () => {
      const result = await validateConfig(join(DIR, `${name}.toml`));
      if (!result.ok)
        throw new Error(`${name}.toml: ${JSON.stringify(result.error)}`);
      expect(result.data.ruleOptionProblems).toEqual([]);
    });
  }

  for (const name of ["shopify", "storyblok"]) {
    test(`every rule ${name}.toml disables is a rule that exists`, () => {
      const shown = showConfig(join(DIR, `${name}.toml`));
      if (!shown.ok)
        throw new Error(`${name}.toml: ${JSON.stringify(shown.error)}`);
      const known = loadKnownRules();
      const disabled = (shown.data.config.rules?.disable ?? []) as string[];
      expect(disabled.length).toBeGreaterThan(0);
      expect(disabled.filter((id) => !known.has(id))).toEqual([]);
    });
  }
});
