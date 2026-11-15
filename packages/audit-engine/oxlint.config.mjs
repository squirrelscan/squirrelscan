import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

import { disabledCoreRules } from "../../oxlint.disabled-core-rules.mjs";

// Rules switched off here are the baseline of violations that predate lint
// coverage for this package (#45). Fix a rule's violations, then delete its
// line so it cannot regress.
const baselineDisabled = {
  "unicorn/relative-url-style": "off",
  "eslint/no-inner-declarations": "off",
  "eslint/no-loop-func": "off",
  "eslint/no-template-curly-in-string": "off",
  "eslint/no-unsafe-optional-chaining": "off",
  "eslint/no-useless-concat": "off",
  "eslint/operator-assignment": "off",
  "eslint/prefer-object-has-own": "off",
  "github/array-foreach": "off",
  "github/get-attribute": "off",
  "import/no-mutable-exports": "off",
  "jsdoc/empty-tags": "off",
  "jsdoc/require-yields": "off",
  "promise/no-return-wrap": "off",
  "sonarjs/array-constructor": "off",
  "sonarjs/hashing": "off",
  "sonarjs/misplaced-loop-counter": "off",
  "sonarjs/no-function-declaration-in-block": "off",
  "sonarjs/no-nested-assignment": "off",
  "sonarjs/no-unused-collection": "off",
  "sonarjs/no-unused-function-argument": "off",
  "sonarjs/publicly-writable-directories": "off",
  "typescript/no-invalid-void-type": "off",
  "unicorn/no-array-for-each": "off",
  "unicorn/no-new-array": "off",
  "unicorn/no-unreadable-array-destructuring": "off",
  "unicorn/no-useless-fallback-in-spread": "off",
  "unicorn/no-useless-promise-resolve-reject": "off",
  "unicorn/no-useless-spread": "off",
  "unicorn/prefer-math-trunc": "off",
  "unicorn/prefer-structured-clone": "off",
  "unicorn/require-array-join-separator": "off",
};

export default defineConfig({
  extends: [core],
  rules: { ...disabledCoreRules, ...baselineDisabled },
});
