// #1881 — an item finding's identity must describe the ITEM, not the page.
//
// `findingFingerprint` hashes [status, message, value, expected] and is
// deliberately URL-free, so `finding_defs` (site + fingerprint) can hold one row
// per distinct defect. Before this, `flattenChecks` copied the parent check's
// PAGE-LEVEL message/value/expected onto every item row, and a page-scope check's
// message is a count of that page's items — so one Shopify CDN script missing SRI
// on 401 pages stored 25 different messages ("26 cross-origin resources without
// Subresource Integrity" here, "24 ..." there) and 25 fingerprints for one defect.
//
// The gates below are the invariant, its two round-trips, and the pre-#1881
// compatibility fallback.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFindingRecord } from "@squirrelscan/core-contracts";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";

import { fingerprint, flattenChecks, itemFindingMessage } from "../src/merge";
import { carriedFindingToCheck } from "../src/scoring";
import { reconstructPageRuleChecks } from "../src/reconstruct";

/** The SRI shape that produced the drscholls inflation: the same cross-origin
 * assets on every page, but a page-varying COUNT of them in the check message. */
function sriCheck(count: number): CheckResult {
  const items = Array.from({ length: count }, (_, k) => ({
    id: `https://cdn.shopify.com/extensions/globo-${k}.js`,
    label: k % 3 === 0 ? "stylesheet" : "script",
  }));
  return {
    name: "sri",
    status: "warn",
    message: `${count} cross-origin ${count === 1 ? "resource" : "resources"} without Subresource Integrity`,
    value: String(count),
    expected: "0",
    items,
  };
}

/** Turn a FlatFinding into the stored row shape the readers consume. */
function toRecord(f: ReturnType<typeof flattenChecks>[number]): PageFindingRecord {
  return {
    siteKey: "SITE",
    normalizedUrl: f.normalizedUrl,
    ruleId: f.ruleId,
    checkName: f.checkName,
    locator: f.locator,
    status: f.status as PageFindingRecord["status"],
    severity: "warning",
    message: f.message,
    value: f.value,
    expected: f.expected,
    payload: f.payload,
    fingerprint: fingerprint(f.status, f.message, f.value, f.expected),
    firstSeenAt: 1,
    lastSeenCrawlId: "crawl-1",
    lastSeenAt: 1,
    provenance: "fresh",
    state: "open",
  };
}

