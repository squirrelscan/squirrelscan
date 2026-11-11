// `supersededChecks` successors (#1765, #1780, #1783): a check name, `check@locator`, or `check@locator|members`.

import { describe, expect, test } from "bun:test";

import { splitSuccessor, successorListsLocator } from "../src/resolution";

describe("splitSuccessor", () => {
  test("a plain check name", () => {
    expect(splitSuccessor("meta-title-too-short")).toEqual({ check: "meta-title-too-short" });
  });

  test("check@locator, including an empty locator (a whole-check finding)", () => {
    expect(splitSuccessor("ai-crawlers-wildcard-blocked@User-agent: *")).toEqual({
      check: "ai-crawlers-wildcard-blocked",
      locator: "User-agent: *",
    });
    expect(splitSuccessor("robots-txt-disallow@")).toEqual({ check: "robots-txt-disallow", locator: "" });
  });

  test("check@locator|members: the last | starts the members key", () => {
    expect(splitSuccessor("ai-crawlers-wildcard-blocked@User-agent: *|crawlers")).toEqual({
      check: "ai-crawlers-wildcard-blocked",
      locator: "User-agent: *",
      members: "crawlers",
    });
    // Why a locator may not contain a bar: this reads as locator "a", members "b".
    expect(splitSuccessor("chk@a|b")).toEqual({ check: "chk", locator: "a", members: "b" });
  });
});

describe("successorListsLocator", () => {
  test("lists, does not list, and an unreadable list covers (the safe side)", () => {
    expect(successorListsLocator({ crawlers: ["GPTBot"] }, "crawlers", "GPTBot")).toBe(true);
    expect(successorListsLocator({ crawlers: ["GPTBot"] }, "crawlers", "CCBot")).toBe(false);
    expect(successorListsLocator(undefined, "crawlers", "CCBot")).toBe(true);
    expect(successorListsLocator({}, "crawlers", "CCBot")).toBe(true);
  });
});
