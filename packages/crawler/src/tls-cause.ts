// A TLS root failure names its cause when one handshake can see it (#712).
//
// The fetch only says "TLS handshake failed". One certificate read tells the
// owner which problem it was: expired on a date, a name the certificate does not
// cover, a missing intermediate, or a self-signed certificate. The handshake is
// the caller's injected `TlsProbeFn` (the CLI's, which vets and pins the
// address); with none, or when the handshake finds no problem, the fetch's own
// detail stands.

import { auditFailureDetail, type AuditFailureDetail } from "@squirrelscan/core-contracts/failure-reason";
import {
  tlsFailureCause,
  type TlsProbe,
  type TlsProbeFn,
} from "@squirrelscan/utils/tls-certificate";

/**
 * The most a failed crawl waits on the cause handshake. It only improves a
 * failure message, so it gets a fraction of a page fetch's deadline.
 */
export const TLS_CAUSE_TIMEOUT_MS = 3_000;

/**
 * `detail` with the certificate problem behind it, for a TLS failure on an
 * https URL. Waits at most `timeoutMs`, capped at {@link TLS_CAUSE_TIMEOUT_MS};
 * zero or less (no time left) skips the handshake.
 */
export async function withTlsCause(
  detail: AuditFailureDetail,
  url: string,
  probe: TlsProbeFn | undefined,
  timeoutMs: number = TLS_CAUSE_TIMEOUT_MS,
): Promise<AuditFailureDetail> {
  if (detail.code !== "tls" || !probe) return detail;
  const waitMs = Math.min(TLS_CAUSE_TIMEOUT_MS, Math.floor(timeoutMs));
  if (!(waitMs > 0)) return detail;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return detail;
  }
  if (target.protocol !== "https:") return detail;

  const hostname = target.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = target.port ? Number(target.port) : 443;
  const result = await probe({ hostname, port, timeoutMs: waitMs });
  const cause = tlsFailureCause(result, hostname, new Date());
  return cause ? auditFailureDetail({ ...detail, detail: cause }) : detail;
}

/**
 * `probe` answering each host and port once: a crawl whose pages all fail the
 * same handshake pays for one cause read, not one per page. A probe that
 * throws (a `TlsProbeFn` must not) is remembered as unreachable.
 */
export function memoizeTlsProbe(probe: TlsProbeFn): TlsProbeFn {
  const seen = new Map<string, Promise<TlsProbe>>();
  return (target) => {
    const key = `${target.hostname.toLowerCase()}:${target.port ?? 443}`;
    let answer = seen.get(key);
    if (!answer) {
      answer = probe(target).catch(
        (error: unknown): TlsProbe => ({
          kind: "unreachable",
          code: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      seen.set(key, answer);
    }
    return answer;
  };
}
