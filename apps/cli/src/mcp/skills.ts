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

  const descriptions = new Map(
    AGENT_SKILLS_BUNDLE.map((skill) => [
      skill.name,
      String(skill.frontmatter.description),
    ])
  );
  for (const file of agentSkillFiles().values()) {
    const isSkillMd = file.path === "SKILL.md";
    server.registerResource(
      // SKILL.md takes the skill's own name and description, per the extension.
      isSkillMd ? file.skill : `${file.skill}/${file.path}`,
      file.uri,
      {
        mimeType: file.mimeType,
        ...(isSkillMd ? { description: descriptions.get(file.skill) } : {}),
        cacheHint: SKILLS_CACHE,
      },
      async () => ({ contents: [file.contents] })
    );
  }

  server.server.setRequestHandler(
    "skills/list",
    { params: z.looseObject({ cursor: z.string().optional() }) },
    async () => ({
      resultType: "complete",
      skills: await agentSkillEntries(),
      ...SKILLS_CACHE,
    })
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
