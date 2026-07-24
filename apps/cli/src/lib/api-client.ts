/**
 * `cliApi` — the CLI's bound instance of the shared `@squirrelscan/api-client`.
 *
 * The generic transport lives in the package (so it can become a public SDK and
 * be reused elsewhere); here we wire it to the CLI's specifics: the
 * `SQUIRREL_API_SERVER`-aware base URL, the credential precedence
 * (`resolveCredential`), the `squirrel/<version>` User-Agent, and the CLI logger.
 *
 * Import this anywhere the CLI talks to the API:
 *   const run = await cliApi.request("/v1/agent-runs/register", { auth: "required", body });
 *   void cliApi.send(`/v1/agent-runs/${id}`, { method: "PATCH", body });
 */
import { createApiClient } from "@squirrelscan/api-client";

import { getApiUrl } from "@/self/api";
import { resolveCredential } from "@/self/credentials";
import { logger } from "@/utils/logger";

import { version } from "../../package.json";

export const cliApi = createApiClient({
  baseUrl: getApiUrl,
  getToken: () => resolveCredential()?.token ?? null,
  userAgent: `squirrel/${version}`,
  onDebug: (message, meta) => logger.debug(message, meta),
});

export type { ApiResult, ApiRequestInit } from "@squirrelscan/api-client";
