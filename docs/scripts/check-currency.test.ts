import { describe, expect, test } from "bun:test";
import { findCurrencyMath } from "./check-currency";

describe("findCurrencyMath", () => {
  test("flags two unescaped amounts on one line", () => {
    expect(findCurrencyMath("| Price | $89/month, or $890/year |")).toHaveLength(1);
  });
  test("accepts escaped amounts", () => {
    expect(findCurrencyMath("| Price | \\$89/month, or \\$890/year |")).toHaveLength(0);
  });
  test("accepts a single amount and code", () => {
    expect(findCurrencyMath("costs $19 a month")).toHaveLength(0);
    expect(findCurrencyMath("`$1 and $2`")).toHaveLength(0);
    expect(findCurrencyMath("```\n$1 and $2\n```")).toHaveLength(0);
  });
});
