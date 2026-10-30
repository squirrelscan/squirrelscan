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
  | {
      type: "script-content";
      pattern: RegExp;
      inCode?: boolean;
      hint?: string;
      also?: { pattern: RegExp; hints: string[] };
    }
  // `requires`: literal that must appear in the html (case-sensitive) before the
  // pattern runs, a cheap gate for patterns that scan a bounded window per tag.
  | { type: "html"; pattern: RegExp; requires?: string }
  | { type: "dom"; selector: string }
  | { type: "url-path"; pattern: RegExp };

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
