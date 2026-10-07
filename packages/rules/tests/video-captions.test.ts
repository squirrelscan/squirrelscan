// a11y/video-captions and video/video-accessible — decorative video exemption (#486).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { videoCaptionsRule } from "../src/a11y/video-captions";
import { videoAccessibleRule } from "../src/video/video-accessible";
import type { CheckResult, Rule, RuleContext } from "../src/types";

const URL = "https://example.com/";

function makeCtx(body: string): RuleContext {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Background video</title></head><body>${body}</body></html>`;
  const parsed = parsePage(html, URL);
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
  };
}

function run(rule: Rule, body: string, name: string): CheckResult {
  const checks = (rule.run(makeCtx(body)) as { checks: CheckResult[] }).checks;
  const check = checks.find((c) => c.name === name);
  expect(check).toBeDefined();
  return check as CheckResult;
}

const captions = (body: string) => run(videoCaptionsRule, body, "video-captions");
const accessible = (body: string) => run(videoAccessibleRule, body, "video-accessible");

const REPRO = `<h1>Shop</h1>\n<video src="/v.mp4" muted autoplay loop playsinline></video>`;

describe("decorative video exemption", () => {
  test("reporter repro passes in both rules and records the skip", () => {
    const c = captions(REPRO);
    expect(c.status).toBe("pass");
    expect(c.details).toEqual({ videosChecked: 1, decorativeSkipped: 1 });
    const a = accessible(REPRO);
    expect(a.status).toBe("pass");
    expect(a.details).toEqual({ videosChecked: 1, decorativeSkipped: 1 });
  });

  test("muted aria-hidden video passes in both rules", () => {
    const body = `<video src="/v.mp4" muted aria-hidden="true"></video>`;
    expect(captions(body).status).toBe("pass");
    expect(accessible(body).status).toBe("pass");
  });

  test.each([
    ["muted autoplay controls", `<video src="/v.mp4" muted autoplay controls></video>`],
    ["autoplay loop, not muted", `<video src="/v.mp4" autoplay loop></video>`],
    ["muted with no autoplay or loop", `<video src="/v.mp4" muted></video>`],
  ])("still warns in both rules: %s", (_label, body) => {
    const c = captions(body);
    expect(c.status).toBe("warn");
    expect(c.items).toHaveLength(1);
    expect(accessible(body).status).toBe("warn");
  });

  test("one decorative video and one with controls and no track: warns with count 1", () => {
    const body = `${REPRO}\n<video src="/talk.mp4" controls></video>`;
    const c = captions(body);
    expect(c.status).toBe("warn");
    expect(c.message).toBe("1 video(s) without caption tracks");
    expect(c.items).toHaveLength(1);
    expect(c.items?.[0]?.id).toBe("/talk.mp4");
    expect(c.details).toEqual({ videosChecked: 2, decorativeSkipped: 1 });
    expect(accessible(body).status).toBe("warn");
  });

  test.each([
    [
      "not muted",
      `<video src="/v.mp4" controls><track kind="captions" src="/c.vtt" srclang="en"></video>`,
    ],
    [
      "muted",
      `<video src="/v.mp4" muted controls><track kind="captions" src="/c.vtt" srclang="en"></video>`,
    ],
    [
      "muted autoplay loop",
      `<video src="/v.mp4" muted autoplay loop><track kind="captions" src="/c.vtt" srclang="en"></video>`,
    ],
  ])("video with a captions track passes: %s", (_label, body) => {
    expect(captions(body).status).toBe("pass");
    expect(accessible(body).status).toBe("pass");
  });
});
