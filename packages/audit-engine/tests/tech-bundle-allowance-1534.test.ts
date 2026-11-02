// #1534: a script's source text is sent at most once, and the per-bundle allowance is still spent. After the
// boundary trim, the head tops up through the gaps in order (the head to the first sampled stretch, then each
// stretch to the next), and stretches that touch are one, so a bundle over its cap is read up to the cap and a
// vendor call at a boundary reaches detection whole. Bytes are UTF-8 bytes throughout.

import { describe, expect, test } from "bun:test";

import {
  buildTechInputs,
  DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
  DEFAULT_TECH_BUNDLE_LIMITS,
  detectReportTechnologiesMulti,
  LOCAL_TECH_DETECT_OPTIONS,
  type TechBundleLimits,
} from "../src/technologies";

const HOME = "https://example.com/";
const SEP = "\n\0\n";
const KB = 1024;
const HEAD = 16 * KB;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

const cloud: TechBundleLimits = DEFAULT_TECH_BUNDLE_LIMITS;
/** The local scan with `[tech_detect] bundle_bytes = 131072`: the page and audit caps are the local defaults. */
const local128k: TechBundleLimits = {
  bundleBytes: 128 * KB,
  pageBytes: DEFAULT_LOCAL_TECH_BUNDLE_LIMITS.pageBytes,
  auditBytes: DEFAULT_LOCAL_TECH_BUNDLE_LIMITS.auditBytes,
};
const localWhole: TechBundleLimits = DEFAULT_LOCAL_TECH_BUNDLE_LIMITS;

/** Whole unique lines of code with no vendor literal, padded to exactly `size` characters. */
function lines(tag: string, size: number, prefix = "var v_"): string {
  let out = "";
  for (let i = 0; ; i++) {
    const line = `${prefix}${tag}_${i}=${(((i + 1) * 2654435761) % 4294967296).toString(16).padStart(8, "0")};\n`;
    if (out.length + line.length > size) break;
    out += line;
  }
  return out.length < size ? `${out}/${" ".repeat(Math.max(0, size - out.length - 2))}\n` : out;
}

const KEY = `phc_${"a".repeat(43)}`;
const CALL = `!function(){posthog.init("${KEY}",{api_host:"https://us.i.posthog.com"})}();\n`;
const CALL_AT = CALL.indexOf("posthog.init");
const INIT = `posthog.init("${KEY}",{api_host:"https://us.i.posthog.com"})`;

interface Page {
  inputs: ReturnType<typeof buildTechInputs>;
  emitted: Map<string, string>;
  ids: string[];
}

function build(scripts: Array<{ url: string; content: string }>, limits: TechBundleLimits): Page {
  const inputs = buildTechInputs(
    [{ url: HOME, headers: {}, html: `<!doctype html><div id="root"></div>` }],
    scripts.map((script) => ({ ...script, sourcePages: [HOME] })),
    limits,
  );
  const emitted = new Map<string, string>();
  for (const script of inputs[0]!.scripts ?? []) if (script.content) emitted.set(script.url, script.content);
  const ids = detectReportTechnologiesMulti(inputs, undefined, LOCAL_TECH_DETECT_OPTIONS).items.map((item) => item.id);
  return { inputs, emitted, ids };
}

/** Full source lines (those that start with `var v_`) that appear more than once in the text sent for a script. */
function repeatedFullLines(sent: string, source: string): number {
  const full = new Set(source.split("\n").filter((line) => line.startsWith("var v_")));
  const seen = new Map<string, number>();
  for (const line of sent.split("\n")) if (full.has(line)) seen.set(line, (seen.get(line) ?? 0) + 1);
  return [...seen.values()].filter((n) => n > 1).length;
}

