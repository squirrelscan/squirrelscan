// #1557, #1571: which failures `parseHTML` retries and what it falls back to. The parse function is injected (a stub that throws on
// demand, no module mocking), so each path (RangeError that can be cut, RangeError that cannot, any other error, a retry that throws again) is reached
// without relying on the stack size of the machine that runs the tests.

import { describe, expect, test } from "bun:test";

import { parseContainedWith, parseHTML as realParseHTML, parseNotices } from "../src/dom";

const calls: string[] = [];
let behaviour: (html: string, call: number) => void = () => {};

// the stub parses with the real parser (through the module's own door) after `behaviour` has had its chance to throw
const stub = ((html: string, ...rest: unknown[]) => {
  calls.push(String(html));
  behaviour(String(html), calls.length);
  return (realParseHTML as (...a: unknown[]) => unknown)(html, ...rest);
}) as never;
const parseHTML = (html: string) => parseContainedWith(stub, [html] as never);

const BIG = Array.from({ length: 20_005 }, (_, i) => `t${i}`).join(" ");
const PAGE = `<html><body><div class="${BIG}" id="big"></div><p id="after">tail</p></body></html>`;
const stack = () => new RangeError("Maximum call stack size exceeded");
const reset = (fn: (html: string, call: number) => void) => {
  calls.length = 0;
  behaviour = fn;
};

describe("which failures parseHTML retries", () => {
  test("a RangeError on a page with an oversized class is retried once, with the class cut, and noticed", () => {
    reset((_, call) => {
      if (call === 1) throw stack();
    });
    const { document } = parseHTML(PAGE);
    expect(calls.length).toBe(2);
    expect(calls[1]!.length).toBeLessThan(calls[0]!.length);
    expect(document.getElementById("after")?.textContent).toBe("tail");
    expect(parseNotices(document)).toEqual(["a class attribute of 20,005 tokens was cut to the first 20,000 to read the page"]);
  });

  test("a retry that throws again falls back to the empty document, with a notice", () => {
    reset(() => {
      throw stack();
    });
    // the stub throws for the two pages and for nothing else: the last call (the empty document) must not throw, so it passes on its own text
    reset((html) => {
      if (html !== "<html><head></head><body></body></html>") throw stack();
    });
    const { document } = parseHTML(PAGE);
    expect(calls.length).toBe(3); // the page, the cut page, the empty document
    expect(document.documentElement).not.toBeNull();
    expect(document.getElementById("after")).toBeNull();
    expect(parseNotices(document)).toEqual(["the page could not be read (Maximum call stack size exceeded), so it was audited empty"]);
  });

  test("an error that is not a RangeError is not retried: the empty document, with its message", () => {
    reset((html) => {
      if (html !== "<html><head></head><body></body></html>") throw new TypeError("boom");
    });
    const { document } = parseHTML(PAGE);
    expect(calls.length).toBe(2); // the page, then the empty document: no cut page in between
    expect(parseNotices(document)).toEqual(["the page could not be read (boom), so it was audited empty"]);
  });

  test("a RangeError on a page with nothing to cut is not retried", () => {
    reset((html) => {
      if (html !== "<html><head></head><body></body></html>") throw stack();
    });
    const { document } = parseHTML(`<html><body><div class="a b c"></div></body></html>`);
    expect(calls.length).toBe(2);
    expect(parseNotices(document)[0]).toContain("audited empty");
  });

  test("a page that parses the first time is parsed once and carries no notice", () => {
    reset(() => {});
    const { document } = parseHTML(PAGE);
    expect(calls.length).toBe(1);
    expect(parseNotices(document)).toEqual([]);
  });

  test("more than five cut attributes are summed in one last notice", () => {
    reset((_, call) => {
      if (call === 1) throw stack();
    });
    const body = Array.from({ length: 7 }, (_, i) => `<p id="p${i}" class="${BIG}"></p>`).join("");
    const { document } = parseHTML(`<html><body>${body}</body></html>`);
    const notices = parseNotices(document);
    expect(notices.length).toBe(6);
    expect(notices[5]).toBe("2 more class attributes were cut the same way");
  });
});
