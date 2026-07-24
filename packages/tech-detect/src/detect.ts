import type { DetectedTechnology, Detector, TechDetectInput, TechFingerprint } from "./types";
import { ALL_FINGERPRINTS } from "./fingerprints";

function matchDetector(detector: Detector, input: TechDetectInput): boolean {
  switch (detector.type) {
    case "header": {
      const value = input.headers[detector.name] ?? input.headers[detector.name.toLowerCase()];
      return value != null && detector.pattern.test(value);
    }
    case "meta": {
      const value = input.meta?.[detector.name] ?? input.meta?.[detector.name.toLowerCase()];
      return value != null && detector.pattern.test(value);
    }
    case "script-url":
      if (input.scripts) {
        return input.scripts.some((s) => s.url && detector.pattern.test(s.url));
      }
      // Fallback: scan HTML for script src attributes
      return detector.pattern.test(input.html);
    case "script-content":
      if (input.scripts?.some((s) => s.content && detector.pattern.test(s.content))) {
        return true;
      }
      // Inline scripts live in the HTML, not the fetched `scripts` array — scan
      // it too so inline init snippets (window._taboola=…, obApi(…)) match.
      // Patterns are JS-specific (global assignments / vendor calls), so the
      // false-positive risk from scanning full HTML is negligible.
      return detector.pattern.test(input.html);
    case "html":
      return detector.pattern.test(input.html);
    case "dom":
      // DOM selectors need a document — skip in headerless detection
      return false;
    case "url-path":
      // Match the page URL first, then fall back to the HTML. The HTML fallback
      // is intentional: url-path patterns are specific path SEGMENTS (e.g.
      // /wp-json/, /sites/default/files/, /media/jui/) that real fingerprints
      // rely on finding in asset/link URLs embedded in the markup — the page URL
      // itself rarely carries them. Patterns are deliberately narrow segments,
      // not bare words, to keep the HTML scan low-false-positive.
      return detector.pattern.test(input.url) || detector.pattern.test(input.html);
  }
}

function detectorLabel(detector: Detector): string {
  switch (detector.type) {
    case "header":
      return `header:${detector.name}`;
    case "meta":
      return `meta:${detector.name}`;
    case "script-url":
      return `script-url:${detector.pattern.source.slice(0, 30)}`;
    case "script-content":
      return `script-content:${detector.pattern.source.slice(0, 30)}`;
    case "html":
      return `html:${detector.pattern.source.slice(0, 30)}`;
    case "dom":
      return `dom:${detector.selector}`;
    case "url-path":
      return `url-path:${detector.pattern.source.slice(0, 30)}`;
  }
}

// Patterns like `[\d.]+` happily capture a bare "." from prose ("built with
// Next.js."). A version must contain at least one digit.
function validVersion(match: RegExpMatchArray | null): string | null {
  return match?.[1] && /\d/.test(match[1]) ? match[1] : null;
}

function extractVersion(fingerprint: TechFingerprint, input: TechDetectInput): string | null {
  if (!fingerprint.versionPattern) return null;

  // Check headers
  for (const value of Object.values(input.headers)) {
    const version = validVersion(value.match(fingerprint.versionPattern));
    if (version) return version;
  }

  // Check meta tags
  if (input.meta) {
    for (const value of Object.values(input.meta)) {
      const version = validVersion(value.match(fingerprint.versionPattern));
      if (version) return version;
    }
  }

  // Check HTML — sampled to the first 50KB. Version strings (generator meta,
  // header comments, bundle banners) live near the top of the document; the cap
  // bounds the regex work without missing them in practice.
  const htmlSample = input.html.slice(0, 51200);
  const htmlVersion = validVersion(htmlSample.match(fingerprint.versionPattern));
  if (htmlVersion) return htmlVersion;

  // Check script URLs and content
  if (input.scripts) {
    for (const script of input.scripts) {
      if (script.url) {
        const version = validVersion(script.url.match(fingerprint.versionPattern));
        if (version) return version;
      }
      if (script.content) {
        const version = validVersion(
          script.content.slice(0, 10240).match(fingerprint.versionPattern),
        );
        if (version) return version;
      }
    }
  }

  return null;
}

/**
 * Parse `<meta name=… content=…>` tags from the head sample into a name→content
 * map. `meta`-type detectors (e.g. `generator` → WordPress/Wix/Shopify) read ONLY
 * this map, never the raw HTML — so callers that don't pre-parse meta (the CLI's
 * local scan, cloud-runner's fallback) would silently miss every CMS whose primary
 * signal is the generator tag. Auto-extracting here closes that gap (#407). Both
 * attribute orders are handled — some CMSes emit `content=… name=generator`.
 */
function extractMetaFromHtml(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Quoted attributes only — unquoted generator tags are vanishingly rare.
  const sample = html.slice(0, 51200);
  const tagRe = /<meta\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(sample)) !== null) {
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag[0])?.[1];
    if (name && content !== undefined) {
      const key = name.toLowerCase();
      if (!(key in out)) out[key] = content;
    }
  }
  return out;
}

/** Detect technologies from page data. Returns all matches. */
export function detectTechnologies(
  rawInput: TechDetectInput,
  fingerprints: TechFingerprint[] = ALL_FINGERPRINTS,
): DetectedTechnology[] {
  const results: DetectedTechnology[] = [];

  // Resolve the meta map: trust a non-empty caller-supplied one, otherwise parse
  // it from the HTML so meta-type detectors fire without a separate parse step.
  const input: TechDetectInput =
    rawInput.meta && Object.keys(rawInput.meta).length > 0
      ? rawInput
      : { ...rawInput, meta: extractMetaFromHtml(rawInput.html) };

  for (const fp of fingerprints) {
    let matchedDetector: Detector | null = null;

    for (const detector of fp.detectors) {
      if (matchDetector(detector, input)) {
        matchedDetector = detector;
        break; // ANY match = detected
      }
    }

    if (matchedDetector) {
      results.push({
        id: fp.id,
        name: fp.name,
        category: fp.category,
        version: extractVersion(fp, input),
        confidence: fp.confidence ?? "high",
        detectedBy: detectorLabel(matchedDetector),
        website: fp.website,
        icon: fp.icon,
      });
    }
  }

  return results;
}
