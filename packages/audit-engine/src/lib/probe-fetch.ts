// One fetch for the end-of-crawl probes (soft404-confirm, cloaking-probe).
// Redirects are followed by hand (#1395) so the audit's custom headers (auth,
// cookies, Web Bot Auth) are dropped on a hop to another origin, and with an
// egress policy every hop is vetted before it is sent (#2831, #2764).

import {
  EgressRefusedError,
  egressGuardedSend,
  type EgressPolicy,
} from "@squirrelscan/utils/public-egress";
import { isHttpOrHttpsUrl, safeRedirectFetch } from "@squirrelscan/utils/safe-fetch";
import { fetchUndecoded } from "./capped-body-read";

/** No policy given: private networks allowed (LAN audits), link-local and metadata refused. */
const DEFAULT_EGRESS: EgressPolicy = { allowPrivateNetwork: true };

/** Undecoded on every hop (#2717); the caller reads the final body. */
export async function probeFetch(
  url: string,
  init: RequestInit,
  egress: EgressPolicy = DEFAULT_EGRESS,
): Promise<Response> {
  if (!isHttpOrHttpsUrl(url)) throw new EgressRefusedError("refused scheme");
  const send = egressGuardedSend(fetchUndecoded, egress);
  return (await safeRedirectFetch(url, init, send)).response;
}