describe("a hinted bundle over bundleBytes spends its whole allowance, with no text sent twice (#1534)", () => {
  for (const [name, limits] of [
    ["cloud 64 KB", cloud],
    ["local 128 KB", local128k],
  ] as const) {
    test(`${name}: emits the allowance, keeps the hint, repeats no line`, () => {
      // The first window sits early, so the head can only grow a little before it: the rest of the allowance is spent after it.
      const content = `${lines("a", 30_000)}${CALL}${lines("b", limits.bundleBytes * 3)}`;
      const { emitted, ids } = build([{ url: "https://example.com/a.js", content }], limits);
      const sent = emitted.get("https://example.com/a.js") ?? "";
      // ASCII text: one byte a character, so the allowance is spent to the byte
      expect(bytes(sent)).toBe(limits.bundleBytes);
      expect(repeatedFullLines(sent, content)).toBe(0);
      expect(sent).toContain(INIT);
      expect(ids).toContain("posthog");
    });

    test(`${name}: multi-byte text is counted in UTF-8 bytes, the allowance still holds`, () => {
      const content = `${lines("m", 30_000, "var é_")}${CALL}${lines("n", limits.bundleBytes, "var é_")}`;
      const { emitted } = build([{ url: "https://example.com/a.js", content }], limits);
      const sent = emitted.get("https://example.com/a.js") ?? "";
      expect(bytes(sent)).toBeLessThanOrEqual(limits.bundleBytes);
      expect(bytes(sent)).toBeGreaterThanOrEqual(limits.bundleBytes - 64);
      const seen = sent.split("\n").filter((line) => line.startsWith("var é_"));
      expect(new Set(seen).size).toBe(seen.length);
    });

    test(`${name}: four-byte characters never leave half a surrogate pair at a cut`, () => {
      // Every character is an astral one (two UTF-16 units, four bytes), so a cut by characters would split a pair.
      const astral = (n: number): string => "😀".repeat(n);
      const content = `${astral(9_000)}\n${CALL}${astral(limits.bundleBytes)}\n${astral(limits.bundleBytes)}`;
      const { emitted } = build([{ url: "https://example.com/a.js", content }], limits);
      const sent = emitted.get("https://example.com/a.js") ?? "";
      expect(sent.isWellFormed()).toBe(true);
      expect(bytes(sent)).toBeLessThanOrEqual(limits.bundleBytes);
      expect(bytes(sent)).toBeGreaterThanOrEqual(limits.bundleBytes - 64);
    });
  }

  test("builds are deterministic", () => {
    const content = `${lines("a", 150 * KB)}${CALL}${lines("b", 150 * KB)}`;
    const one = build([{ url: "https://example.com/a.js", content }], cloud);
    const two = build([{ url: "https://example.com/a.js", content }], cloud);
    expect(JSON.stringify(one.inputs)).toBe(JSON.stringify(two.inputs));
  });

  test("a bundle with no hint is read from the front up to the cap, once", () => {
    const content = lines("p", 300 * KB);
    const { emitted } = build([{ url: "https://example.com/a.js", content }], cloud);
    const sent = emitted.get("https://example.com/a.js") ?? "";
    expect(bytes(sent)).toBeGreaterThanOrEqual(cloud.bundleBytes - 32);
    expect(bytes(sent)).toBeLessThanOrEqual(cloud.bundleBytes);
    expect(repeatedFullLines(sent, content)).toBe(0);
  });
});

