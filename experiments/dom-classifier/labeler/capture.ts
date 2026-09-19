import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { CapturedNode, CapturedPage, Role } from "./types.ts";
import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.ts";
import { LabelStore } from "./store.ts";

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 } as const;
export const MAX_CAPTURE_HEIGHT = 12_000;
export const MAX_LAZY_LOAD_STEPS = 20;
export const MAX_CAPTURE_TIMEOUT_MS = 60_000;

/** A deliberately finite, public-only seed set. This is not a crawler. */
export const SEED_URLS = [
  "https://squirrelscan.com/",
  "https://taskmux.dev/",
  "https://example.com/",
  "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/nav",
] as const;

/** Private queue input. It contains provenance only, never archived HTML. */
export type CorpusCaptureTarget = {
  url: string;
  originalCrawledAt?: string;
  corpusRef?: string;
};

type RawNode = Omit<CapturedNode, "id" | "parentId" | "suggestion"> & { selector: string };
type CaptureOptions = {
  maxHeight?: number;
  maxLazyLoadSteps?: number;
  timeoutMs?: number;
};

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function weakSuggestion(node: RawNode): CapturedNode["suggestion"] {
  const tagRole: Record<string, Role> = {
    header: "site_header",
    footer: "footer",
    nav: "navigation",
    main: "main_content",
    article: "main_content",
    aside: "aside",
    form: "form",
  };
  const ariaRole: Record<string, Role> = {
    banner: "site_header",
    contentinfo: "footer",
    navigation: "navigation",
    main: "main_content",
    complementary: "aside",
    form: "form",
  };
  const insideArticle = /(^| > )article:nth-of-type\(\d+\) > /.test(node.selector);
  if (node.tag === "header" && insideArticle)
    return { role: "article_header", provenance: "weak", reason: "header nested in article" };
  const consentCue = /\b(cookie|consent|privacy|your choices|data preferences)\b/i.test(node.text);
  const role =
    consentCue && (node.role === "dialog" || node.role === "alertdialog")
      ? "consent_banner"
      : ((node.role ? ariaRole[node.role] : undefined) ?? tagRole[node.tag]);
  return role
    ? {
        role,
        provenance: "weak",
        reason: node.role ? `ARIA role ${node.role}` : `semantic <${node.tag}>`,
      }
    : null;
}

function nodeId(selector: string) {
  return `node_${digest(selector).slice(0, 24)}`;
}

export function pngDimensions(png: Uint8Array) {
  if (
    png.length < 24 ||
    png[0] !== 0x89 ||
    png[1] !== 0x50 ||
    png[2] !== 0x4e ||
    png[3] !== 0x47 ||
    png[12] !== 0x49 ||
    png[13] !== 0x48 ||
    png[14] !== 0x44 ||
    png[15] !== 0x52
  ) {
    throw new Error("Browser did not return a PNG screenshot");
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Capture a bounded full-page raster without changing the page scroll origin. */
export async function capturePixels(
  page: any,
  documentHeight: number,
  maxHeight = MAX_CAPTURE_HEIGHT,
  timeoutMs = MAX_CAPTURE_TIMEOUT_MS,
) {
  const expectedHeight = Math.max(1, Math.min(maxHeight, Math.ceil(documentHeight)));
  const cdp = await page.context().newCDPSession(page);
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: expectedHeight, scale: 1 },
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Screenshot exceeded capture deadline")),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    const screenshot = Buffer.from(response.data, "base64");
    const dimensions = pngDimensions(screenshot);
    if (dimensions.width !== VIEWPORT.width || dimensions.height !== expectedHeight)
      throw new Error("Screenshot dimensions do not match the bounded document");
    return screenshot;
  } finally {
    void cdp.detach().catch(() => undefined);
  }
}

