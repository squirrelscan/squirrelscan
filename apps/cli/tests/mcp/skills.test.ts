// `squirrel mcp` serves the squirrelscan agent skills through the Skills
// extension (`io.modelcontextprotocol/skills`): declared in `server/discover`,
// listed by `skills/list`, one entry by `skills/get`, every file through
// `resources/read`. The test reads every file back through a real client and
// recomputes the manifest from the bytes it received.

import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  AGENT_SKILLS_BUNDLE,
  SKILLS_EXTENSION,
  SKILL_LIMITS,
  type SkillEntry,
} from "@squirrelscan/utils/agent-skills";
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import { createMcpServer } from "@/mcp/server";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
});

async function modernClient(): Promise<Client> {
  const handler = createMcpHandler(() => createMcpServer());
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    })
  );
  return client;
}

async function legacyClient(): Promise<Client> {
  const server = createMcpServer();
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { versionNegotiation: { mode: "legacy" } }
  );
  clients.push(client);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const Result = z.looseObject({});
type ListResult = { skills: SkillEntry[]; ttlMs: number; cacheScope: string };
type GetResult = { skill: SkillEntry; ttlMs: number; cacheScope: string };

const listSkills = async (client: Client) =>
  (await client.request(
    { method: "skills/list", params: {} },
    Result
  )) as unknown as ListResult;

const getSkill = async (client: Client, uri: string) =>
  (await client.request(
    { method: "skills/get", params: { uri } },
    Result
  )) as unknown as GetResult;

/** The raw bytes `resources/read` returned for a file. */
async function readBytes(client: Client, uri: string): Promise<Uint8Array> {
  const { contents } = await client.readResource({ uri });
  expect(contents).toHaveLength(1);
  const content = contents[0]!;
  expect(content.uri).toBe(uri);
  return "blob" in content && typeof content.blob === "string"
    ? new Uint8Array(Buffer.from(content.blob, "base64"))
    : new TextEncoder().encode((content as { text: string }).text);
}

function frontmatterOf(skillMd: string): unknown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  return match ? Bun.YAML.parse(match[1]!) : null;
}

describe("the Skills extension on squirrel mcp", () => {
  test("server/discover declares the extension and resources", async () => {
    const client = await modernClient();
    expect(client.getProtocolEra()).toBe("modern");
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.resources).toBeDefined();
    expect(capabilities?.extensions?.[SKILLS_EXTENSION]).toEqual({});
  }, 30_000);

  test("every listed file reads back as exactly the bytes its digest and size describe", async () => {
    const client = await modernClient();
    const listed = await listSkills(client);
    expect(listed.ttlMs).toBeGreaterThan(0);
    expect(listed.cacheScope).toBe("public");
    expect(listed.skills.map((s) => s.frontmatter.name).sort()).toEqual(
      AGENT_SKILLS_BUNDLE.map((s) => s.name).sort()
    );

    for (const entry of listed.skills) {
      const name = entry.frontmatter.name;
      // The URI's last path segment is the skill name, and the entry lists its
      // own SKILL.md.
      expect(entry.uri).toBe(`skill://${name}/SKILL.md`);
      expect(entry.resources.map((r) => r.uri)).toContain(entry.uri);
      expect(entry.resources.length).toBeLessThanOrEqual(
        SKILL_LIMITS.maxResources
      );

      let total = 0;
      for (const resource of entry.resources) {
        expect(resource.uri.startsWith(`skill://${name}/`)).toBe(true);
        const bytes = await readBytes(client, resource.uri);
        const hex = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        expect({
          uri: resource.uri,
          digest: `sha256:${hex}`,
          size: bytes.byteLength,
        }).toEqual(resource);
        total += bytes.byteLength;
      }
      expect(total).toBeLessThanOrEqual(SKILL_LIMITS.maxBytes);

      // Frontmatter passes through unchanged: the entry carries exactly what
      // the served SKILL.md says.
      const skillMd = new TextDecoder().decode(
        await readBytes(client, entry.uri)
      );
      expect(entry.frontmatter).toEqual(frontmatterOf(skillMd) as never);
    }
  }, 30_000);

  test("skills/get returns the listed entry, and -32602 for anything else", async () => {
    const client = await modernClient();
    const { skills } = await listSkills(client);
    for (const entry of skills) {
      const got = await getSkill(client, entry.uri);
      expect(got.skill).toEqual(entry);
      expect(got.cacheScope).toBe("public");
    }
    for (const uri of [
      "skill://nope/SKILL.md",
      "skill://squirrelscan/references/entity-map-fixes.md",
      "skill://squirrelscan",
    ]) {
      await expect(getSkill(client, uri)).rejects.toMatchObject({
        code: -32602,
      });
    }
    await expect(
      client.readResource({ uri: "skill://squirrelscan/../../etc/passwd" })
    ).rejects.toMatchObject({ code: -32602 });
  }, 30_000);

  test("a 2025-era client gets the same skills", async () => {
    const legacy = await legacyClient();
    expect(legacy.getProtocolEra()).toBe("legacy");
    expect(
      legacy.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION]
    ).toEqual({});
    const modern = await modernClient();
    expect((await listSkills(legacy)).skills).toEqual(
      (await listSkills(modern)).skills
    );
  }, 30_000);
});

describe("the bundled skills", () => {
  test("each skill's version is its SKILL.md metadata.version", () => {
    for (const skill of AGENT_SKILLS_BUNDLE) {
      const metadata = skill.frontmatter.metadata as { version?: unknown };
      expect(String(metadata?.version)).toBe(skill.version);
    }
  });
});