// The 33-bundle corpus shapes (s7-nv060 and s7-nv120): a 30 KB prefix, then one vendor marker every ten lines, two
// Firebase configs, and a long tail of filler. At the local 128 KB cap the page used to lose vendors that the same
// bundle read whole still has.
describe("hints dense late in a bundle larger than bundleBytes keep every vendor at the local cap (#1534)", () => {
  const MARKERS = [
    "__REACT_DEVTOOLS_GLOBAL_HOOK__",
    "__VUE__",
    "getAllAngularRootElements",
    "__svelte",
    "SvelteComponent",
    "__remixContext",
    'gtag("config", "G-',
    "posthog.init",
    "mixpanel.init",
    "amplitude.init",
    "hotjar.com",
    "_paq.push",
    "analytics.load(",
    "Stripe(",
    "fbq('init'",
    "jQuery.fn.jquery",
    "[Sentry]",
    "window._taboola = window._taboola || []",
    "_taboola.push({",
    "window.obApi =",
    "window.criteo_q = window.criteo_q || []",
    "criteo_q.push(",
    "adroll_adv_id =",
    "adroll_pix_id =",
    "TTDUniversalPixelApi",
    "window._mNHandle",
    "medianet_versionId",
    "apstag.init(",
    "window.uetq = window.uetq || []",
    "twq('config',",
    "_linkedin_partner_id",
    "pintrk('load',",
    "TiktokAnalyticsObject",
    "ttq.load(",
    "snaptr('init',",
    "rdt('init',",
    "qp('init',",
    "pbjs.que = pbjs.que || []",
    "pbjs.addAdUnits(",
    "googletag.cmd.push(",
    "googletag.enableServices(",
    "window.dotq = window.dotq || []",
    ".2o7.net",
    's_gi("v")',
    "globalsNowPlowNamespace",
    "Pendo.initialize(",
    "_fs_namespace",
    "LogRocket.init (",
    "smartlook('init'",
    "_mfq.push (",
    "_qevents.push(",
    "_sf_async_config",
    "rudderanalytics.load(",
    "mParticle.config",
    "_kmq.push (",
    "woopra.identify (",
    "Countly.q",
    'ym(483, "init"',
    "_cio.track(",
    "window.NREUM",
    "Bugsnag.createClient",
    "_rollbarConfig",
    "trackJs.install (",
    'rg4js ("apiKey',
    "Honeybadger.configure(",
    "DTRUM",
    "window['adrum-start-time']",
    "ADRUM",
    "LUX.send =",
    "window['optimizely']",
    "var _vwo_code",
    "window.ABTasty",
    "var _conv_q",
    "window.kameleoonStartLoadTime",
    "cloudinary.openUploadWidget(",
    "tidioChatApi",
    "olarkUserData",
    "fcWidget.init",
    "freshworksWidget(",
    "__onBeaconDestroy",
    "gorgias-chat-widget-install",
    "GorgiasChat",
    "kustomerCore",
    "FrontChat(",
    "Gladly.init(",
    "window.reamaze",
    "ChatWootSDK",
    "chatwootSettings",
    "_smartsupp.key",
    "$zoho.salesiq",
    "LiveAgent.createButton",
    "__USERLIKE_MOUNT_GUARD__",
    "chaportConfig",
    "jivo_api",
    "purechatApi",
    "data-requiremodule='Magento_",
    "WooCommerce_params",
    "window.StencilBootstrap",
    "var prestashop =",
    "apicdn.sanity.io",
    "prismic.io/api/v2",
    "storyblokBridge",
    "ecwid.",
    "volusion.AffixYourOrder",
    "window.activeFeatureFlags",
    "X-Publishable-Api-Key",
    "runtimeConfig.saleor",
    "window.dmAPI",
    "window._w=",
    "mtifonttrackingcode",
    "__vuepress__",
    "__VP_HASH_MAP__",
    "__sveltekit_ev",
    "Phoenix.Channel",
    "self.webpackChunk =self.webpackChunk",
    "webpackJsonp.push(",
    "__webpack_require__.e",
    "__vitePreload",
    "__STATSIG__",
    "splitio.SplitFactory",
  ];
  const FILLER = `function f(x){let y=x*3;const u="https://www.example.com/a/"+y;return u.length}\n`;
  const FIREBASE = [
    `var doc='{authDomain:"doc-app.firebaseapp.com",storageBucket:"doc-app.appspot.com"}';\n`,
    `var cfg={authDomain:"real-app.firebaseapp.com",storageBucket:"real-app.appspot.com"};\n`,
  ];
  const shape = (count: number): string => {
    const out: string[] = [FILLER.repeat(375), "\n"];
    for (const marker of MARKERS.slice(0, count)) out.push(`/*v*/ ${marker} \n`, FILLER.repeat(9));
    out.push(FIREBASE[0]!, FILLER.repeat(63), FIREBASE[1]!, FILLER.repeat(1250));
    return out.join("");
  };

  for (const count of [60, 120]) {
    test(`${count} markers: local 128 KB finds every vendor the whole body has`, () => {
      const content = shape(count);
      expect(content.length).toBeGreaterThan(local128k.bundleBytes);
      const whole = build([{ url: "https://example.com/a.js", content }], localWhole);
      const capped = build([{ url: "https://example.com/a.js", content }], local128k);
      expect(whole.ids.length).toBeGreaterThan(30);
      expect(capped.ids.slice().sort()).toEqual(whole.ids.slice().sort());
      const sent = capped.emitted.get("https://example.com/a.js") ?? "";
      expect(bytes(sent)).toBeGreaterThanOrEqual(local128k.bundleBytes - 64);
    });
  }
});

