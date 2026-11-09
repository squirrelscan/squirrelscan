// a11y/label-content-name-mismatch: symbol-only visible text and controls that are not rendered (#1645).
//
// `<button aria-label="Schließen">✕</button>` has no visible label a user would speak, so the
// name is not compared with it. A control inside a display:none, hidden or closed dialog
// ancestor is out of the accessibility tree and skipped. Real visible text with an unrelated
// aria-label still fails.

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import { labelContentNameMismatchRule } from "../src/a11y/label-content-name-mismatch";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string, head = ""): CheckResult[] {
  const html = `<!doctype html><html lang="de"><head><title>t</title>${head}</head><body><main>${body}</main></body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = labelContentNameMismatchRule.run(ctx);
  if (result instanceof Promise) throw new Error("label-content-name-mismatch is async");
  return result.checks;
}

const failing = (checks: CheckResult[]) => checks.find((c) => c.status === "fail");

describe("symbol-only visible text is not a label (#1645)", () => {
  for (const glyph of ["✕", "×", "✖", "☰", "›", "🛒", "...", "x​".slice(1)]) {
    test(`${JSON.stringify(glyph)} against a descriptive aria-label passes`, () => {
      const checks = run(`<button aria-label="Schließen">${glyph}</button>`);
      expect(failing(checks)).toBeUndefined();
    });
  }

  test("a glyph beside real text still compares the whole visible text", () => {
    const checks = run('<button aria-label="Gutschein kopieren">✕ HORROR15</button>');
    expect(failing(checks)?.items?.length).toBe(1);
  });

  test("a digit is not a symbol", () => {
    const checks = run('<button aria-label="Warenkorb">3</button>');
    expect(failing(checks)?.items?.length).toBe(1);
  });

  test("positive control: real visible text with an unrelated aria-label fails", () => {
    const checks = run('<button aria-label="Gutschein kopieren">HORROR15</button>');
    const fail = failing(checks);
    expect(fail?.message).toBe("1 element(s) where visible text doesn't match accessible name");
    expect(fail?.items?.[0]?.id).toBe('button: visible="horror15" vs aria-label="gutschein kopieren"');
  });

  test("a page with only a glyph control passes", () => {
    const checks = run('<button aria-label="Schließen">✕</button>');
    expect(checks.map((c) => c.status)).toEqual(["pass"]);
  });
});

describe("controls that are not rendered are skipped (#1645)", () => {
  const mismatch = '<button aria-label="Gutschein kopieren">HORROR15</button>';

  test("under a display:none ancestor", () => {
    const checks = run(`<div style="display:none">${mismatch}</div>`);
    expect(failing(checks)).toBeUndefined();
    expect(checks.map((c) => c.status)).toEqual(["pass"]);
  });

  test("under a hidden ancestor", () => {
    expect(failing(run(`<div hidden>${mismatch}</div>`))).toBeUndefined();
  });

  test("inside a closed dialog", () => {
    expect(failing(run(`<dialog>${mismatch}</dialog>`))).toBeUndefined();
  });

  test("the glyph button in a display:none ancestor passes too", () => {
    const checks = run('<div style="display:none"><button aria-label="Schließen">✕</button></div>');
    expect(failing(checks)).toBeUndefined();
  });

  test("a shown mismatch beside a hidden one still fails once", () => {
    const checks = run(`<div hidden>${mismatch}</div>${mismatch}`);
    expect(failing(checks)?.items?.length).toBe(1);
  });

  test("a control a style may hide but squirrel cannot settle is unconfirmed, not a failure", () => {
    const checks = run(
      `<div class="promo">${mismatch}</div>`,
      "<style>.promo:hover{display:none}</style>"
    );
    expect(failing(checks)).toBeUndefined();
    const row = checks.find((c) => c.name === "label-content-name-mismatch-unconfirmed");
    expect(row?.status).toBe("warn");
    expect(row?.items?.length).toBe(1);
  });
});