describe("#1881 item findings carry their own identity", () => {
  test("the SAME item on two pages fingerprints identically under different page-level counts", () => {
    // Page A sees 26 cross-origin assets, page B sees 24 — the exact drscholls
    // split. `globo-0.js` is one defect and must hash to one value.
    const a = flattenChecks("https://x/a", "security/sri", [sriCheck(26)]);
    const b = flattenChecks("https://x/b", "security/sri", [sriCheck(24)]);

    const pick = (rows: typeof a, locator: string) => rows.find((f) => f.locator === locator)!;
    const itemA = pick(a, "https://cdn.shopify.com/extensions/globo-0.js");
    const itemB = pick(b, "https://cdn.shopify.com/extensions/globo-0.js");

    expect(itemA.message).toBe(
      "cross-origin resources without Subresource Integrity: https://cdn.shopify.com/extensions/globo-0.js",
    );
    expect(itemA.message).toBe(itemB.message);
    expect(fingerprint(itemA.status, itemA.message, itemA.value, itemA.expected)).toBe(
      fingerprint(itemB.status, itemB.message, itemB.value, itemB.expected),
    );

    // Pre-#1881 this was 24 vs 26 distinct fingerprints across the two pages;
    // now the union is exactly the 26 assets page A carries.
    const fps = new Set(
      [...a, ...b].map((f) => fingerprint(f.status, f.message, f.value, f.expected)),
    );
    expect(fps.size).toBe(26);
  });

  test("an item row's message/value/expected carry no page-derived text", () => {
    // The invariant that makes distinct (rule, check, locator, status, message,
    // value, expected) collapse to distinct (rule, check, locator, status). The
    // message is a function of (page-invariant check text, item id) — the check's
    // WORDING is still an input, only its per-page numbers are removed.
    const rows = [24, 25, 26].flatMap((n, i) =>
      flattenChecks(`https://x/${i}`, "security/sri", [sriCheck(n)]),
    );
    const byLocator = new Map<string, Set<string>>();
    for (const r of rows) {
      const seen = byLocator.get(r.locator) ?? new Set<string>();
      seen.add(JSON.stringify([r.status, r.message, r.value, r.expected]));
      byLocator.set(r.locator, seen);
    }
    for (const [locator, seen] of byLocator) {
      expect({ locator, variants: seen.size }).toEqual({ locator, variants: 1 });
    }
    // The message is a function of (page-invariant check text, item id) — the
    // page's own count never survives into it.
    expect(rows.every((r) => r.message.endsWith(`: ${r.locator}`))).toBe(true);
    expect(rows.every((r) => !/\d/.test(r.message.slice(0, r.message.length - r.locator.length)))).toBe(
      true,
    );
    expect(rows.every((r) => r.value === null && r.expected === null)).toBe(true);
  });

  test("a per-page number in item.label does NOT reach the row identity", () => {
    // content/keyword-stuffing stamps a per-page density into `label`
    // (`"everyday" (2.3%)`), so the label is page-varying and must stay out of
    // the message — it rides in the payload's item instead.
    const check = (density: string): CheckResult => ({
      name: "keyword-stuffing",
      status: "warn",
      message: "1 word(s) may be overused",
      items: [{ id: "everyday", label: `"everyday" (${density}%)` }],
    });
    const a = flattenChecks("https://x/a", "content/keyword-stuffing", [check("2.3")])[0]!;
    const b = flattenChecks("https://x/b", "content/keyword-stuffing", [check("4.8")])[0]!;

    expect(a.message).toBe("word(s) may be overused: everyday");
    expect(fingerprint(a.status, a.message, a.value, a.expected)).toBe(
      fingerprint(b.status, b.message, b.value, b.expected),
    );
    // Not lost — the label is still replayed from the payload.
    expect(JSON.parse(a.payload!).items[0].label).toBe('"everyday" (2.3%)');
  });

  test("the page-invariant text drops leading counts and neutralises embedded numbers", () => {
    // These are the real shapes production rules emit. The transform is what
    // makes the message page-invariant, so pin it directly rather than only
    // through flattenChecks.
    const msg = (m: string) =>
      itemFindingMessage({ name: "c", status: "warn", message: m }, { id: "ID" });

    expect(msg("26 cross-origin resources without Subresource Integrity")).toBe(
      "cross-origin resources without Subresource Integrity: ID",
    );
    expect(msg("2 cookie(s) missing the Secure flag")).toBe(
      "cookie(s) missing the Secure flag: ID",
    );
    // The count varies page to page; the text must not.
    expect(msg("1 potential source map(s) detected")).toBe(msg("9 potential source map(s) detected"));
    expect(msg("1,024 image(s) missing width/height")).toBe(msg("7 image(s) missing width/height"));
    // A number in the MIDDLE of the wording is neutralised, not dropped.
    expect(msg("Visible text is under 10% of the page HTML")).toBe(
      "Visible text is under N% of the page HTML: ID",
    );
    expect(msg("Visible text is under 10% of the page HTML")).toBe(
      msg("Visible text is under 35% of the page HTML"),
    );
    // No count at all: unchanged.
    expect(msg("Invalid JSON-LD syntax")).toBe("Invalid JSON-LD syntax: ID");
    // Nothing but a number: no wording to keep, so the check name stands in.
    expect(msg("26")).toBe("c: ID");
    expect(msg("2.5")).toBe("c: ID");
    // Leading/trailing whitespace and a decimal count are handled.
    expect(msg("   12 image(s) missing alt")).toBe("image(s) missing alt: ID");
    expect(msg("3.5 MB of unused CSS")).toBe("MB of unused CSS: ID");
    // Non-Latin wording counts as wording; punctuation alone does not.
    expect(msg("12 見出しが見つかりません")).toBe("見出しが見つかりません: ID");
    expect(msg("--- !!! ---")).toBe("c: ID");

    // A pathological message cannot crowd the id out of the store's 1000-char
    // message clamp.
    const long = msg(`${"word ".repeat(400)}tail`);
    expect(long.length).toBeLessThanOrEqual(240 + ": ID".length);
    expect(long.endsWith(": ID")).toBe(true);
  });

  test("a long item id keeps its whole self inside the store's message clamp", () => {
    // The id is the discriminator: two ids that differ only near their end must
    // not display identically, so the prefix yields to the id, not the reverse.
    const idA = `https://cdn.example/${"a".repeat(940)}-one`;
    const idB = `https://cdn.example/${"a".repeat(940)}-two`;
    const check: CheckResult = {
      name: "sri",
      status: "warn",
      message: `${"long wording ".repeat(40)}without Subresource Integrity`,
      items: [{ id: idA }, { id: idB }],
    };
    const rows = flattenChecks("https://x/a", "security/sri", [check]);
    for (const r of rows) {
      expect(r.message.length).toBeLessThanOrEqual(REPORT_LIMITS.maxMediumString);
      expect(r.message.endsWith(r.locator)).toBe(true);
    }
    expect(rows[0]!.message).not.toBe(rows[1]!.message);
  });

  test("a surrogate pair is never cut in half by the prefix cap", () => {
    // A lone surrogate is not valid text to hand a database or a JSON encoder.
    const emoji = "\u{1F600}";
    const msg = itemFindingMessage(
      { name: "c", status: "warn", message: `x${emoji.repeat(200)}` },
      { id: "ID" },
    );
    expect(msg.endsWith(": ID")).toBe(true);
    const body = msg.slice(0, -": ID".length);
    const lastUnit = body.charCodeAt(body.length - 1);
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
    expect([...body].every((ch) => ch === "x" || ch === emoji)).toBe(true);
  });

  test("a check with NO items keeps the page-level message/value/expected verbatim", () => {
    const check: CheckResult = {
      name: "cookie-secure",
      status: "fail",
      message: "2 cookie(s) missing the Secure flag",
      value: "2",
      expected: "0",
    };
    const [row] = flattenChecks("https://x/a", "security/cookie-flags", [check]);
    expect(row).toMatchObject({
      locator: "",
      message: "2 cookie(s) missing the Secure flag",
      value: "2",
      expected: "0",
    });
    // No aggregate stash on a whole-check row — its own columns already hold it.
    expect(row!.payload).toBeNull();
  });

  test("an item with no id falls back to the check name, never the page message", () => {
    const check: CheckResult = {
      name: "sri",
      status: "warn",
      message: "26 cross-origin resources without Subresource Integrity",
      items: [{ id: "" }],
    };
    const [row] = flattenChecks("https://x/a", "security/sri", [check]);
    expect(row!.message).toBe("cross-origin resources without Subresource Integrity");
    expect(itemFindingMessage(check, { id: "  " })).toBe(row!.message);
    // A message that is nothing but a count reduces to the check name.
    expect(itemFindingMessage({ name: "sri", status: "warn", message: "26" }, { id: "x" })).toBe(
      "sri: x",
    );
  });

  test("reconstruct restores the parent check's page-level message/value/expected", () => {
    const source = sriCheck(26);
    const rows = flattenChecks("https://x/a", "security/sri", [source]).map(toRecord);
    const rebuilt = reconstructPageRuleChecks(rows).get("security/sri")!;

    expect(rebuilt.length).toBe(1);
    expect(rebuilt[0]).toMatchObject({
      name: "sri",
      status: "warn",
      message: source.message,
      value: "26",
      expected: "0",
      pageUrl: "https://x/a",
    });
    expect(rebuilt[0]!.items?.map((i) => i.id)).toEqual(source.items!.map((i) => i.id));
  });

  test("carriedFindingToCheck replays the page-level message, so report grouping does not split", () => {
    const source = sriCheck(26);
    const rows = flattenChecks("https://x/a", "security/sri", [source]).map(toRecord);
    const replayed = rows.map((r) =>
      carriedFindingToCheck(
        {
          normalizedUrl: r.normalizedUrl,
          ruleId: r.ruleId,
          checkName: r.checkName,
          status: r.status,
          message: r.message,
          value: r.value,
          expected: r.expected,
          payload: r.payload,
        },
        r.normalizedUrl,
      ),
    );
    // Report grouping keys on (name, status, digit-normalized message); every
    // replayed item check must land in ONE group, as it did pre-#1881.
    expect(new Set(replayed.map((c) => c.message))).toEqual(new Set([source.message]));
    expect(new Set(replayed.map((c) => c.value))).toEqual(new Set(["26"]));
    expect(replayed[0]!.items).toEqual([source.items![0]!]);
  });

  test("an empty-id item still restores its aggregate, even though it lands in a locator-\"\" group", () => {
    // `m` (not the locator) is the restore marker precisely for this case: an
    // item with id "" flattens to locator "", so a locator-gated restore would
    // leave the reconstructed check holding the ITEM's message.
    const check: CheckResult = {
      name: "sri",
      status: "warn",
      message: "26 cross-origin resources without Subresource Integrity",
      value: "26",
      expected: "0",
      items: [{ id: "" }],
    };
    const rows = flattenChecks("https://x/a", "security/sri", [check]).map(toRecord);
    expect(rows[0]!.locator).toBe("");
    expect(reconstructPageRuleChecks(rows).get("security/sri")![0]).toMatchObject({
      message: "26 cross-origin resources without Subresource Integrity",
      value: "26",
      expected: "0",
    });
  });

  test("a whole-check row whose payload carries details/pages is NOT read as an item row", () => {
    // Payload presence alone cannot mark an item row — a whole-check finding
    // carries details/pages too, and its own columns are already page-level.
    const check: CheckResult = {
      name: "slug-keywords",
      status: "warn",
      message: "3 keyword(s) repeated in the slug",
      value: "3",
      details: { some: "detail" },
      pages: ["https://x/a"],
    };
    const [row] = flattenChecks("https://x/a", "url/slug-keywords", [check]);
    expect(row!.payload).not.toBeNull();
    expect(JSON.parse(row!.payload!).m).toBeUndefined();
    expect(reconstructPageRuleChecks([toRecord(row!)]).get("url/slug-keywords")![0]).toMatchObject({
      message: "3 keyword(s) repeated in the slug",
      value: "3",
    });
  });

  test("the aggregate stash yields rather than pushing a near-cap payload over maxFindingPayload", () => {
    // A payload over the cap is DROPPED whole by the chunk ingest, and `details`
    // feeds the density penalty — so growing a payload past the line would move
    // the score. The stash is display detail, so it is what gets dropped.
    const withBlob = (blob: string): CheckResult => ({
      name: "sri",
      status: "warn",
      message: "26 cross-origin resources without Subresource Integrity",
      value: "26",
      expected: "0",
      details: { blob, additional: 19 },
      items: [{ id: "https://cdn/x.js" }],
    });
    const flatten = (blob: number) =>
      flattenChecks("https://x/a", "security/sri", [withBlob("d".repeat(blob))])[0]!;
    // Walk the blob up to the exact boundary where the stash no longer fits.
    const start = REPORT_LIMITS.maxFindingPayload - flatten(0).payload!.length;
    let blob = start;
    let row = flatten(blob);
    while (JSON.parse(row.payload!).m !== undefined && blob < start + 512) {
      blob += 4;
      row = flatten(blob);
    }
    const payload = JSON.parse(row.payload!);
    expect(row.payload!.length).toBeLessThanOrEqual(REPORT_LIMITS.maxFindingPayload);
    // Scoring-relevant detail survives; the aggregate is the part that yielded.
    expect(payload.details.additional).toBe(19);
    expect(payload.m).toBeUndefined();
    // And the reader degrades to the row's own columns rather than blanking out.
    expect(reconstructPageRuleChecks([toRecord(row)]).get("security/sri")![0]).toMatchObject({
      message: "cross-origin resources without Subresource Integrity: https://cdn/x.js",
    });

    // One notch smaller and the stash is back — the drop is a cap effect, not a
    // blanket behaviour change.
    expect(JSON.parse(flatten(blob - 4).payload!).m).toBe(
      "26 cross-origin resources without Subresource Integrity",
    );

    // The budget only ever removes the STASH. It must never trim items/details
    // to fit, because this same payload goes to the CLI's local SQLite store,
    // which has no cap — an already-over-cap payload keeps every field, byte
    // for byte as it did pre-#1881, and shrinking it for transport is the chunk
    // ingest's job.
    const overCap = flatten(REPORT_LIMITS.maxFindingPayload * 2);
    const kept = JSON.parse(overCap.payload!);
    expect(overCap.payload!.length).toBeGreaterThan(REPORT_LIMITS.maxFindingPayload);
    expect(kept.m).toBeUndefined();
    expect(kept.details.additional).toBe(19);
    expect(kept.details.blob.length).toBe(REPORT_LIMITS.maxFindingPayload * 2);
    expect(kept.items).toEqual([{ id: "https://cdn/x.js" }]);
  });

  test("the aggregate is found on ANY sibling, so a per-item budget drop does not depend on row order", () => {
    // The budget is decided per item, so one item with a huge payload can lose
    // its stash while its siblings keep theirs. Reading only the first row would
    // make the restore depend on which row the loader happened to return first.
    const check: CheckResult = {
      name: "sri",
      status: "warn",
      message: "2 cross-origin resources without Subresource Integrity",
      value: "2",
      items: [
        { id: "https://cdn/huge.js", snippet: "s".repeat(REPORT_LIMITS.maxFindingPayload * 2) },
        { id: "https://cdn/small.js" },
      ],
    };
    const rows = flattenChecks("https://x/a", "security/sri", [check]).map(toRecord);
    // The oversized item is over the cap and loses its stash; its sibling keeps
    // one. Reading only group[0] would make the restore depend on row order.
    expect(rows.map((r) => JSON.parse(r.payload!).m !== undefined)).toEqual([false, true]);

    for (const order of [rows, [...rows].reverse()]) {
      expect(reconstructPageRuleChecks(order).get("security/sri")![0]).toMatchObject({
        message: "2 cross-origin resources without Subresource Integrity",
        value: "2",
      });
    }
  });

  test("a pre-#1881 row (payload without the aggregate stash) still reconstructs from its own columns", () => {
    // Rows written before this change hold the page-level message in `message`
    // and carry no `m` — the readers must fall back to the row, not blank out.
    const legacy: PageFindingRecord = {
      siteKey: "SITE",
      normalizedUrl: "https://x/a",
      ruleId: "security/sri",
      checkName: "sri",
      locator: "https://cdn/x.js",
      status: "warn",
      severity: "warning",
      message: "26 cross-origin resources without Subresource Integrity",
      value: "26",
      expected: "0",
      payload: JSON.stringify({ items: [{ id: "https://cdn/x.js" }], i: 0 }),
      fingerprint: "legacy",
      firstSeenAt: 1,
      lastSeenCrawlId: "crawl-0",
      lastSeenAt: 1,
      provenance: "carried",
      state: "open",
    };
    const rebuilt = reconstructPageRuleChecks([legacy]).get("security/sri")![0]!;
    expect(rebuilt).toMatchObject({
      message: "26 cross-origin resources without Subresource Integrity",
      value: "26",
      expected: "0",
    });
    expect(
      carriedFindingToCheck(
        {
          normalizedUrl: legacy.normalizedUrl,
          ruleId: legacy.ruleId,
          checkName: legacy.checkName,
          status: legacy.status,
          message: legacy.message,
          value: legacy.value,
          expected: legacy.expected,
          payload: legacy.payload,
        },
        legacy.normalizedUrl,
      ),
    ).toMatchObject({
      message: "26 cross-origin resources without Subresource Integrity",
      value: "26",
      expected: "0",
    });
  });
});