// A vendor call that starts a few characters before the 16 KB head ends, on a page of 20 to 30 scripts whose
// floors take most of the page budget (cloud caps). The loader is first or last; the key literal must arrive whole.
describe("a call straddling the head boundary is kept whole on a tight-budget page (#1534)", () => {
  const LOADER = `posthog.init("${KEY}",{api_host:"https://us.i.posthog.com"});\n`;
  const plainScripts = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      url: `https://example.com/p${n}.js`,
      content: lines(`p${n}`, 40_000),
    }));
  /** A 40,000-character script whose `posthog.init(` starts `before` characters before character 16,384. */
  const loaderScript = (before: number) => {
    const pre = `${lines("pre", HEAD - before - 1)}\n`;
    const head = `${pre}${LOADER}`;
    const content = `${head}${lines("post", 40_000 - head.length)}`;
    expect(content.indexOf("posthog.init")).toBe(HEAD - before);
    return { url: "https://example.com/ph.js", content };
  };
  for (const count of [20, 25, 30]) {
    for (const position of ["first", "last"] as const) {
      for (const before of [5, 10, 20, 40, 60]) {
        test(`${count} plain scripts, loader ${position}, posthog.init ${before} characters before the head ends`, () => {
          const ph = loaderScript(before);
          const plain = plainScripts(count);
          const { emitted, ids } = build(position === "first" ? [ph, ...plain] : [...plain, ph], cloud);
          expect(ids).toContain("posthog");
          const sent = emitted.get(ph.url) ?? "";
          expect(sent).toContain(LOADER.trim().slice(0, -1));
          expect(sent).toContain(`"${KEY}"`);
          expect(repeatedFullLines(sent, ph.content)).toBe(0);
          // The page budget is the scarce thing here: every byte is spent, and counted once (a head cut back to
          // keep the context of a window hands its bytes back).
          let total = 0;
          for (const script of [ph, ...plain]) {
            const body = emitted.get(script.url) ?? "";
            total += bytes(body);
            // a script's head is its first 16 KB whole, whatever follows it
            expect(body.startsWith(script.content.slice(0, script === ph ? HEAD - before : HEAD)), script.url).toBe(true);
          }
          expect(total).toBe(cloud.pageBytes);
        });
      }
    }
  }
});

// Byte-exact: every emitted piece is a verbatim stretch of the source (each line is unique), the pieces are in order,
// and two pieces are separated only where text is left out. A piece that touches the next one is not split by a
// separator, no text is sent twice, and no byte is skipped while the allowance has room.
describe("emitted pieces are disjoint, in order, and abut without a separator (#1534)", () => {
  const unique = (tag: string, size: number): string => lines(tag, size, "var u_");
  /** Unique statements with no newline in them: nothing but the sampler's own cuts decides where a window starts. */
  const flat = (tag: string, size: number): string => {
    let out = "";
    for (let i = 0; out.length < size; i++) out += `u_${tag}_${i}=${(((i + 1) * 2654435761) % 4294967296).toString(16)};`;
    return out.slice(0, size);
  };
  const pieces = (sent: string, source: string): Array<{ at: number; length: number }> =>
    sent.split(SEP).map((piece) => {
      const at = source.indexOf(piece);
      expect(at, "piece is verbatim source").toBeGreaterThanOrEqual(0);
      expect(source.lastIndexOf(piece), "piece is unique in the source").toBe(at);
      return { at, length: piece.length };
    });
  const tails = new Map<(tag: string, size: number) => string, string>();
  const check = (callAt: number, make: (tag: string, size: number) => string): void => {
    const start = callAt - CALL_AT;
    if (!tails.has(make)) tails.set(make, make("b", 200 * KB));
    const content = `${make("a", start)}${CALL}${tails.get(make)}`;
    const { emitted, ids } = build([{ url: "https://example.com/a.js", content }], cloud);
    const sent = emitted.get("https://example.com/a.js") ?? "";
    expect(ids, `call at ${callAt}`).toContain("posthog");
    expect(sent, `call at ${callAt}`).toContain(INIT);
    const found = pieces(sent, content);
    expect(found[0]!.at).toBe(0);
    for (let n = 1; n < found.length; n++) {
      // strictly after: text is left out between two pieces, otherwise they would be one
      expect(found[n]!.at, `call at ${callAt}, piece ${n}`).toBeGreaterThan(found[n - 1]!.at + found[n - 1]!.length);
    }
    // Text is left out only because the allowance ran out, and the allowance is then spent to the byte.
    expect(bytes(sent), `call at ${callAt}`).toBeLessThanOrEqual(cloud.bundleBytes);
    if (found.length > 1) expect(bytes(sent), `call at ${callAt}`).toBe(cloud.bundleBytes);
  };

  for (const callAt of [HEAD - 10, HEAD - 5, HEAD + 5, 40_000, 120_000]) {
    test(`call at ${callAt}`, () => {
      check(callAt, unique);
      // Within reach of the allowance the head grows to the window and the two are one piece: no separator splits them.
      if (callAt <= 40_000) {
        const start = callAt - CALL_AT;
        const content = `${unique("a", start)}${CALL}${unique("b", 200 * KB)}`;
        const sent = build([{ url: "https://example.com/a.js", content }], cloud).emitted.get("https://example.com/a.js") ?? "";
        expect(sent.startsWith(content.slice(0, callAt + CALL.length - CALL_AT))).toBe(true);
        expect(sent.split(SEP)[0]!.length).toBeGreaterThanOrEqual(callAt + CALL.length - CALL_AT);
      }
    });
  }

  // Every offset of the call around the head boundary, in lines and in one unbroken run of statements.
  for (const [style, make] of [
    ["lines", unique],
    ["statements", flat],
  ] as const) {
    test(`every call offset from 400 characters before the head boundary to 400 after it (${style})`, () => {
      for (let callAt = HEAD - 400; callAt <= HEAD + 400; callAt++) check(callAt, make);
    }, 60_000);
  }
});