export function clipNodes(nodes: CapturedNode[], width: number, height: number) {
  const clipped = nodes.flatMap((node) => {
    const x = Math.max(0, Math.min(node.rect.x, width));
    const y = Math.max(0, Math.min(node.rect.y, height));
    const right = Math.max(x, Math.min(node.rect.x + node.rect.width, width));
    const bottom = Math.max(y, Math.min(node.rect.y + node.rect.height, height));
    if (right - x < 1 || bottom - y < 1) return [];
    return [{ ...node, rect: { x, y, width: right - x, height: bottom - y } }];
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const included = new Set(clipped.map((node) => node.id));
  return clipped.map((node) => {
    let parentId = node.parentId;
    while (parentId && !included.has(parentId)) parentId = byId.get(parentId)?.parentId ?? null;
    return parentId === node.parentId ? node : { ...node, parentId };
  });
}

function normalizedPublicUrl(raw: string) {
  if (raw.length < 1 || raw.length > 2_048) throw new Error("Invalid public capture URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid public capture URL");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
    throw new Error("Only public HTTPS URLs may be captured");
  if (isPrivateHostname(url.hostname)) throw new Error("Private network URL is not allowed");
  url.hash = "";
  url.search = "";
  return url;
}

function isPrivateHostname(hostname: string) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const mappedIpv4 = ipv4MappedAddress(host);
  if (mappedIpv4) return isPrivateHostname(mappedIpv4);
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd"))
    return true;
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((value) => !/^\d{1,3}$/.test(value))) return false;
  const numbers = octets.map(Number);
  if (numbers.some((value) => value > 255)) return true;
  const [first, second] = numbers;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

/** Canonical URL hosts render mapped IPv4 as hex (for example ::ffff:7f00:1). */
function ipv4MappedAddress(host: string) {
  if (!host.startsWith("::ffff:")) return null;
  const suffix = host.slice("::ffff:".length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(suffix)) return suffix;
  const groups = suffix.split(":");
  if (!groups.length || groups.length > 2 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group)))
    return null;
  const hex = groups.map((group) => group.padStart(4, "0")).join("");
  if (hex.length !== 8) return null;
  const value = Number.parseInt(hex, 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

async function assertPublicDns(url: URL) {
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Public capture hostname could not be resolved");
  }
  if (!addresses.length || addresses.some((entry) => isPrivateHostname(entry.address)))
    throw new Error("Public capture hostname resolves to a private address");
}

export function normalizeCorpusCaptureTarget(value: unknown): CorpusCaptureTarget {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid corpus capture target");
  if (Object.keys(value).some((key) => !["url", "originalCrawledAt", "corpusRef"].includes(key)))
    throw new Error("Unknown corpus capture target field");
  const target = value as CorpusCaptureTarget;
  if (typeof target.url !== "string") throw new Error("Invalid public capture URL");
  if (
    target.originalCrawledAt !== undefined &&
    (typeof target.originalCrawledAt !== "string" ||
      Number.isNaN(Date.parse(target.originalCrawledAt)))
  )
    throw new Error("Invalid originalCrawledAt");
  if (
    target.corpusRef !== undefined &&
    (typeof target.corpusRef !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(target.corpusRef))
  )
    throw new Error("Invalid corpusRef");
  return {
    url: normalizedPublicUrl(target.url).href,
    ...(target.originalCrawledAt === undefined
      ? {}
      : { originalCrawledAt: target.originalCrawledAt }),
    ...(target.corpusRef === undefined ? {} : { corpusRef: target.corpusRef }),
  };
}

export async function captureSeedPages(store: LabelStore, urls = SEED_URLS) {
  const captures: CapturedPage[] = [];
  for (const url of urls) {
    try {
      const capture = await capturePage(store, url);
      store.recordCaptureAttempt(url, "captured", null);
      captures.push(capture);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown capture error";
      store.recordCaptureAttempt(url, "failed", reason);
      console.warn(`Capture failed for ${url}: ${reason}`);
    }
  }
  return captures;
}

/** Captures only a member of the fixed seed set. */
export async function capturePage(store: LabelStore, url: string): Promise<CapturedPage> {
  if (!SEED_URLS.includes(url as (typeof SEED_URLS)[number]))
    throw new Error("Only the fixed public seed URLs may be captured");
  return captureCorpusTarget(store, { url });
}

/**
 * Captures a validated manifest row. This function is intentionally only used
 * by the private command-line queue runner, never by the labeler HTTP server.
 */
