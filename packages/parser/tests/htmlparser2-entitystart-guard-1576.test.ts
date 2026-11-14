// #1576: the class cut in `dom.ts` (ClassProbe.onattribentity) reads the private `entityStart` field of htmlparser2's tokenizer to
// find where an entity starts. It is not in the typed API. If a dependency bump drops it, the cut silently does nothing and pages
// degrade to an empty document with a notice. This test turns that into a failure that names the dependency.
// (That this package and linkedom resolve one htmlparser2 copy is asserted in class-cut-differential.test.ts.)

import { expect, test } from "bun:test";
import { Parser } from "htmlparser2";

test("htmlparser2 tokenizer exposes a numeric entityStart during an attribute entity callback", () => {
  const seen: unknown[] = [];
  const parser = new Parser({}) as unknown as {
    tokenizer: { entityStart?: unknown };
    onattribentity: (cp: number) => void;
    write: (s: string) => void;
    end: () => void;
  };
  const originalEntity = parser.onattribentity.bind(parser);
  parser.onattribentity = (cp: number) => {
    seen.push(parser.tokenizer?.entityStart);
    originalEntity(cp);
  };
  // two entities (named and numeric) inside a quoted attribute value
  parser.write('<div class="a&amp;b&#x41;c">x</div>');
  parser.end();

  const message =
    "htmlparser2 no longer exposes the private tokenizer.entityStart as a number during onattribentity; " +
    "ClassProbe in packages/parser/src/dom.ts depends on it (#1576). Re-derive the entity start before bumping htmlparser2.";
  expect(seen.length, message).toBe(2);
  for (const value of seen) {
    expect(typeof value, message).toBe("number");
    expect(value as number, message).toBeGreaterThanOrEqual(0);
  }
});
