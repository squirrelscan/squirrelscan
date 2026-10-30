// #590: SQUIRREL_SKILLS_TEST_SOURCE is a loopback-only test hook. A non-loopback value must never
// move a fetch off the pinned GitHub hosts; a loopback one serves a real install from a local server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncSkills, type SkillsEnv } from "@/self/agent-skills";
import {
  SKILLS_TEST_SOURCE_ENV,
  fetchSkillsManifest,
  parseLoopbackSource,
  sha256Hex,
} from "@/self/skills-manifest";

const enc = (s: string) => new TextEncoder().encode(s);
const SKILL_MD =
  '---\nname: squirrelscan\ndescription: d\nmetadata:\n  author: squirrelscan\n  version: "1.0"\n---\nbody\n';
const FILES: Record<string, string> = {
  "SKILL.md": SKILL_MD,
  "references/a.md": "ref a",
};
const manifest = {
  schema: 1,
  skills: [
    {
      name: "squirrelscan",
      version: "1.0",
      files: Object.entries(FILES).map(([path, c]) => ({
        path,
        sha256: sha256Hex(enc(c)),
        size: enc(c).byteLength,
      })),
    },
  ],
};

describe("parseLoopbackSource", () => {
  test("accepts only literal loopback addresses", () => {
    expect(parseLoopbackSource("http://127.0.0.1:8123")).toBe(
      "http://127.0.0.1:8123"
    );
    expect(parseLoopbackSource("http://127.5.6.7:1/skills/")).toBe(
      "http://127.5.6.7:1/skills"
    );
    expect(parseLoopbackSource("https://[::1]:9")).toBe("https://[::1]:9");
  });
  test.each([
    "https://raw.githubusercontent.com/evil/skills",
    "http://localhost:8123",
    "http://127.0.0.1.evil.example/",
    "http://127.0.0.1@evil.example/",
    `http://${"user"}:${"pw"}@127.0.0.1:1/`,
    "http://128.0.0.1/",
    "http://10.0.0.1/",
    "http://0.0.0.0:1/",
    "ftp://127.0.0.1/",
    "file:///etc",
    "http://127.0.0.1:1/?x=1",
    "not a url",
    "",
  ])("rejects %p", (value) => {
    expect(parseLoopbackSource(value)).toBeNull();
  });
});

describe("a non-loopback value is ignored", () => {
  test("the default hosts are used and one warning is printed", async () => {
    const urls: string[] = [];
    const warnings: string[] = [];
    const fetchStub = (async (input: string | URL) => {
      urls.push(String(input));
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const env = { [SKILLS_TEST_SOURCE_ENV]: "https://evil.example/skills" };
    await expect(
      fetchSkillsManifest({
        fetch: fetchStub,
        env,
        warn: (m) => warnings.push(m),
      })
    ).rejects.toThrow();
    await expect(
      fetchSkillsManifest({
        fetch: fetchStub,
        env,
        warn: (m) => warnings.push(m),
      })
    ).rejects.toThrow();
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(
        u.startsWith("https://github.com/squirrelscan/skills.git/") ||
          u.startsWith("https://raw.githubusercontent.com/squirrelscan/skills/")
      ).toBe(true);
    }
    expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(SKILLS_TEST_SOURCE_ENV);
  });
});

describe("a loopback value serves a real install", () => {
  let root: string;
  let server: ReturnType<typeof Bun.serve>;
  let e: SkillsEnv;
  const hits: string[] = [];
  beforeEach(() => {
    hits.length = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        hits.push(path);
        if (path === "/manifest.json") return Response.json(manifest);
        const m = path.match(/^\/skills\/squirrelscan\/(.+)$/);
        const body = m ? FILES[decodeURIComponent(m[1]!)] : undefined;
        return body === undefined
          ? new Response("nope", { status: 404 })
          : new Response(body);
      },
    });
    root = mkdtempSync(join(tmpdir(), "skills-test-source-"));
    mkdirSync(join(root, "home"), { recursive: true });
    mkdirSync(join(root, "repo"), { recursive: true });
    e = {
      home: join(root, "home"),
      cwd: join(root, "repo"),
      env: { [SKILLS_TEST_SOURCE_ENV]: `http://127.0.0.1:${server.port}` },
      dataDir: join(root, "home", ".squirrel"),
    };
  });
  afterEach(async () => {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("squirrel skills install runs offline against the fixture server", async () => {
    const result = await syncSkills({ mode: "install", e });
    expect(result.ref).toBe("local");
    const dir = join(e.home, ".agents", "skills", "squirrelscan");
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect(existsSync(join(dir, "references", "a.md"))).toBe(true);
    expect(hits).toContain("/manifest.json");
  });

  test("a redirect off the loopback server is refused and never followed", async () => {
    await server.stop(true);
    let followed = 0;
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        followed++;
        return Response.json(manifest);
      },
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${other.port}/manifest.json` },
        }),
    });
    try {
      await expect(
        fetchSkillsManifest({
          env: { [SKILLS_TEST_SOURCE_ENV]: `http://127.0.0.1:${server.port}` },
          warn: () => {},
        })
      ).rejects.toThrow();
      expect(followed).toBe(0);
    } finally {
      await other.stop(true);
    }
  });

  test("honouring the override is announced on stderr", async () => {
    const notes: string[] = [];
    await fetchSkillsManifest({
      env: { [SKILLS_TEST_SOURCE_ENV]: `http://127.0.0.1:${server.port}` },
      warn: (m) => notes.push(m),
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`http://127.0.0.1:${server.port}`);
  });

  test("a tampered file is still rejected by its manifest sha256", async () => {
    FILES["references/a.md"] = "ref a";
    const bad = {
      ...manifest,
      skills: [
        {
          ...manifest.skills[0]!,
          files: manifest.skills[0]!.files.map((f) =>
            f.path === "references/a.md" ? { ...f, sha256: "0".repeat(64) } : f
          ),
        },
      ],
    };
    await server.stop(true);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/manifest.json") return Response.json(bad);
        const m = path.match(/^\/skills\/squirrelscan\/(.+)$/);
        return m
          ? new Response(FILES[decodeURIComponent(m[1]!)] ?? "")
          : new Response("no", { status: 404 });
      },
    });
    e.env = { [SKILLS_TEST_SOURCE_ENV]: `http://127.0.0.1:${server.port}` };
    await expect(syncSkills({ mode: "install", e })).rejects.toThrow(/sha256/);
  });
});
