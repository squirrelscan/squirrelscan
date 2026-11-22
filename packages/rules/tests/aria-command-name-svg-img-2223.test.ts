// pub#2223: a link named by a child svg role=img is named (accname 2F).

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { ParsedPage, RuleContext } from "../src/types";

import { ariaCommandNameRule } from "../src/a11y/aria-command-name";

async function status(body: string): Promise<string | undefined> {
  const url = "https://example.com/";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title></head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  const checks = (await ariaCommandNameRule.run(ctx)).checks as CheckResult[];
  return checks[0]?.status;
}

describe("a11y/aria-command-name svg role=img (pub#2223)", () => {
  test("aria-label passes", async () => {
    expect(
      await status('<a href="/"><svg role="img" aria-label="X"><g/></svg></a>')
    ).toBe("pass");
  });
  test("aria-labelledby passes", async () => {
    expect(
      await status(
        '<span id="n">X</span><a href="/"><svg role="img" aria-labelledby="n"><g/></svg></a>'
      )
    ).toBe("pass");
  });
  test("svg title passes", async () => {
    expect(
      await status('<a href="/"><svg role="img"><title>X</title><g/></svg></a>')
    ).toBe("pass");
  });
  test("unnamed svg still fails", async () => {
    expect(await status('<a href="/"><svg><g/></svg></a>')).toBe("fail");
    expect(await status('<a href="/"><svg role="img"><g/></svg></a>')).toBe(
      "fail"
    );
  });
  test("aria-hidden named svg does not name the link", async () => {
    expect(
      await status(
        '<a href="/"><svg role="img" aria-hidden="true" aria-label="X"><g/></svg></a>'
      )
    ).toBe("fail");
  });
});
