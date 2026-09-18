import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "./server.ts";
import { LabelStore, StoreError } from "./store.ts";
import type { CapturedPage } from "./types.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "labeler-test-"));
  tempDirectories.push(dataDir);
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
    screenshotUrl: "/captures/page_1234567890abcdef12345678.png",
    split: "training-review",
    nodes: [
      {
        id: "node_1234567890abcdef12345678",
        parentId: null,
        tag: "main",
        role: "main",
        text: "Example body",
        selector: "html > body:nth-of-type(1) > main:nth-of-type(1)",
        rect: { x: 0, y: 0, width: 400, height: 100 },
        depth: 2,
        suggestion: { role: "main_content", provenance: "weak", reason: "ARIA role main" },
      },
      {
        id: "node_abcdef1234567890abcdef12",
        parentId: "node_1234567890abcdef12345678",
        tag: "div",
        role: null,
        text: "Undetermined element",
        selector: "html > body:nth-of-type(1) > main:nth-of-type(1) > div:nth-of-type(1)",
        rect: { x: 0, y: 100, width: 100, height: 30 },
        depth: 3,
        suggestion: null,
      },
      {
        id: "node_7890abcdef1234567890abcd",
        parentId: "node_1234567890abcdef12345678",
        tag: "nav",
        role: null,
        text: "Documentation",
        selector: "html > body:nth-of-type(1) > main:nth-of-type(1) > nav:nth-of-type(1)",
        rect: { x: 0, y: 140, width: 100, height: 30 },
        depth: 3,
        suggestion: { role: "navigation", provenance: "weak", reason: "semantic <nav>" },
      },
    ],
  };
  store.writeCapture(page, new Uint8Array([137, 80, 78, 71]));
  return { dataDir, store, page };
}

