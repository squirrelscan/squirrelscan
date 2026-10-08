// The in-memory store `bench-untouched-carried.ts` publishes into (#497).
//
// Counts every call (each is a database round trip on the hosting side) and every
// row handed to a write. Its site pages are a keyed upsert like any store's, so it
// runs the `upsertSitePages` contract with the rest. `getSitePages` returns a
// cached list until a write changes it, so the timed read is not a rebuild.

import type { PageFindingRecord, SitePageRecord } from "@squirrelscan/core-contracts";

import type { SmartAuditStore } from "../src/merge-promise";

export class BenchStore implements SmartAuditStore {
  storeCalls = 0;
  rowsWritten = 0;
  private readonly pages = new Map<string, SitePageRecord>();
  /** One site's rows, kept until a write changes them. */
  private cached: { siteKey: string; rows: SitePageRecord[] } | undefined;

  constructor(priorPages: readonly SitePageRecord[] = []) {
    for (const p of priorPages) this.pages.set(this.key(p), p);
    const siteKey = priorPages[0]?.siteKey;
    if (siteKey !== undefined) this.cached = { siteKey, rows: this.rowsOf(siteKey) };
  }

  private rowsOf(siteKey: string): SitePageRecord[] {
    return [...this.pages.values()].filter((p) => p.siteKey === siteKey);
  }

  private key(p: SitePageRecord): string {
    return `${p.siteKey}\u0000${p.normalizedUrl}`;
  }

  async getFindings(): Promise<PageFindingRecord[]> {
    this.storeCalls += 1;
    return [];
  }
  async getSitePages(siteKey: string): Promise<SitePageRecord[]> {
    this.storeCalls += 1;
    if (this.cached?.siteKey !== siteKey) this.cached = { siteKey, rows: this.rowsOf(siteKey) };
    return this.cached.rows;
  }
  async upsertFindings(rows: PageFindingRecord[]): Promise<void> {
    this.storeCalls += 1;
    this.rowsWritten += rows.length;
  }
  async upsertSitePages(rows: SitePageRecord[]): Promise<void> {
    this.storeCalls += 1;
    this.rowsWritten += rows.length;
    if (rows.length === 0) return;
    for (const p of rows) this.pages.set(this.key(p), { ...p });
    this.cached = undefined;
  }
  async markPageRemoved(): Promise<void> {
    this.storeCalls += 1;
  }
  async markPagesRemoved(): Promise<void> {
    this.storeCalls += 1;
  }
  async compactFindings(): Promise<number> {
    this.storeCalls += 1;
    return 0;
  }
}
