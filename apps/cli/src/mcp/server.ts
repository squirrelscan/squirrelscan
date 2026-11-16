// `squirrel mcp` (#737): a stdio front end for the hosted MCP server. It serves
// stdio to the agent, forwards everything to mcp.squirrelscan.com with the CLI's
// own login, and implements no tools of its own. With `--channel` it also
// declares `claude/channel` and pushes cloud audit events into the session.

import {
  type Server,
  Server as McpLowLevelServer,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";

import {
  type ChannelOptions,
  createChannelServer,
  startChannelLoop,
} from "@/channel/server";
import { resolveCredential, warnIfSessionUnreadable } from "@/self/credentials";
import { logger } from "@/utils/logger";

import { version } from "../../package.json";
import { registerForwarders } from "./forward";
import { UpstreamHandle, connectUpstream } from "./upstream";

// How long startup waits for the hosted server's capabilities before serving a default set.
const UPSTREAM_STARTUP_TIMEOUT_MS = 8_000;

export interface FrontEndOptions {
  // Set for `squirrel mcp --channel`.
  channel?: ChannelOptions;
  // Tests inject the upstream connection and the credential check.
  upstream?: UpstreamHandle;
  resolveCredential?: typeof resolveCredential;
}

// What the front end declares when the hosted server could not be reached at startup. Requests still try again.
const FALLBACK_CAPABILITIES: ServerCapabilities = {
  tools: {},
  resources: {},
  prompts: {},
};

// The capabilities the front end can forward, taken from what the hosted server declares.
function forwardedCapabilities(
  upstream: ServerCapabilities | undefined
): ServerCapabilities {
  if (!upstream) return FALLBACK_CAPABILITIES;
  return {
    tools: {},
    resources: {},
    prompts: {},
    ...(upstream.completions ? { completions: {} } : {}),
    ...(upstream.extensions ? { extensions: upstream.extensions } : {}),
  };
}

async function upstreamHello(upstream: UpstreamHandle): Promise<{
  capabilities: ServerCapabilities;
  instructions: string | undefined;
}> {
  try {
    const client = await Promise.race([
      upstream.get(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out")),
          UPSTREAM_STARTUP_TIMEOUT_MS
        ).unref()
      ),
    ]);
    return {
      capabilities: forwardedCapabilities(client.getServerCapabilities()),
      instructions: client.getInstructions(),
    };
  } catch (error) {
    logger.debug("mcp: hosted server not reachable at startup", error);
    return { capabilities: FALLBACK_CAPABILITIES, instructions: undefined };
  }
}

// Build one front-end server (exported for tests).
export async function createFrontEnd(
  options: FrontEndOptions = {}
): Promise<Server> {
  const resolve = options.resolveCredential ?? resolveCredential;
  const upstream =
    options.upstream ??
    new UpstreamHandle(() => connectUpstream({ resolveCredential: resolve }));
  const hello = await upstreamHello(upstream);

  const server = options.channel
    ? createChannelServer({
        capabilities: hello.capabilities,
        instructions: hello.instructions,
      })
    : new McpLowLevelServer(
        { name: "squirrelscan", version },
        {
          capabilities: hello.capabilities,
          ...(hello.instructions ? { instructions: hello.instructions } : {}),
        }
      );
  registerForwarders(server, { upstream, resolveCredential: resolve });
  return server;
}

// Process-wide redirect so stray stdout console output (log/info/debug) can't corrupt the JSON-RPC stream.
function redirectConsoleLogToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

// Start the stdio server (mutates global console.log: not for tests) and run until the client hangs up.
export async function runMcpServer(
  options: FrontEndOptions = {}
): Promise<void> {
  redirectConsoleLogToStderr();
  // Loud warning for an unreadable or corrupt session. Uses console.error, so stdout (the JSON-RPC channel) is never touched.
  warnIfSessionUnreadable();

  const resolve = options.resolveCredential ?? resolveCredential;
  const upstream =
    options.upstream ??
    new UpstreamHandle(() => connectUpstream({ resolveCredential: resolve }));
  const shared: FrontEndOptions = { ...options, upstream };

  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);

  if (options.channel) {
    // A channel must negotiate the 2025-era handshake only (Claude Code refuses 2026-07-28 channels, #570), so it bypasses `serveStdio`.
    const server = await createFrontEnd(shared);
    startChannelLoop(server, options.channel).addEventListener("abort", stop);
    await server.connect(new StdioServerTransport());
  } else {
    // serveStdio picks the protocol era from the client's opening message: a 2026-07-28 client and a 2025-era client are both served from this factory.
    serveStdio(() => createFrontEnd(shared));
  }

  await new Promise<void>((resolveDone) =>
    shutdown.signal.addEventListener("abort", () => resolveDone())
  );
  await upstream.close();
  process.exit(0);
}
