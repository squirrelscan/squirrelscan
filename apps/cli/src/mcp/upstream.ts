// The upstream half of `squirrel mcp` (#737): a client of the hosted MCP server,
// authenticated with the credential the CLI already holds.

import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { MCP_SERVER_URL } from "@squirrelscan/utils/constants";

import type { ResolvedCredential } from "@/self/credentials";

import { version } from "../../package.json";

// The hosted MCP URL, overridable for local and staging servers.
export function upstreamUrl(): string {
  return process.env.SQUIRREL_MCP_SERVER?.trim() || MCP_SERVER_URL;
}

// Resolve the credential on every request: a login can be refreshed, replaced or expire while a long agent session stays open.
export function createAuthedFetch(
  resolve: () => ResolvedCredential | null,
  base: FetchLike = fetch as FetchLike
): FetchLike {
  return (url, init) => {
    const credential = resolve();
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    if (credential) headers.set("authorization", `Bearer ${credential.token}`);
    return base(url, { ...init, headers });
  };
}

export interface UpstreamOptions {
  url?: string;
  resolveCredential: () => ResolvedCredential | null;
  fetch?: FetchLike;
}

// Connect on the current protocol revision; an older hosted server falls back to the legacy handshake on its own.
export async function connectUpstream(
  options: UpstreamOptions
): Promise<Client> {
  const client = new Client(
    { name: "squirrel-mcp", version },
    { versionNegotiation: { mode: "auto" } }
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(options.url ?? upstreamUrl()), {
        fetch: createAuthedFetch(options.resolveCredential, options.fetch),
      })
    );
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return client;
}

// One shared upstream connection, made on first use. A failed attempt is not remembered, so the next request tries again (the network may have been down at startup).
export class UpstreamHandle {
  private pending: Promise<Client> | null = null;

  constructor(private readonly connect: () => Promise<Client>) {}

  get(): Promise<Client> {
    if (!this.pending) {
      const attempt = this.connect();
      this.pending = attempt;
      attempt.catch(() => {
        if (this.pending === attempt) this.pending = null;
      });
    }
    return this.pending;
  }

  // Forget a connection that has gone bad so the next request reconnects.
  reset(): void {
    const old = this.pending;
    this.pending = null;
    void old?.then((client) => client.close()).catch(() => {});
  }

  async close(): Promise<void> {
    const old = this.pending;
    this.pending = null;
    await old?.then((client) => client.close()).catch(() => {});
  }
}
