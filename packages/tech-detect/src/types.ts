export type TechCategory =
  | "cms"
  | "framework"
  | "analytics"
  | "cdn"
  | "ad-network"
  | "payment"
  | "web-server"
  | "hosting"
  | "security"
  | "tag-manager"
  | "chat"
  | "font"
  | "video"
  | "widget"
  // WordPress plugins and their kind (#1033)
  | "cache"
  | "seo"
  | "images"
  | "other";

export type ScriptMatchValidator = (match: RegExpExecArray) => boolean;

export type Detector =
  | { type: "header"; name: string; pattern: RegExp }
  | { type: "meta"; name: string; pattern: RegExp }
  | { type: "script-url"; pattern: RegExp }
  // `inCode`: the match must start in code, not inside a comment or a string
  // literal of the script, so a docs snippet or a commented-out call is no
  // evidence. For config-style patterns that need a real call to mean anything.
  // An `inCode` detector reads fetched script bodies only, never the page HTML.
  // `hint`: a literal the match needs, searched across a whole bundle to pick
  // the windows worth sending when the body is too big to send whole.
  // `also`: a second pattern the SAME script body must match (anywhere, strings
  // included) for the detector to fire, with the literals (`hints`) that locate it
  // in a bundle too big to send whole. For a signature that sits far from the
  // anchor it qualifies, e.g. a library's own strings and a project URL elsewhere.
  // Needs `inCode` (the type enforces it), and the second pattern is not gated to
  // code, so a comment or string that quotes the signature also satisfies it.
  | {
      type: "script-content";
      pattern: RegExp;
      inCode?: boolean;
      // `stringValue` (with `inCode`): a match inside a string literal also counts when that string is the text of an
      // inline script element a framework renders (`dangerouslySetInnerHTML:{__html}` or `children` on script props:
      // a `"script"` tag, a `strategy` key or a script `type`) and matches this regular expression, the evidence that it
      // is a loader and not a quote of one (#1509). Any other string (docs, markup, a code sample) is still rejected.
      stringValue?: RegExp;
      hint?: string;
      also?: undefined;
      validate?: ScriptMatchValidator;
    }
  | {
      type: "script-content";
      pattern: RegExp;
      inCode: true;
      stringValue?: undefined;
      hint?: string;
      also: { pattern: RegExp; hints: string[] };
      validate?: ScriptMatchValidator;
    }
  // `requires`: literal that must appear in the html (case-sensitive) before the
  // pattern runs, a cheap gate for patterns that scan a bounded window per tag.
  | { type: "html"; pattern: RegExp; requires?: string }
  | { type: "dom"; selector: string }
  | { type: "url-path"; pattern: RegExp }
  // Matches the audited page's own host name only, never its HTML: a third-party app a page loads
  // (a script on `*.web.app`) says nothing about where the page itself is hosted.
  | { type: "url-host"; pattern: RegExp }
  // An attribute of a real tag as written (comments excluded, quoted or not), read from one parsed list of the page's
  // tags instead of a scan of the HTML per signature (#1456). `pattern` tests the value (anchor it to the start of a
  // URL); `tokens` also tests each whitespace or comma separated token (`srcset`). `tags` must be among the tags the
  // page pass collects (`COLLECTED_TAGS` in detect.ts).
  | { type: "tag-attr"; tags: readonly string[]; attrs: readonly string[]; pattern: RegExp; tokens?: boolean };

export interface TechFingerprint {
  id: string;
  name: string;
  category: TechCategory;
  website?: string;
  icon?: string;
  detectors: Detector[];
  confidence?: "high" | "medium" | "low";
  versionPattern?: RegExp;
  /**
   * Match html and script detectors against the markup with HTML comments
   * removed, so a commented-out tag is not evidence.
   */
  ignoreComments?: boolean;
  /** Drop this detection when any of these fingerprint ids is also detected. */
  unlessAny?: string[];
}

export interface TechDetectInput {
  url: string;
  headers: Record<string, string>;
  html: string;
  scripts?: Array<{ url: string; content?: string }>;
  meta?: Record<string, string>;
}

export interface DetectedTechnology {
  id: string;
  name: string;
  category: TechCategory;
  version: string | null;
  confidence: "high" | "medium" | "low";
  detectedBy: string;
  website?: string;
  icon?: string;
}
