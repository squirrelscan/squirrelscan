// Forward the hosted MCP's tools, resources, prompts and skills through a stdio
// `Server` as they are (#737). No tool is implemented here: a tool added to the
// hosted server reaches stdio users with no CLI release.

import type { Client } from "@modelcontextprotocol/client";

import {
  type Server,
  ProtocolError,
  ProtocolErrorCode,
  SdkHttpError,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import type { ResolvedCredential } from "@/self/credentials";

import {
  API_TOKEN_ENV_VAR,
  LEGACY_API_TOKEN_ENV_VAR,
} from "@/self/credentials";

import type { UpstreamHandle } from "./upstream";

import { errorResult } from "./result";

// A tool call can start a cloud audit, so allow longer than the SDK's 60 s default.
const TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;

// Methods outside the core set that are still forwarded: the Skills extension, MCP Events, and argument completion.
const FORWARDED_PREFIXES = ["skills/", "events/"];
const FORWARDED_METHODS = new Set(["completion/complete"]);

// One-release aliases for the old local tool names the hosted server does not have (#737).
const TOOL_ALIASES: Record<string, { name: string; args?: object }> = {
  audit_website: { name: "run_audit" },
  quick_check: { name: "run_audit", args: { level: "quick" } },
};

// The one error a signed-out cloud tool call returns.
export const SIGNED_OUT_MESSAGE = `Not signed in. squirrelscan's cloud tools need an account: run \`squirrel auth login\` for an interactive session, or set ${API_TOKEN_ENV_VAR} (or its ${LEGACY_API_TOKEN_ENV_VAR} alias) to an API key for headless use. Free local audits, including localhost, staging and private sites, need no account: use \`squirrel audit <url>\` (add \`--format llm\` for agent-readable output).`;

export interface ForwardDeps {
  upstream: UpstreamHandle;
  resolveCredential: () => ResolvedCredential | null;
}

const passthrough = z.looseObject({});

function stripMeta<T extends object | undefined>(params: T): T {
  if (!params) return params;
  const { _meta: _ignored, ...rest } = params as Record<string, unknown>;
  return rest as T;
}

// The hosted server could not be reached at all (as opposed to answering with an error).
class UpstreamUnreachableError extends ProtocolError {}

// Run one upstream call. A dead connection is dropped so the next call reconnects; an HTTP 401 becomes the sign-in hint.
async function viaUpstream<T>(
  deps: ForwardDeps,
  call: (client: Client) => Promise<T>
): Promise<T> {
  let client: Client;
  try {
    client = await deps.upstream.get();
  } catch (error) {
    throw new UpstreamUnreachableError(
      ProtocolErrorCode.InternalError,
      `Could not reach the squirrelscan MCP server: ${(error as Error).message}`
    );
  }
  try {
    return await call(client);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    if (!(error instanceof SdkHttpError)) deps.upstream.reset();
    throw error;
  }
}

function toolFailure(error: unknown) {
  if (error instanceof UpstreamUnreachableError)
    return errorResult(error.message);
  if (error instanceof SdkHttpError && /\b40[13]\b/.test(error.message)) {
    return errorResult(
      "squirrelscan rejected the credential (session expired or token rejected). Run `squirrel auth login`."
    );
  }
  return errorResult(
    `Could not reach the squirrelscan MCP server: ${(error as Error).message}`
  );
}

// Register the forwarding handlers. The server must already declare tools, resources and prompts.
export function registerForwarders(server: Server, deps: ForwardDeps): void {
  server.setRequestHandler("tools/list", async (request) =>
    viaUpstream(deps, (c) => c.listTools(stripMeta(request.params)))
  );

  server.setRequestHandler("tools/call", async (request) => {
    // Signed out: the catalog above still lists; a call never leaves the machine.
    if (!deps.resolveCredential()) return errorResult(SIGNED_OUT_MESSAGE);
    const { name, arguments: args } = request.params;
    const alias = TOOL_ALIASES[name];
    const target = alias ? alias.name : name;
    let toolArgs: Record<string, unknown> | undefined = args;
    if (alias) {
      if (args?.offline === true) {
        return errorResult(
          `${name} is now ${target} on the hosted MCP and always runs in the cloud. For a free local audit, run \`squirrel audit <url> --offline\`.`
        );
      }
      const { offline: _offline, ...rest } = args ?? {};
      toolArgs = { ...rest, ...alias.args };
    }
    try {
      return await viaUpstream(deps, (c) =>
        c.callTool(
          { name: target, arguments: toolArgs },
          { timeout: TOOL_CALL_TIMEOUT_MS }
        )
      );
    } catch (error) {
      // An answer from the hosted server (unknown tool, bad arguments) passes through as its own error.
      if (
        error instanceof ProtocolError &&
        !(error instanceof UpstreamUnreachableError)
      )
        throw error;
      return toolFailure(error);
    }
  });

  server.setRequestHandler("resources/list", async (request) =>
    viaUpstream(deps, (c) => c.listResources(stripMeta(request.params)))
  );
  server.setRequestHandler("resources/templates/list", async (request) =>
    viaUpstream(deps, (c) => c.listResourceTemplates(stripMeta(request.params)))
  );
  server.setRequestHandler("resources/read", async (request) =>
    viaUpstream(deps, (c) => c.readResource(stripMeta(request.params)))
  );
  server.setRequestHandler("prompts/list", async (request) =>
    viaUpstream(deps, (c) => c.listPrompts(stripMeta(request.params)))
  );
  server.setRequestHandler("prompts/get", async (request) =>
    viaUpstream(deps, (c) => c.getPrompt(stripMeta(request.params)))
  );

  server.fallbackRequestHandler = async (request) => {
    const forwarded =
      FORWARDED_METHODS.has(request.method) ||
      FORWARDED_PREFIXES.some((prefix) => request.method.startsWith(prefix));
    if (!forwarded) {
      throw new ProtocolError(
        ProtocolErrorCode.MethodNotFound,
        `Method not found: ${request.method}`
      );
    }
    return viaUpstream(
      deps,
      (c) =>
        c.request(
          { method: request.method, params: stripMeta(request.params) },
          passthrough
        ) as Promise<Record<string, unknown>>
    );
  };
}