describe("human label storage", () => {
  test("persists a human annotation once and preserves idempotent retries", () => {
    const { store, page } = fixture();
    const input = {
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label" as const,
      role: "main_content" as const,
      context: "main" as const,
      boundary: "correct" as const,
      comment: "Primary prose",
      clientRequestId: "request_12345678",
      captureHash: page.captureHash,
    };
    const first = store.saveAnnotation(input);
    const retry = store.saveAnnotation(input);
    expect(retry).toEqual(first);
    expect(store.readAnnotations()).toEqual([first]);
    expect(first.source).toBe("human");
    expect(first.gold).toBeFalse();
  });

  test("rejects unknown nodes and stale capture hashes", () => {
    const { store, page } = fixture();
    const base = {
      pageId: page.id,
      decision: "unsure" as const,
      boundary: "unsure" as const,
      clientRequestId: "request_12345678",
    };
    expect(() =>
      store.saveAnnotation({
        ...base,
        nodeId: "node_aaaaaaaaaaaaaaaaaaaaaaaa",
        captureHash: page.captureHash,
      }),
    ).toThrow(StoreError);
    expect(() =>
      store.saveAnnotation({
        ...base,
        nodeId: page.nodes[0]!.id,
        captureHash: `sha256:${"c".repeat(64)}`,
      }),
    ).toThrow("Capture is stale");
  });

  test("enforces suggestion acceptance and append-only revisions", () => {
    const { store, page } = fixture();
    const base = {
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      boundary: "correct" as const,
      clientRequestId: "request_12345678",
      captureHash: page.captureHash,
    };
    expect(() => store.saveAnnotation({ ...base, decision: "accept", role: "card" })).toThrow(
      "current weak suggestion",
    );
    const accepted = store.saveAnnotation({ ...base, decision: "accept", role: "main_content" });
    expect(() =>
      store.saveAnnotation({
        ...base,
        decision: "reject",
        role: "main_content",
        clientRequestId: "request_abcdefgh",
      }),
    ).toThrow("cannot carry");
    expect(() =>
      store.saveAnnotation({
        ...base,
        decision: "label",
        role: "card",
        clientRequestId: "request_abcdefgh",
        supersedes: "ann_00000000-0000-0000-0000-000000000000",
      }),
    ).toThrow("supersedes");
    const revised = store.saveAnnotation({
      ...base,
      decision: "label",
      role: "card",
      clientRequestId: "request_abcdefgh",
      supersedes: accepted.id,
    });
    expect(revised.supersedes).toBe(accepted.id);
    expect(store.listPages()[0]!.reviewedCount).toBe(1);
    expect(() =>
      store.saveAnnotation({ ...base, decision: "label", role: "main_content" }),
    ).toThrow("clientRequestId");
  });

  test("keeps uncertain answers unlabeled and records capture attempts", () => {
    const { store, page } = fixture();
    const base = {
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      boundary: "unsure" as const,
      clientRequestId: "request_12345678",
    };
    expect(() => store.saveAnnotation({ ...base, decision: "unsure", role: "card" })).toThrow(
      "Unsure decisions cannot carry",
    );
    store.recordCaptureAttempt(page.url, "failed", "network\nfailed");
    expect(readFileSync(store.captureAttemptsPath, "utf8")).toContain('"reason":"network failed"');
  });

  test("only permits rejection of a concrete weak suggestion", () => {
    const { store, page } = fixture();
    expect(() =>
      store.saveAnnotation({
        pageId: page.id,
        nodeId: page.nodes[1]!.id,
        decision: "reject",
        boundary: "unsure",
        clientRequestId: "request_12345678",
      }),
    ).toThrow("Reject requires a current weak suggestion");
  });

  test("persists independent region and function labels without losing a rejected hint", () => {
    const { store, page } = fixture();
    const labeled = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      regions: ["footer"],
      functions: ["navigation"],
      boundary: "correct",
      clientRequestId: "request_12345678",
    });
    expect(labeled.labelSchemaVersion).toBe(2);
    expect(labeled.regions).toEqual(["footer"]);
    expect(labeled.functions).toEqual(["navigation"]);
    const rejectedNavigation = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[2]!.id,
      decision: "reject",
      regions: ["footer"],
      functions: [],
      context: "footer",
      boundary: "correct",
      clientRequestId: "request_abcdefgh",
    });
    expect(rejectedNavigation.regions).toEqual(["footer"]);
    expect(rejectedNavigation.functions).toEqual([]);
    expect(rejectedNavigation.context).toBe("footer");
    const acceptedNavigation = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[2]!.id,
      decision: "accept",
      regions: ["footer"],
      functions: ["navigation"],
      boundary: "correct",
      clientRequestId: "request_abcdefgh2",
      supersedes: rejectedNavigation.id,
    });
    expect(acceptedNavigation.regions).toEqual(["footer"]);
    expect(acceptedNavigation.functions).toEqual(["navigation"]);
  });

  test("hydrates legacy role and context as a version-one compatibility projection", () => {
    const { store, page } = fixture();
    const legacy = {
      id: "ann_00000000-0000-0000-0000-000000000000",
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      role: "navigation",
      context: "footer",
      comment: null,
      boundary: "correct",
      clientRequestId: "legacy_request_123",
      captureHash: page.captureHash,
      supersedes: null,
      source: "human",
      gold: false,
      timestamp: "2026-09-18T00:00:00.000Z",
    };
    appendFileSync(store.annotationsPath, `${JSON.stringify(legacy)}\n`);
    const hydrated = store.readAnnotations()[0]!;
    expect(hydrated.labelSchemaVersion).toBe(1);
    expect(hydrated.regions).toEqual(["footer"]);
    expect(hydrated.functions).toEqual(["navigation"]);
    expect(hydrated.purposes).toEqual([]);
    expect(hydrated.purposeProjection).toEqual({
      purposes: ["navigation"],
      provenance: "legacy-v1-v2",
    });
    expect(readFileSync(store.annotationsPath, "utf8")).not.toContain('"regions"');
  });

  test("keeps a legacy accept's defensible context projection", () => {
    const { store, page } = fixture();
    const accepted = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[2]!.id,
      decision: "accept",
      role: "navigation",
      context: "footer",
      boundary: "correct",
      clientRequestId: "request_12345678",
    });
    expect(accepted.regions).toEqual(["footer"]);
    expect(accepted.functions).toEqual(["navigation"]);
  });

  test("stores observed component types, bounded subtypes, states, and purposes", () => {
    const { store, page } = fixture();
    const button = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      componentType: "button",
      componentSubtype: "primary",
      observedState: ["disabled"],
      purposes: ["submit"],
      boundary: "correct",
      clientRequestId: "request_12345678",
    });
    expect(button.componentSchemaVersion).toBe(3);
    expect(button).toMatchObject({
      componentType: "button",
      componentSubtype: "primary",
      observedState: ["disabled"],
      purposes: ["submit"],
      componentProjection: null,
    });
    const footerMenu = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[2]!.id,
      decision: "label",
      regions: ["footer"],
      componentType: "navigation_menu",
      componentSubtype: "footer",
      observedState: ["sticky"],
      purposes: ["navigation"],
      boundary: "correct",
      clientRequestId: "request_abcdefgh",
    });
    expect(footerMenu.regions).toEqual(["footer"]);
    expect(footerMenu.purposes).toEqual(["navigation"]);
    const acceptedNavigation = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[2]!.id,
      decision: "accept",
      regions: ["footer"],
      functions: [],
      componentType: "navigation_menu",
      componentSubtype: "footer",
      purposes: ["navigation"],
      boundary: "correct",
      clientRequestId: "request_abcdefgh_accept",
      supersedes: footerMenu.id,
    });
    expect(acceptedNavigation.functions).toEqual([]);
    expect(acceptedNavigation.purposes).toEqual(["navigation"]);
    const form = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[1]!.id,
      decision: "label",
      componentType: "form",
      componentSubtype: "search",
      purposes: ["search"],
      boundary: "correct",
      clientRequestId: "request_abcdefgh2",
    });
    expect(form).toMatchObject({ componentType: "form", componentSubtype: "search" });
    expect(() =>
      store.saveAnnotation({
        pageId: page.id,
        nodeId: page.nodes[1]!.id,
        decision: "label",
        componentType: "form",
        componentSubtype: "primary",
        boundary: "correct",
        clientRequestId: "request_abcdefgh3",
      }),
    ).toThrow("Invalid componentSubtype");
  });

  test("projects legacy card data without rewriting the exported JSONL", async () => {
    const { store, page } = fixture();
    const legacy = {
      id: "ann_00000000-0000-0000-0000-000000000000",
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      role: "card",
      context: null,
      comment: null,
      boundary: "correct",
      clientRequestId: "legacy_request_123",
      captureHash: page.captureHash,
      supersedes: null,
      source: "human",
      gold: false,
      timestamp: "2026-09-18T00:00:00.000Z",
    };
    appendFileSync(store.annotationsPath, `${JSON.stringify(legacy)}\n`);
    const projected = store.readAnnotations()[0]!;
    expect(projected.componentType).toBeNull();
    expect(projected.componentProjection).toEqual({
      componentType: "card",
      provenance: "legacy-v1-v2",
    });
    const exported = await handleRequest(
      new Request("http://127.0.0.1:4317/api/export", { headers: { host: "127.0.0.1:4317" } }),
      store,
    );
    expect(await exported.text()).toBe(`${JSON.stringify(legacy)}\n`);
  });
});

