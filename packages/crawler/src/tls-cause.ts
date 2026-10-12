// A TLS root failure names its cause when the same handshake can see one (#712).
//
// The fetch only says "TLS handshake failed". One certificate read tells the
// owner which problem it was: expired on a date, a name the certificate does not
// cover, a missing intermediate, or a self-signed certificate. Where the runtime
// has no TLS socket API, or the handshake gives no problem, the fetch's own
// detail stands.

import { auditFailureDetail, type AuditFailureDetail } from "@squirrelscan/core-contracts/failure-reason";
import { probeTlsCertificate, tlsFailureCause } from "@squirrelscan/utils/tls-certificate";

export async function withTlsCause(
  detail: AuditFailureDetail,
  url: string,
): Promise<AuditFailureDetail> {
  if (detail.code !== "tls") return detail;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return detail;
  }
  if (target.protocol !== "https:") return detail;

  const hostname = target.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = target.port ? Number(target.port) : 443;
  const probe = await probeTlsCertificate({ hostname, port });
  const cause = tlsFailureCause(probe, hostname, new Date());
  return cause ? auditFailureDetail({ ...detail, detail: cause }) : detail;
}
