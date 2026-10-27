// "JavaScript shipped" (squirrelscan/repo#3397): how much script an audit
// measured, which framework runtime carries it, and the heaviest pages. Pure and
// dependency-free, so the engine's report builders and the CLI's rebuild from
// storage derive the same block.

/** One script as the resource checks measured it. */
export interface JavascriptShippedInput {
  url: string;
  sizeBytes: number | null;
  status: number | null;
  /** The pages that load it (`<script src>`), by page URL. */
  sourcePages: readonly string[];
}

/** A framework runtime recognised by where its chunks are served from. */
export interface JavascriptShippedFramework {
  /** The tech-detect id: `nextjs`, `nuxt`, `astro` or `sveltekit`. */
  id: string;
  name: string;
  /** Bytes of the same-site scripts under that runtime's chunk path. */
  bytes: number;
}

export interface JavascriptShippedPage {
  url: string;
  /** Bytes of the distinct measured scripts the page loads. */
  bytes: number;
  scripts: number;
}

/**
 * REPORT-ONLY. Sizes are what the resource checks measured: a same-site script
 * counts its decoded body (or, over the fetch cap, its `Content-Length`); a
 * third-party script counts the `Content-Length` its HEAD check returned, and
 * only when third-party assets were probed. Inline scripts are not counted.
 * Absent when no script was measured.
 */
export interface JavascriptShipped {
  /** Distinct scripts with a measured size. */
  scripts: number;
  /** Their total bytes. */
  bytes: number;
  /** The share of `bytes` from third-party hosts. */
  thirdPartyBytes: number;
  /** Scripts referenced but not measured: failed, sizeless, or over the fetch cap. */
  unmeasured: number;
  /** The framework runtime carrying the most same-site bytes, when one is recognised. */
  framework?: JavascriptShippedFramework;
  /** Up to {@link JAVASCRIPT_HEAVIEST_PAGES} pages, heaviest first. */
  heaviestPages: JavascriptShippedPage[];
}

export const JAVASCRIPT_HEAVIEST_PAGES = 3;

// Chunk paths each runtime serves its own JavaScript from. Only paths no
// ordinary site uses are listed; a framework without one (Gatsby, Remix) is not
// claimed.
const FRAMEWORK_CHUNK_PATHS: ReadonlyArray<{ id: string; name: string; path: string }> = [
  { id: "nextjs", name: "Next.js", path: "/_next/static/" },
  { id: "nuxt", name: "Nuxt", path: "/_nuxt/" },
  { id: "astro", name: "Astro", path: "/_astro/" },
  { id: "sveltekit", name: "SvelteKit", path: "/_app/immutable/" },
];

function measuredSize(script: JavascriptShippedInput): number | null {
  const { sizeBytes, status } = script;
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
  if (status === null || status < 200 || status >= 300) return null;
  return Math.round(sizeBytes);
}

function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * The block for one audit, or undefined when no script was measured.
 * `unmeasuredCapped` is the number of script URLs the fetch cap left unfetched.
 */
export function buildJavascriptShipped(input: {
  sameSite: readonly JavascriptShippedInput[];
  thirdParty?: readonly JavascriptShippedInput[];
  unmeasuredCapped?: number;
}): JavascriptShipped | undefined {
  const sizes = new Map<string, number>();
  const pagesOf = new Map<string, readonly string[]>();
  const seen = new Set<string>();
  let unmeasured = Math.max(0, Math.floor(input.unmeasuredCapped ?? 0));
  let thirdPartyBytes = 0;
  const frameworkBytes = new Map<string, number>();

  const add = (script: JavascriptShippedInput, thirdParty: boolean) => {
    if (seen.has(script.url)) return;
    seen.add(script.url);
    const size = measuredSize(script);
    if (size === null) {
      unmeasured++;
      return;
    }
    sizes.set(script.url, size);
    pagesOf.set(script.url, script.sourcePages);
    if (thirdParty) {
      thirdPartyBytes += size;
      return;
    }
    const path = pathnameOf(script.url);
    const runtime = path ? FRAMEWORK_CHUNK_PATHS.find((f) => path.startsWith(f.path)) : undefined;
    if (runtime) frameworkBytes.set(runtime.id, (frameworkBytes.get(runtime.id) ?? 0) + size);
  };
  for (const script of input.sameSite) add(script, false);
  for (const script of input.thirdParty ?? []) add(script, true);

  if (sizes.size === 0) return undefined;

  let bytes = 0;
  const perPage = new Map<string, { bytes: number; scripts: number }>();
  for (const [url, size] of sizes) {
    bytes += size;
    for (const page of new Set(pagesOf.get(url) ?? [])) {
      const entry = perPage.get(page) ?? { bytes: 0, scripts: 0 };
      entry.bytes += size;
      entry.scripts += 1;
      perPage.set(page, entry);
    }
  }

  const heaviestPages = [...perPage]
    .map(([url, entry]) => ({ url, ...entry }))
    .sort((a, b) => b.bytes - a.bytes || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    .slice(0, JAVASCRIPT_HEAVIEST_PAGES);

  let framework: JavascriptShippedFramework | undefined;
  for (const runtime of FRAMEWORK_CHUNK_PATHS) {
    const runtimeBytes = frameworkBytes.get(runtime.id) ?? 0;
    if (runtimeBytes > 0 && runtimeBytes > (framework?.bytes ?? 0)) {
      framework = { id: runtime.id, name: runtime.name, bytes: runtimeBytes };
    }
  }

  return {
    scripts: sizes.size,
    bytes,
    thirdPartyBytes,
    unmeasured,
    ...(framework ? { framework } : {}),
    heaviestPages,
  };
}