describe("labeler HTTP contract", () => {
  test("keeps model sidecars separate and binds human reviews to exact immutable predictions", async () => {
    const { store, page } = fixture();
    const nodeSuggestion = {
      schemaVersion: 1,
      id: "msug_00000000-0000-0000-0000-000000000001",
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      captureHash: page.captureHash,
      provider: "typesafe",
      modelId: "jev",
      modelRevision: "1.13.0",
      promptRevision: "dom-suggestions-v1",
      snapshotHash: `sha256:${"d".repeat(64)}`,
      rawAnswers: { regions: { footer: true } },
      provisional: true,
      mappedLabels: { regions: ["footer"], purposes: ["navigation"] },
      axisProbabilities: {
        regions: [{ label: "footer", yesProbability: 0.91 }],
        purposes: [{ label: "navigation", yesProbability: 0.88 }],
      },
      componentTypeChoice: {
        choice: "navigation_menu",
        distribution: [{ label: "navigation_menu", probability: 0.72 }],
        confidence: 0.72,
      },
      createdAt: "2026-09-18T00:00:00.000Z",
    };
    const pageSuggestion = {
      ...nodeSuggestion,
      id: "msug_00000000-0000-0000-0000-000000000002",
      nodeId: null,
      mappedLabels: { pageTypes: ["homepage"], contentKinds: ["software"] },
      axisProbabilities: {
        pageTypes: [{ label: "homepage", yesProbability: 0.83 }],
        contentKinds: [{ label: "software", yesProbability: 0.77 }],
      },
      componentTypeChoice: undefined,
    };
    const staleSuggestion = {
      ...nodeSuggestion,
      id: "msug_00000000-0000-0000-0000-000000000003",
      captureHash: `sha256:${"e".repeat(64)}`,
    };
    appendFileSync(
      store.modelSuggestionsPath,
      `${JSON.stringify(nodeSuggestion)}\n${JSON.stringify(pageSuggestion)}\n${JSON.stringify(staleSuggestion)}\n`,
    );
    const detail = await handleRequest(
      new Request(`http://127.0.0.1:4317/api/pages/${page.id}`, {
        headers: { host: "127.0.0.1:4317" },
      }),
      store,
    );
    const detailBody = (await detail.json()) as {
      modelSuggestions: Array<{ id: string; nodeId: string | null }>;
    };
    expect(detailBody.modelSuggestions).toEqual([
      expect.objectContaining({ id: nodeSuggestion.id, nodeId: page.nodes[0]!.id }),
      expect.objectContaining({ id: pageSuggestion.id, nodeId: null }),
    ]);
    expect(store.readAnnotations()).toEqual([]);
    const accepted = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      regions: ["footer"],
      purposes: ["navigation"],
      boundary: "correct",
      clientRequestId: "model_accept_12345678",
      modelSuggestionId: nodeSuggestion.id,
      modelReview: "accept",
    });
    expect(accepted).toMatchObject({ modelSuggestionId: nodeSuggestion.id, modelReview: "accept" });
    expect(
      store.saveAnnotation({
        pageId: page.id,
        nodeId: page.nodes[0]!.id,
        decision: "label",
        regions: ["footer"],
        purposes: ["navigation"],
        boundary: "correct",
        clientRequestId: "model_accept_12345678",
        modelSuggestionId: nodeSuggestion.id,
        modelReview: "accept",
      }),
    ).toEqual(accepted);
    expect(() =>
      store.saveAnnotation({
        pageId: page.id,
        nodeId: page.nodes[0]!.id,
        decision: "label",
        regions: ["footer"],
        boundary: "correct",
        clientRequestId: "model_bad_accept_123",
        modelSuggestionId: nodeSuggestion.id,
        modelReview: "accept",
      }),
    ).toThrow("mapped labels");
    const cookie = detail.headers.get("set-cookie")!.split(";")[0]!;
    const token = cookie.split("=")[1]!;
    const reviewHeaders = {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      cookie,
      "x-labeler-csrf": token,
      "content-type": "application/json",
    };
    const rejectionPayload = {
      pageId: page.id,
      nodeId: null,
      modelSuggestionId: pageSuggestion.id,
      review: "reject",
      comment: "This is a marketing page, not software documentation.",
      clientRequestId: "model_reject_12345678",
      captureHash: page.captureHash,
    };
    const humanExportBeforeReview = store.rawAnnotationsJsonl();
    const rejectionResponse = await handleRequest(
      new Request("http://127.0.0.1:4317/api/model-reviews", {
        method: "POST",
        headers: reviewHeaders,
        body: JSON.stringify(rejectionPayload),
      }),
      store,
    );
    expect(rejectionResponse.status).toBe(201);
    const rejection = (await rejectionResponse.json()) as {
      modelReview: { id: string; modelSuggestionId: string; review: string };
    };
    expect(rejection.modelReview).toMatchObject({
      modelSuggestionId: pageSuggestion.id,
      review: "reject",
    });
    expect(readFileSync(store.modelReviewsPath, "utf8")).toContain(rejection.modelReview.id);
    const retry = await handleRequest(
      new Request("http://127.0.0.1:4317/api/model-reviews", {
        method: "POST",
        headers: reviewHeaders,
        body: JSON.stringify(rejectionPayload),
      }),
      store,
    );
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { modelReview: { id: string } }).modelReview.id).toBe(
      rejection.modelReview.id,
    );
    expect(store.rawAnnotationsJsonl()).toBe(humanExportBeforeReview);
    const staleResponse = await handleRequest(
      new Request("http://127.0.0.1:4317/api/model-reviews", {
        method: "POST",
        headers: reviewHeaders,
        body: JSON.stringify({
          ...rejectionPayload,
          nodeId: page.nodes[0]!.id,
          modelSuggestionId: staleSuggestion.id,
          clientRequestId: "model_stale_12345678",
        }),
      }),
      store,
    );
    expect(staleResponse.status).toBe(400);
    expect(store.readAnnotations()).toHaveLength(1);
    expect(store.modelReviewsForPage(page.id)).toEqual([
      expect.objectContaining(rejection.modelReview),
    ]);
  });

  test("requires a same-origin CSRF token to write", async () => {
    const { store, page } = fixture();
    const first = await handleRequest(
      new Request("http://127.0.0.1:4317/api/pages", { headers: { host: "127.0.0.1:4317" } }),
      store,
    );
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const token = cookie.split("=")[1]!;
    const payload = {
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "reject",
      boundary: "too_broad",
      clientRequestId: "request_abcdefgh",
      captureHash: page.captureHash,
    };
    const denied = await handleRequest(
      new Request("http://127.0.0.1:4317/api/annotations", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4317",
          origin: "http://127.0.0.1:4317",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
      store,
    );
    expect(denied.status).toBe(403);
    const saved = await handleRequest(
      new Request("http://127.0.0.1:4317/api/annotations", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4317",
          origin: "http://127.0.0.1:4317",
          cookie,
          "x-labeler-csrf": token,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
      store,
    );
    expect(saved.status).toBe(201);
    expect(((await saved.json()) as { annotation: { decision: string } }).annotation.decision).toBe(
      "reject",
    );
  });

  test("publishes and validates the independent multi-label axes", async () => {
    const { store, page } = fixture();
    const initial = await handleRequest(
      new Request("http://127.0.0.1:4317/api/pages", { headers: { host: "127.0.0.1:4317" } }),
      store,
    );
    const list = (await initial.json()) as {
      regions: string[];
      functions: string[];
      componentTypes: string[];
      purposes: string[];
      statefulComponentTypes: Record<string, string[]>;
    };
    expect(list.regions).toContain("sidebar");
    expect(list.functions).toContain("navigation");
    expect(list.componentTypes).toContain("button");
    expect(list.purposes).toContain("submit");
    expect(list.statefulComponentTypes.selected).toContain("tabs");
    const cookie = initial.headers.get("set-cookie")!.split(";")[0]!;
    const token = cookie.split("=")[1]!;
    const saved = await handleRequest(
      new Request("http://127.0.0.1:4317/api/annotations", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4317",
          origin: "http://127.0.0.1:4317",
          cookie,
          "x-labeler-csrf": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          pageId: page.id,
          nodeId: page.nodes[0]!.id,
          decision: "label",
          regions: ["footer"],
          functions: ["navigation"],
          componentType: "navigation_menu",
          componentSubtype: "footer",
          observedState: ["sticky"],
          purposes: ["navigation"],
          boundary: "correct",
          clientRequestId: "request_abcdefgh",
        }),
      }),
      store,
    );
    expect(saved.status).toBe(201);
    expect(
      (
        (await saved.json()) as {
          annotation: {
            regions: string[];
            functions: string[];
            componentType: string;
            purposes: string[];
          };
        }
      ).annotation,
    ).toMatchObject({
      regions: ["footer"],
      functions: ["navigation"],
      componentType: "navigation_menu",
      purposes: ["navigation"],
    });
  });

  test("saves, reads, revises, and validates page-level labels through the API", async () => {
    const { store, page } = fixture();
    const initial = await handleRequest(
      new Request("http://127.0.0.1:4317/api/pages", { headers: { host: "127.0.0.1:4317" } }),
      store,
    );
    const catalog = (await initial.json()) as {
      pageTypes: string[];
      pageTypeGroups: Array<{ id: string; values: string[] }>;
      contentKinds: string[];
    };
    expect(catalog.pageTypes).toContain("blog_post");
    expect(catalog.pageTypes).toContain("landing_page");
    expect(catalog.contentKinds).toContain("product");
    expect(catalog.pageTypeGroups.find((group) => group.id === "publishing")?.values).toContain(
      "blog_post",
    );
    const cookie = initial.headers.get("set-cookie")!.split(";")[0]!;
    const token = cookie.split("=")[1]!;
    const headers = {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      cookie,
      "x-labeler-csrf": token,
      "content-type": "application/json",
    };
    const first = await handleRequest(
      new Request("http://127.0.0.1:4317/api/page-annotations", {
        method: "POST",
        headers,
        body: JSON.stringify({
          pageId: page.id,
          decision: "label",
          pageTypes: ["blog_post"],
          contentKinds: ["article"],
          comment: "A published post",
          clientRequestId: "page_request_12345678",
          captureHash: page.captureHash,
        }),
      }),
      store,
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { annotation: { id: string; pageTypes: string[] } };
    expect(firstBody.annotation.pageTypes).toEqual(["blog_post"]);
    const retry = await handleRequest(
      new Request("http://127.0.0.1:4317/api/page-annotations", {
        method: "POST",
        headers,
        body: JSON.stringify({
          pageId: page.id,
          decision: "label",
          pageTypes: ["blog_post"],
          contentKinds: ["article"],
          comment: "A published post",
          clientRequestId: "page_request_12345678",
          captureHash: page.captureHash,
        }),
      }),
      store,
    );
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { annotation: { id: string } }).annotation.id).toBe(
      firstBody.annotation.id,
    );
    const revision = await handleRequest(
      new Request("http://127.0.0.1:4317/api/page-annotations", {
        method: "POST",
        headers,
        body: JSON.stringify({
          pageId: page.id,
          decision: "label",
          pageTypes: ["news_article"],
          contentKinds: ["article"],
          clientRequestId: "page_request_abcdefgh",
          supersedes: firstBody.annotation.id,
        }),
      }),
      store,
    );
    expect(revision.status).toBe(201);
    const detail = await handleRequest(
      new Request(`http://127.0.0.1:4317/api/pages/${page.id}`, {
        headers: { host: "127.0.0.1:4317" },
      }),
      store,
    );
    expect(((await detail.json()) as { pageAnnotations: unknown[] }).pageAnnotations).toHaveLength(
      2,
    );
    const invalid = await handleRequest(
      new Request("http://127.0.0.1:4317/api/page-annotations", {
        method: "POST",
        headers,
        body: JSON.stringify({
          pageId: page.id,
          decision: "label",
          pageTypes: ["unknown", "homepage"],
          clientRequestId: "page_request_invalid",
        }),
      }),
      store,
    );
    expect(invalid.status).toBe(400);
  });
});
