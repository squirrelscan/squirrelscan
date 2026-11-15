import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";

// Rules switched off here are the baseline of violations that predate lint
// coverage for this package (#45). Fix a rule's violations, then delete its
// line so it cannot regress.
const baselineDisabled = {
  "eslint/sort-vars": "off",
  "eslint/no-control-regex": "off",
  "eslint/no-empty-character-class": "off",
  "eslint/no-lonely-if": "off",
  "eslint/no-loop-func": "off",
  "eslint/no-misleading-character-class": "off",
  "eslint/no-template-curly-in-string": "off",
  "eslint/no-unmodified-loop-condition": "off",
  "eslint/no-unsafe-optional-chaining": "off",
  "eslint/no-useless-concat": "off",
  "eslint/no-useless-escape": "off",
  "eslint/prefer-object-has-own": "off",
  "eslint/prefer-regex-literals": "off",
  "eslint/preserve-caught-error": "off",
  "github/array-foreach": "off",
  "github/get-attribute": "off",
  "github/no-inner-html": "off",
  "oxc/no-accumulating-spread": "off",
  "sonarjs/array-constructor": "off",
  "sonarjs/fixme-tag": "off",
  "sonarjs/misplaced-loop-counter": "off",
  "sonarjs/no-built-in-override": "off",
  "sonarjs/no-duplicated-branches": "off",
  "sonarjs/no-empty-collection": "off",
  "sonarjs/no-gratuitous-expressions": "off",
  "sonarjs/no-hardcoded-passwords": "off",
  "sonarjs/no-hardcoded-secrets": "off",
  "sonarjs/no-inverted-boolean-check": "off",
  "sonarjs/no-nested-assignment": "off",
  "sonarjs/no-unused-function-argument": "off",
  "sonarjs/updated-loop-counter": "off",
  "sonarjs/variable-name": "off",
  "typescript/no-non-null-asserted-optional-chain": "off",
  "unicorn/no-array-for-each": "off",
  "unicorn/no-new-array": "off",
  "unicorn/no-object-as-default-parameter": "off",
  "unicorn/no-useless-fallback-in-spread": "off",
  "unicorn/no-useless-length-check": "off",
  "unicorn/no-useless-promise-resolve-reject": "off",
  "unicorn/no-useless-spread": "off",
  "unicorn/prefer-dom-node-dataset": "off",
  "unicorn/prefer-includes": "off",
  "unicorn/prefer-math-trunc": "off",
  "unicorn/prefer-modern-math-apis": "off",
  "unicorn/prefer-regexp-test": "off",
  "unicorn/prefer-structured-clone": "off",
  "unicorn/require-array-join-separator": "off",
};

export default defineConfig({
  extends: [core],
  rules: { ...disabledCoreRules, ...baselineDisabled },
});
