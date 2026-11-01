// #1495: what the control shortlist and the rank read from a destination. The shortlist decides which controls fit in
// the 60,000 the scan prepares; the rank decides reading order. Both judge the destination the way a URL parser reads it.

import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { rank, shortlist, urlText } from "../src/integrity/controls";
import { OFF, finished, fired, foundOrNoted, run, url } from "./integrity-budget-fixture";

const links = (hrefs: string[]) => {
  const doc = parsePage(`<html><body>${hrefs.map((h) => `<a href="${h}">x</a>`).join("")}</body></html>`, url).document!;
  return Array.from(doc.querySelectorAll("a"));
};
const order = (hrefs: string[]): string[] => {
  const found = links(hrefs);
  return shortlist(found, () => null, () => false).chosen.map((c) => c.href);
};

test("the shortlist puts sign-in paths ahead of other off-site links, judged on the normalised text", () => {
  const decoy = "https://p.invalid/x";
  // a sign-in path split by a tab (the parser removes it), one far past 300 characters, one at the edge of the read
  expect(order([decoy, "https://p.invalid/sign\tin"])[0]).toBe("https://p.invalid/sign\tin");
  expect(order([decoy, `https://p.invalid/${"a".repeat(1_000)}/signin`])[0]).toContain("signin");
  expect(order([decoy, `https://p.invalid/${"a".repeat(8_000)}/signin`])[0]).toContain("signin");
  // past the 8,192 characters read, a path is not promoted: that is the bound
  expect(order([decoy, `https://p.invalid/${"a".repeat(9_000)}/signin`])[0]).toBe(decoy);
});

test("off-site links are NOT promoted in the shortlist: decoys cannot crowd out a control (#1495 blocker)", () => {
  // no sign-in path, no cue: document order among the second tier, whatever the host looks like
  const hrefs = ["https://a.invalid/x", "//b.invalid/x", "\\\\c.invalid/x", "http:d.invalid/x", "https://e.invalid/x"];
  expect(order(hrefs)).toEqual(hrefs);
  // and a sign-in path is ahead of all of them
  expect(order([...hrefs, "https://f.invalid/login"])[0]).toBe("https://f.invalid/login");
});

test("rank: off-site and sign-in destinations read first, on the normalised text, with a bounded sign-in read", () => {
  const r = (href: string, tag = "a") => rank(tag, urlText(href), []);
  expect(r("/plain")).toBe(1);
  expect(r("/sign-in")).toBe(2);
  expect(r("/sig\tn-in")).toBe(2);
  expect(r("/lo\ngin")).toBe(2);
  expect(r(`/${"a".repeat(1_000)}signin`)).toBe(2);
  expect(r(`/${"a".repeat(8_000)}signin`)).toBe(2);
  expect(r(`/${"a".repeat(9_000)}signin`)).toBe(1);
  expect(r("//host/x")).toBe(2);
  expect(r("/\thost/x")).toBe(1);
  expect(r("/\t/host/x")).toBe(2);
  expect(r("\\\\host/x")).toBe(2);
  expect(r("http:host")).toBe(2);
  expect(r("/plain", "button")).toBe(2);
  expect(rank("a", null, [])).toBe(0);
});

test("60,500 off-site decoys before a real button or sign-in link: finished, found", async () => {
  const decoys = '<a href="https://p.invalid/x" title="t">x</a>'.repeat(60_500);
  for (const real of [
    `<form method="post" action="${OFF}"><button>Sign in with Google</button></form>`,
    '<a href="https://credential-fixture.invalid/oauth/authorize">Sign in with Google</a>',
    '<a href="https://credential-fixture.invalid/sign\tin">Sign in with Google</a>',
    `<a href="//credential-fixture.invalid/${"a".repeat(1_000)}/signin">Sign in with Google</a>`,
  ]) {
    const { checks } = await run(`${decoys}${real}`);
    expect(finished(checks)).toBe(true);
    expect(fired(checks, "brand-impersonation"), real.slice(0, 60)).toBe(true);
  }
}, 240_000);

test("a page of off-site links with a long padded query stays quick and is still read", async () => {
  const tabs = "\t".repeat(1_000_000);
  const { ms, checks } = await run(`<a href="https://credential-fixture.invalid/${tabs}signin">Sign in with Google</a>`);
  expect(foundOrNoted(checks, "brand-impersonation")).toBe(true);
  expect(ms).toBeLessThan(5_000);
}, 60_000);
