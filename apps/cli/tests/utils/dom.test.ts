import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  getAttrCI,
  hasAttrCI,
  querySelectorAllByAttrCI,
  querySelectorByAttrValueCI,
} from "../../src/utils/dom";

function doc(html: string) {
  return parseHTML(html).document;
}

describe("getAttrCI", () => {
  test("returns value for lowercase attribute", () => {
    const d = doc('<meta charset="utf-8">');
    const el = d.querySelector("meta")!;
    expect(getAttrCI(el, "charset")).toBe("utf-8");
  });

  test("returns value for camelCase attribute (React SSR)", () => {
    const d = doc('<meta charSet="utf-8"/>');
    const el = d.querySelector("meta")!;
    expect(getAttrCI(el, "charset")).toBe("utf-8");
  });

  test("returns null when attribute missing", () => {
    const d = doc('<meta name="test">');
    const el = d.querySelector("meta")!;
    expect(getAttrCI(el, "charset")).toBeNull();
  });

  test("handles tabIndex camelCase", () => {
    const d = doc('<div tabIndex="5"></div>');
    const el = d.querySelector("div")!;
    expect(getAttrCI(el, "tabindex")).toBe("5");
  });

  test("handles colSpan camelCase", () => {
    const d = doc('<td colSpan="2"></td>');
    const el = d.querySelector("td")!;
    expect(getAttrCI(el, "colspan")).toBe("2");
  });

  test("handles fully uppercase TABINDEX", () => {
    const d = doc('<div TABINDEX="0"></div>');
    const el = d.querySelector("div")!;
    expect(getAttrCI(el, "tabindex")).toBe("0");
  });
});

describe("hasAttrCI", () => {
  test("true for lowercase", () => {
    const d = doc('<script nomodule src="x.js"></script>');
    const el = d.querySelector("script")!;
    expect(hasAttrCI(el, "nomodule")).toBe(true);
  });

  test("true for camelCase (React SSR)", () => {
    const d = doc('<script noModule src="x.js"></script>');
    const el = d.querySelector("script")!;
    expect(hasAttrCI(el, "nomodule")).toBe(true);
  });

  test("false when missing", () => {
    const d = doc('<script src="x.js"></script>');
    const el = d.querySelector("script")!;
    expect(hasAttrCI(el, "nomodule")).toBe(false);
  });
});

describe("querySelectorAllByAttrCI", () => {
  test("finds elements with camelCase tabIndex", () => {
    const d = doc('<div tabIndex="0"></div><span tabindex="-1"></span><p></p>');
    const results = querySelectorAllByAttrCI(d, "*", "tabindex");
    expect(results).toHaveLength(2);
  });

  test("scoped to tag", () => {
    const d = doc('<div tabIndex="0"></div><span tabIndex="0"></span>');
    const results = querySelectorAllByAttrCI(d, "div", "tabindex");
    expect(results).toHaveLength(1);
  });

  test("returns empty for no matches", () => {
    const d = doc("<div></div>");
    const results = querySelectorAllByAttrCI(d, "*", "tabindex");
    expect(results).toHaveLength(0);
  });
});

describe("querySelectorByAttrValueCI", () => {
  test("finds meta with lowercase http-equiv", () => {
    const d = doc(
      '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">'
    );
    const el = querySelectorByAttrValueCI(
      d,
      "meta",
      "http-equiv",
      "Content-Type"
    );
    expect(el).not.toBeNull();
  });

  test("finds meta with uppercase HTTP-EQUIV", () => {
    const d = doc('<meta HTTP-EQUIV="Content-Type" content="text/html">');
    const el = querySelectorByAttrValueCI(
      d,
      "meta",
      "http-equiv",
      "Content-Type"
    );
    expect(el).not.toBeNull();
  });

  test("returns null when value doesn't match", () => {
    const d = doc('<meta http-equiv="refresh" content="5">');
    const el = querySelectorByAttrValueCI(
      d,
      "meta",
      "http-equiv",
      "Content-Type"
    );
    expect(el).toBeNull();
  });
});