export async function captureCorpusTarget(
  store: LabelStore,
  target: CorpusCaptureTarget,
  options: CaptureOptions = {},
): Promise<CapturedPage> {
  const normalizedTarget = normalizeCorpusCaptureTarget(target);
  const requestedUrl = new URL(normalizedTarget.url);
  await assertPublicDns(requestedUrl);
  const maxHeight = Math.min(
    Math.max(1, options.maxHeight ?? MAX_CAPTURE_HEIGHT),
    MAX_CAPTURE_HEIGHT,
  );
  const maxLazyLoadSteps = Math.min(
    Math.max(0, options.maxLazyLoadSteps ?? MAX_LAZY_LOAD_STEPS),
    MAX_LAZY_LOAD_STEPS,
  );
  const timeoutMs = Math.min(
    Math.max(1_000, options.timeoutMs ?? MAX_CAPTURE_TIMEOUT_MS),
    MAX_CAPTURE_TIMEOUT_MS,
  );
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error("Capture exceeded the 60 second deadline");
    return milliseconds;
  };
  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch(browserLaunchOptions());
  let context: any;
  let timedOut = false;
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    void browser.close();
  }, timeoutMs);
  try {
    try {
      context = await browser.newContext({
        viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
        deviceScaleFactor: VIEWPORT.deviceScaleFactor,
        userAgent: "SquirrelScan DOM labeling capture/1.0",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(Math.min(30_000, remaining()));
      await page.goto(requestedUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(30_000, remaining()),
      });
      let renderSettled: CapturedPage["renderSettled"] = "networkidle";
      try {
        await page.waitForLoadState("networkidle", { timeout: Math.min(5_000, remaining()) });
      } catch {
        // Public pages often keep analytics connections open. The bounded DOM
        // settle below still freezes a fresh render inside the 60-second limit.
        renderSettled = "bounded_timeout";
      }
      const finalUrl = normalizedPublicUrl(page.url());
      await assertPublicDns(finalUrl);
      await page.evaluate(async (lazyLoadSteps: number) => {
        const style = document.createElement("style");
        style.textContent =
          "html,body{scroll-behavior:auto!important;scroll-snap-type:none!important}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
        document.head.append(style);
        await Promise.race([
          document.fonts?.ready ?? Promise.resolve(),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
        const step = Math.max(450, Math.floor(window.innerHeight * 0.8));
        let y = 0;
        for (let index = 0; index < lazyLoadSteps; index += 1) {
          const maximumY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          window.scrollTo(0, Math.min(y, maximumY));
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (y >= maximumY) break;
          y += step;
        }
        document.documentElement.scrollTop = 0;
        if (document.body) document.body.scrollTop = 0;
        window.scrollTo({ left: 0, top: 0, behavior: "auto" });
        for (
          let frame = 0;
          frame < 8 && (window.scrollX !== 0 || window.scrollY !== 0);
          frame += 1
        ) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          document.documentElement.scrollTop = 0;
          if (document.body) document.body.scrollTop = 0;
          window.scrollTo({ left: 0, top: 0, behavior: "auto" });
        }
        if (window.scrollX !== 0 || window.scrollY !== 0)
          throw new Error("Could not settle capture at page origin");
      }, maxLazyLoadSteps);
      remaining();
      const result = await page.evaluate(() => {
        const cleanText = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 280);
        const cleanRole = (value: string | null) =>
          value && /^[a-z][a-z-]{0,78}$/i.test(value) ? value.toLowerCase() : null;
        const selectorFor = (element: Element) => {
          const pieces: string[] = [];
          for (
            let current: Element | null = element;
            current && current.nodeType === Node.ELEMENT_NODE;
            current = current.parentElement
          ) {
            const tag = current.tagName.toLowerCase();
            if (tag === "html") {
              pieces.unshift("html");
              break;
            }
            const peers = current.parentElement
              ? Array.from(current.parentElement.children).filter(
                  (item) => item.tagName === current!.tagName,
                )
              : [current];
            pieces.unshift(`${tag}:nth-of-type(${peers.indexOf(current) + 1})`);
          }
          return pieces.join(" > ");
        };
        const raw: RawNode[] = [];
        const byElement = new Map<Element, number>();
        for (const element of Array.from(document.querySelectorAll("body, body *"))) {
          if (raw.length >= 5_000) break;
          const computed = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (
            computed.display === "none" ||
            computed.visibility === "hidden" ||
            Number(computed.opacity) === 0 ||
            rect.width < 2 ||
            rect.height < 2
          )
            continue;
          const tag = element.tagName.toLowerCase();
          if (
            ["script", "style", "noscript", "template", "svg", "path", "meta", "link"].includes(tag)
          )
            continue;
          const parentIndex = element.parentElement
            ? byElement.get(element.parentElement)
            : undefined;
          const item = {
            tag: tag.slice(0, 40),
            role: cleanRole(element.getAttribute("role")),
            text: cleanText(element.textContent ?? ""),
            selector: selectorFor(element),
            rect: {
              x: Math.round(rect.x + window.scrollX),
              y: Math.round(rect.y + window.scrollY),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            depth: 0,
            parentIndex: parentIndex ?? null,
          };
          let depth = 0;
          for (let parent = element.parentElement; parent; parent = parent.parentElement)
            depth += 1;
          if (item.selector.length > 1_000 || depth > 160) continue;
          raw.push({ ...item, depth } as RawNode & { parentIndex: number | null });
          byElement.set(element, raw.length - 1);
        }
        const root = document.documentElement;
        return {
          title: cleanText(document.title) || new URL(location.href).hostname,
          html: root.outerHTML,
          documentHeight: Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0),
          nodes: raw,
        };
      });
      const contentHash = `sha256:${digest(result.html)}`;
      const indexed = result.nodes as Array<RawNode & { parentIndex: number | null }>;
      const nodes: CapturedNode[] = indexed.map((node) => ({
        id: nodeId(node.selector),
        parentId: node.parentIndex === null ? null : nodeId(indexed[node.parentIndex]!.selector),
        tag: node.tag,
        role: node.role,
        text: node.text,
        selector: node.selector,
        rect: node.rect,
        depth: node.depth,
        suggestion: weakSuggestion(node),
      }));
      const screenshot = await capturePixels(page, result.documentHeight, maxHeight, remaining());
      remaining();
      const dimensions = pngDimensions(screenshot);
      const originAfterScreenshot = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
      }));
      if (originAfterScreenshot.x !== 0 || originAfterScreenshot.y !== 0)
        throw new Error("Screenshot changed the capture scroll position");
      const boundedNodes = clipNodes(nodes, dimensions.width, dimensions.height);
      const captureHash = `sha256:${digest(`${contentHash}\n${digest(screenshot)}\n${VIEWPORT.width}x${VIEWPORT.height}@${VIEWPORT.deviceScaleFactor}`)}`;
      const pageId = `page_${captureHash.slice("sha256:".length, 24 + "sha256:".length)}`;
      const captured: CapturedPage = {
        id: pageId,
        url: finalUrl.href,
        title: result.title,
        capturedAt: new Date().toISOString(),
        contentHash,
        captureHash,
        width: dimensions.width,
        height: dimensions.height,
        viewport: VIEWPORT,
        nodes: boundedNodes,
        screenshotUrl: `/captures/${pageId}.png`,
        split: "training-review",
        documentHeight: Math.ceil(result.documentHeight),
        heightCapped: result.documentHeight > dimensions.height,
        renderSettled,
        sourceKind: "fresh_capture",
        originalCrawledAt: normalizedTarget.originalCrawledAt ?? null,
        sourceUrl: requestedUrl.href,
        corpusRef: normalizedTarget.corpusRef ?? null,
        assetMode: "live",
      };
      store.writeCapture(captured, screenshot);
      return captured;
    } catch (error) {
      if (timedOut) throw new Error("Capture exceeded the 60 second deadline");
      throw error;
    }
  } finally {
    clearTimeout(deadlineTimer);
    void context?.close().catch(() => undefined);
    void browser.close().catch(() => undefined);
  }
}
