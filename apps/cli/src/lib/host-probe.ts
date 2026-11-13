import type { HostProbe } from "@squirrelscan/audit-engine";

import { lookup } from "node:dns/promises";
import { connect } from "node:net";

const PROBE_TIMEOUT_MS = 3000;

/** Time to open a TCP connection to `address:port`, in ms, or undefined when it did not connect in time. */
function tcpConnectMs(
  address: string,
  port: number
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = connect({ host: address, port });
    const done = (ms?: number) => {
      socket.destroy();
      resolve(ms);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done());
    socket.once("connect", () => done(Math.round(performance.now() - started)));
    socket.once("error", () => done());
  });
}

/**
 * Resolves the audited host's A and AAAA records and times one TCP connect (#10). Report-only context:
 * every failure yields a partial or empty result, never an error, so it cannot affect the audit.
 */
export async function probeHost(url: string): Promise<HostProbe | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dns timeout")), PROBE_TIMEOUT_MS)
      ),
    ]);
  } catch {
    return undefined;
  }
  const ipv4 = [
    ...new Set(answers.filter((a) => a.family === 4).map((a) => a.address)),
  ];
  const ipv6 = [
    ...new Set(answers.filter((a) => a.family === 6).map((a) => a.address)),
  ];
  const first = ipv4[0] ?? ipv6[0];
  if (!first) return undefined;
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "http:"
      ? 80
      : 443;
  const ms = await tcpConnectMs(first, port);
  return {
    host,
    ipv4,
    ipv6,
    ...(ms === undefined
      ? {}
      : {
          latency: {
            ms,
            measure: "tcp-connect" as const,
            address: first,
            port,
          },
        }),
  };
}