// A Supabase config whose host literal (the search hint) falls after the head boundary while the `mk("https://` that
// qualifies it falls before: the window that holds it starts in the head, so the head is cut back to the window and the
// two are one piece. Every position of the signal around the boundary, with no newline anywhere in the text.
describe("a hint just after the head boundary keeps the context before it, once (#1534)", () => {
  const SIGNAL = `var s=mk("https://p0000000000000000001.supabase.co","eyJ${"x".repeat(40)}");`;
  const flat = (tag: string, size: number): string => {
    let out = "";
    for (let i = 0; out.length < size; i++) out += `u_${tag}_${i}=${(((i + 1) * 2654435761) % 4294967296).toString(16)};`;
    return out.slice(0, size);
  };
  const tail = flat("t", 200 * KB);
  test("every signal offset from 330 characters before the boundary to 180 after it", () => {
    for (let at = HEAD - 330; at <= HEAD + 180; at++) {
      const content = `${flat("h", at)}${SIGNAL}${tail}`;
      const { emitted, ids } = build([{ url: "https://example.com/a.js", content }], cloud);
      const sent = emitted.get("https://example.com/a.js") ?? "";
      expect(ids, `signal at ${at}`).toContain("supabase");
      expect(sent, `signal at ${at}`).toContain(SIGNAL);
      // every piece is verbatim source, in order and apart, and the allowance is spent to the byte
      let from = 0;
      for (const piece of sent.split(SEP)) {
        const found = content.indexOf(piece, from);
        expect(found, `signal at ${at}: piece after ${from}`).toBeGreaterThanOrEqual(from);
        from = found + piece.length + 1;
      }
      expect(bytes(sent), `signal at ${at}`).toBe(cloud.bundleBytes);
    }
  }, 60_000);
});

describe("page shapes from the #1534 report repeat no full line (#1534)", () => {
  const late = (): string => `${lines("late", 100_000)}${CALL}${lines("late2", 100_000)}`;

  for (const count of [7, 13, 16]) {
    test(`${count} x 40 KB scripts plus a late bundle`, () => {
      const scripts = [
        ...Array.from({ length: count }, (_, n) => ({
          url: `https://example.com/s${n}.js`,
          content: lines(`s${n}`, 40_000),
        })),
        { url: "https://example.com/late.js", content: late() },
      ];
      const { emitted, ids } = build(scripts, cloud);
      let total = 0;
      for (const script of scripts) {
        const sent = emitted.get(script.url) ?? "";
        total += bytes(sent);
        expect(bytes(sent)).toBeLessThanOrEqual(cloud.bundleBytes);
        expect(repeatedFullLines(sent, script.content), script.url).toBe(0);
      }
      expect(total).toBeLessThanOrEqual(cloud.pageBytes);
      expect(ids).toContain("posthog");
    });
  }

  // O = 70,000 leaves the small script S room to be read whole: it is sent once, in one piece.
  for (const small of [40_000, 20_000, 17_000]) {
    test(`two scripts: ${small} and 70000 bytes, the small one is sent once and whole`, () => {
      const scripts = [
        { url: "https://example.com/a.js", content: lines("a", small) },
        { url: "https://example.com/b.js", content: lines("b", 70_000) },
      ];
      const { emitted } = build(scripts, cloud);
      for (const script of scripts) {
        expect(repeatedFullLines(emitted.get(script.url) ?? "", script.content), script.url).toBe(0);
      }
      expect(emitted.get("https://example.com/a.js")).toBe(scripts[0]!.content);
      expect(bytes(emitted.get("https://example.com/b.js") ?? "")).toBeGreaterThanOrEqual(cloud.bundleBytes - 32);
    });
  }
});
