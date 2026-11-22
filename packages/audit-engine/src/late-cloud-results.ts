// Rules that start before the cloud prefetch has finished (pub#2121).
//
// The serial path awaits the whole prefetch, then hands its store to the runner.
// This binder lets `runStreamingRules` start instead as soon as Stage 0 has
// decided the site profile, and run each page's rules once that page's cloud
// results are final (`CloudPrefetchAccumulator.pageEnvelopes`), while later page
// batches are still rendering.
//
// The runner reads one store for the whole run, captured at construction, so this
// binder owns it (`store`) and is its only writer:
//
//   - Before the prefetch settles, a page that is about to run gets its own final
//     envelopes copied in. Page rules read only their own page's key, so a page
//     never sees a value the serial run would not have given it.
//   - When the prefetch settles (finished, or abandoned at its deadline), the
//     store is rebuilt as an exact copy of the result's store: same entries, same
//     batch order, and the abandon's skips included. The site rules (some of which
//     iterate a service's map in order) run only after that.
//
// The prefetch's own store is never written live, so the result the caller awaits
// is byte-for-byte what the serial path gets; nothing here changes what the
// prefetch calls or charges.

import type { SiteMetadata } from "@squirrelscan/core-contracts";
import type {
  CloudResultStore,
  CloudResultEnvelope,
} from "@squirrelscan/rules";

import type {
  CloudPrefetchAccumulator,
  CloudPrefetchResult,
} from "./cloud-prefetch";

export class LateCloudResults {
  /** The store the runner reads (`RunnerScope.cloudResults`). Written only by this binder. */
  readonly store: CloudResultStore = new Map();
  /** Pages let start while the prefetch was still running. */
  earlyPages = 0;
  private final: CloudPrefetchResult | null | undefined = undefined;
  private rejected = false;
  private readonly settling: Promise<CloudPrefetchResult | null>;

  /**
   * @param accumulator The accumulator the running prefetch writes into.
   * @param result The prefetch, resolving to that accumulator's own result
   *   (`prefetchCloudData`, `prefetchCloudDataWithDeadline` or
   *   `runContainerCloudPrefetchFromPayloads` given the accumulator), or null
   *   when no prefetch ran. A rejection reads as null, as a failed prefetch does
   *   on the serial path.
   */
  constructor(
    private readonly accumulator: CloudPrefetchAccumulator,
    result: Promise<CloudPrefetchResult | null>
  ) {
    this.settling = result.then(
      (r) => this.bindFinal(r),
      () => {
        this.rejected = true;
        return this.bindFinal(null);
      }
    );
  }

  /**
   * True once the prefetch promise rejected. Pages may already have run on its
   * early results, so no store or site profile describes this run's inputs: a
   * caller must not key a cache on it (`runStreamingRules` never binds one).
   */
  get failed(): boolean {
    return this.rejected;
  }

  /** True once the prefetch settled and {@link store} is the result's exact copy. */
  get settled(): boolean {
    return this.final !== undefined;
  }

  /** The settled result (null: no prefetch ran). Undefined until {@link settled}. */
  get result(): CloudPrefetchResult | null | undefined {
    return this.final;
  }

  /** Wait for the prefetch to settle; {@link store} is then the result's exact copy. */
  settle(): Promise<CloudPrefetchResult | null> {
    return this.settling;
  }

  /**
   * The Stage-0 site profile, as soon as it is decided: what the serial path
   * passes as `RunnerScope.siteMetadata` (`result.siteMetadata ?? undefined`).
   */
  async siteMetadata(): Promise<SiteMetadata | undefined> {
    for (;;) {
      if (this.final !== undefined)
        return this.final?.siteMetadata ?? undefined;
      const acc = this.accumulator;
      if (acc.result) return acc.result.siteMetadata ?? undefined;
      if (acc.siteMetadataDecided) return acc.siteMetadata ?? undefined;
      await this.nextChange();
    }
  }

  /**
   * Make page `url`'s cloud results readable through {@link store}. Returns null
   * when they already are (no await needed), else a promise that resolves once
   * they are final and copied in. Aborting `signal` (the caller's deadline won)
   * resolves it without copying anything and leaves no waiter parked.
   */
  pageReady(url: string, signal?: AbortSignal): Promise<void> | null {
    if (this.tryExpose(url)) return null;
    return (async () => {
      while (!signal?.aborted && !this.tryExpose(url))
        await this.nextChange(signal);
    })();
  }

  private tryExpose(url: string): boolean {
    if (this.final !== undefined) return true;
    const envelopes = this.accumulator.pageEnvelopes(url);
    if (!envelopes) return false;
    if (!this.accumulator.result) this.earlyPages++;
    for (const [service, env] of envelopes) this.setEntry(service, url, env);
    return true;
  }

  private setEntry(
    service: string,
    key: string,
    env: CloudResultEnvelope
  ): void {
    const svc = service as Parameters<CloudResultStore["get"]>[0];
    let byKey = this.store.get(svc);
    if (!byKey) {
      byKey = new Map();
      this.store.set(svc, byKey);
    }
    byKey.set(key, env);
  }

  private nextChange(signal?: AbortSignal): Promise<unknown> {
    return Promise.race([this.accumulator.changed(signal), this.settling]);
  }

  private bindFinal(
    result: CloudPrefetchResult | null
  ): CloudPrefetchResult | null {
    // Rebuilt rather than patched: the pages copied in early went in the order
    // they ran, and the final store's order is the batch order the site rules
    // and the rule cache's run-context hash read.
    this.store.clear();
    if (result) {
      for (const [service, byKey] of result.store)
        this.store.set(service, new Map(byKey));
    }
    this.final = result;
    // A rejected prefetch never settles its accumulator: release whoever is parked on it.
    this.accumulator.notifyChanged();
    return result;
  }
}
