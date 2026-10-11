// The squirrelscan agent skills over MCP: the Skills extension
// (`io.modelcontextprotocol/skills`, SEP-2640). The skills and their manifest
// come from `@squirrelscan/utils/agent-skills`, which the hosted MCP server
// serves from too, so a client gets the same skills from either.

import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import {
  AGENT_SKILLS_BUNDLE,
  SKILLS_CACHE,
  SKILLS_EXTENSION,
  agentSkillEntries,
  agentSkillEntry,
  agentSkillFiles,
} from "@squirrelscan/utils/agent-skills";
import { z } from "zod";

/**
 * Declare the extension and serve every skill file as a resource, plus
 * `skills/list` and `skills/get`. Call before the server connects.
 */
export function registerSkills(server: McpServer): void {
  server.server.registerCapabilities({
    resources: {},
    extensions: { [SKILLS_EXTENSION]: {} },
  });

  // The bundler refuses a skill without a description; a non-string one is
  // left out rather than served as "undefined".
  const descriptions = new Map(
    AGENT_SKILLS_BUNDLE.flatMap((skill) =>
      typeof skill.frontmatter.description === "string"
        ? [[skill.name, skill.frontmatter.description] as const]
        : []
    )
  );
  for (const file of agentSkillFiles().values()) {
    const isSkillMd = file.path === "SKILL.md";
    server.registerResource(
      // SKILL.md takes the skill's own name and description, per the extension.
      isSkillMd ? file.skill : `${file.skill}/${file.path}`,
      file.uri,
      {
        mimeType: file.mimeType,
        ...(isSkillMd && descriptions.has(file.skill)
          ? { description: descriptions.get(file.skill) }
          : {}),
        cacheHint: SKILLS_CACHE,
      },
      async () => ({ contents: [file.contents] })
    );
  }

  // One page: the listing never returns `nextCursor`, so any cursor a client
  // sends is not one this server issued.
  server.server.setRequestHandler(
    "skills/list",
    { params: z.looseObject({ cursor: z.string().optional() }) },
    async ({ cursor }) => {
      if (cursor !== undefined) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown cursor: skills/list returns every skill in one page`
        );
      }
      return {
        resultType: "complete",
        skills: await agentSkillEntries(),
        ...SKILLS_CACHE,
      };
    }
  );

  server.server.setRequestHandler(
    "skills/get",
    { params: z.looseObject({ uri: z.string() }) },
    async ({ uri }) => {
      const skill = await agentSkillEntry(uri);
      if (!skill) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Not a skill this server serves: ${uri}`
        );
      }
      return { resultType: "complete", skill, ...SKILLS_CACHE };
    }
  );
}
