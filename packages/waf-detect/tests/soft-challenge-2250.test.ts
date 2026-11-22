import { describe, expect, test } from "bun:test";

import { detectSoftChallengeEntry } from "../src/soft-challenge";

describe("detectSoftChallengeEntry (#2250)", () => {
  test("flags a tiny 2xx page with no doctype or html element", () => {
    expect(detectSoftChallengeEntry(200, `<div id="r"></div>`).detected).toBe(
      true
    );
  });
  test("flags generic challenge wording on a tiny page", () => {
    const html = `<!doctype html><html><body><p>Checking your browser</p></body></html>`;
    expect(detectSoftChallengeEntry(200, html).detected).toBe(true);
  });
  test("does not flag a valid minimal page", () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head><body><h1>Hi</h1></body></html>`;
    expect(detectSoftChallengeEntry(200, html).detected).toBe(false);
  });
  test("does not flag a non-2xx status or an empty body", () => {
    expect(detectSoftChallengeEntry(404, `<div></div>`).detected).toBe(false);
    expect(detectSoftChallengeEntry(200, "").detected).toBe(false);
  });
  test("does not flag a long page that quotes challenge wording", () => {
    const html = `<!doctype html><html><body><p>Just a moment</p>${"<p>Real article text goes here.</p>".repeat(60)}</body></html>`;
    expect(detectSoftChallengeEntry(200, html).detected).toBe(false);
  });
});
