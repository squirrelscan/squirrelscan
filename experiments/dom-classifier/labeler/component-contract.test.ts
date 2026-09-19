import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "./server.ts";
import { LabelStore } from "./store.ts";
import type { CapturedPage } from "./types.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "labeler-component-contract-"));
  temporaryDirectories.push(dataDir);
  const store = new LabelStore(dataDir);
  const page: CapturedPage = {
    id: "page_1234567890abcdef12345678",
    url: "https://example.com/",
    title: "Example",
    capturedAt: "2026-09-18T00:00:00.000Z",
    contentHash: `sha256:${"a".repeat(64)}`,
    captureHash: `sha256:${"b".repeat(64)}`,
    width: 1440,
    height: 900,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    nodes: [
      {
        id: "node_1234567890abcdef12345678",
        parentId: null,
        tag: "button",
        role: null,
        text: "Subscribe",
        selector: "html > body:nth-of-type(1) > button:nth-of-type(1)",
        rect: { x: 0, y: 0, width: 120, height: 40 },
        depth: 2,
        suggestion: null,
      },
    ],
    screenshotUrl: "/captures/page_1234567890abcdef12345678.png",
    split: "training-review",
  };
  store.writeCapture(page, new Uint8Array([137, 80, 78, 71]));
  return { page, store };
}

async function request(
  store: LabelStore,
  method: "GET" | "POST",
  pathname: string,
  body?: Record<string, unknown>,
  csrf?: string,
) {
  const headers = new Headers({ host: "127.0.0.1", origin: "http://127.0.0.1" });
  if (csrf) {
    headers.set("cookie", `labeler_csrf=${csrf}`);
    headers.set("x-labeler-csrf", csrf);
  }
  if (body) {
    headers.set("content-type", "application/json");
  }
  return handleRequest(
    new Request(`http://127.0.0.1${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
    store,
  );
}

async function csrfFor(store: LabelStore) {
  const response = await request(store, "GET", "/api/pages");
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  const token = cookie?.match(/^labeler_csrf=([a-f0-9]{32});/)?.[1];
  expect(token).toBeString();
  return token!;
}

describe("component-aware annotation contract", () => {
  test("saves and reads a disabled submit button in the footer", async () => {
    const { page, store } = fixture();
    const csrf = await csrfFor(store);
    const input = {
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      regions: ["footer"],
      componentType: "button",
      componentSubtype: "primary",
      observedState: ["disabled"],
      purposes: ["submit"],
      boundary: "correct",
      clientRequestId: "request-button-v3",
      captureHash: page.captureHash,
    };
    const savedResponse = await request(store, "POST", "/api/annotations", input, csrf);
    expect(savedResponse.status).toBe(201);
    const saved = (await savedResponse.json()).annotation;
    expect(saved).toMatchObject({
      decision: "label",
      regions: ["footer"],
      componentType: "button",
      componentSubtype: "primary",
      observedState: ["disabled"],
      purposes: ["submit"],
      source: "human",
      gold: false,
    });

    const readResponse = await request(store, "GET", `/api/pages/${page.id}`);
    expect(readResponse.status).toBe(200);
    const read = await readResponse.json();
    expect(read.annotations).toHaveLength(1);
    expect(read.annotations[0]).toMatchObject({
      componentType: "button",
      observedState: ["disabled"],
      purposes: ["submit"],
      regions: ["footer"],
    });
  });

  test("rejects a subtype or state that does not match the component type", async () => {
    const { page, store } = fixture();
    const csrf = await csrfFor(store);
    const base = {
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      regions: ["footer"],
      componentType: "button",
      purposes: ["submit"],
      boundary: "correct",
      captureHash: page.captureHash,
    };

    const invalidSubtype = await request(
      store,
      "POST",
      "/api/annotations",
      { ...base, componentSubtype: "product", clientRequestId: "request-bad-subtype" },
      csrf,
    );
    expect(invalidSubtype.status).toBe(400);

    const invalidState = await request(
      store,
      "POST",
      "/api/annotations",
      {
        ...base,
        componentSubtype: "primary",
        observedState: ["expanded"],
        clientRequestId: "request-bad-state",
      },
      csrf,
    );
    expect(invalidState.status).toBe(400);
  });

  test("records hero, banner, and modal areas on independent axes", async () => {
    const { page, store } = fixture();
    const csrf = await csrfFor(store);
    const base = {
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      boundary: "correct",
      captureHash: page.captureHash,
    };
    const banner = await request(
      store,
      "POST",
      "/api/annotations",
      {
        ...base,
        regions: ["top_banner"],
        componentType: "banner",
        componentSubtype: "announcement",
        purposes: ["announcement"],
        clientRequestId: "request-top-banner",
      },
      csrf,
    );
    expect(banner.status).toBe(201);
    expect((await banner.json()).annotation).toMatchObject({
      regions: ["top_banner"],
      componentType: "banner",
      componentSubtype: "announcement",
      purposes: ["announcement"],
    });
    const consentModal = await request(
      store,
      "POST",
      "/api/annotations",
      {
        ...base,
        regions: ["overlay"],
        componentType: "dialog",
        componentSubtype: "modal",
        observedState: ["open"],
        purposes: ["consent"],
        clientRequestId: "request-consent-modal",
      },
      csrf,
    );
    expect(consentModal.status).toBe(201);
    expect((await consentModal.json()).annotation).toMatchObject({
      regions: ["overlay"],
      componentType: "dialog",
      componentSubtype: "modal",
      observedState: ["open"],
      purposes: ["consent"],
    });
    const hero = await request(
      store,
      "POST",
      "/api/annotations",
      {
        ...base,
        regions: ["hero"],
        componentType: "hero",
        purposes: ["promotion"],
        clientRequestId: "request-hero",
      },
      csrf,
    );
    expect(hero.status).toBe(201);
    expect((await hero.json()).annotation).toMatchObject({
      regions: ["hero"],
      componentType: "hero",
      purposes: ["promotion"],
    });
    const catalog = await request(store, "GET", "/api/pages");
    const values = (await catalog.json()) as {
      regions: string[];
      componentTypes: string[];
      componentSubtypes: Record<string, string[]>;
      purposes: string[];
    };
    expect(values.regions).toEqual(
      expect.arrayContaining(["hero", "top_banner", "bottom_banner", "overlay"]),
    );
    expect(values.componentTypes).toContain("popover");
    expect(values.componentSubtypes.content_section).toContain("testimonials");
    expect(values.purposes).toEqual(
      expect.arrayContaining(["promotion", "announcement", "support"]),
    );
  });

  test("exports a legacy JSONL record byte-for-byte", async () => {
    const { store } = fixture();
    const legacy = JSON.stringify({
      id: "ann_00000000-0000-0000-0000-000000000001",
      pageId: "page_1234567890abcdef12345678",
      nodeId: "node_1234567890abcdef12345678",
      decision: "label",
      role: "footer",
      context: "footer",
      boundary: "correct",
      clientRequestId: "legacy-req-1",
      captureHash: `sha256:${"b".repeat(64)}`,
      source: "human",
      gold: false,
      timestamp: "2026-09-18T00:00:00.000Z",
    });
    appendFileSync(store.annotationsPath, `${legacy}\n`);

    const response = await request(store, "GET", "/api/export");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`${legacy}\n`);
  });
});
