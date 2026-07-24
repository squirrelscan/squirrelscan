import type {
  AuditHistorySnapshot,
  AuditReport,
  QuotaDecision,
  UsageEvent,
  UsageStore,
} from "@squirrelscan/core-contracts";

export interface AuditRunInput {
  runId: string;
  userId: string;
  siteKey: string;
  url: string;
  coverageMode: "quick" | "surface" | "full";
  maxPages: number;
}

export interface AuditRunOutput {
  report: AuditReport;
  snapshot: AuditHistorySnapshot;
  quotaDecision: QuotaDecision | null;
}

export interface AuditRunnerDeps {
  usageStore?: UsageStore;
  runAudit(input: AuditRunInput): Promise<AuditReport>;
  persistHistory(snapshot: AuditHistorySnapshot): Promise<void>;
  buildUsageEvents?(input: AuditRunInput, report: AuditReport): UsageEvent[];
}

function buildSnapshot(input: AuditRunInput, report: AuditReport): AuditHistorySnapshot {
  return {
    runId: input.runId,
    siteKey: input.siteKey,
    url: report.baseUrl || input.url,
    score: typeof report.healthScore?.overall === "number" ? report.healthScore.overall : null,
    issuesFound: report.failed + report.warnings,
    auditedAt: report.timestamp,
    createdAt: new Date().toISOString(),
    issueAggregates: [],
  };
}

export async function runAuditWithComposition(
  input: AuditRunInput,
  deps: AuditRunnerDeps,
): Promise<AuditRunOutput> {
  let quotaDecision: QuotaDecision | null = null;
  if (deps.usageStore) {
    const month = new Date().toISOString().slice(0, 7);
    quotaDecision = await deps.usageStore.checkQuota(input.userId, month);
    if (!quotaDecision.allowed) {
      throw new Error(quotaDecision.reason ?? "Quota exceeded");
    }
  }

  const report = await deps.runAudit(input);
  const snapshot = buildSnapshot(input, report);
  await deps.persistHistory(snapshot);

  if (deps.usageStore && deps.buildUsageEvents) {
    const events = deps.buildUsageEvents(input, report);
    if (events.length > 0) {
      await deps.usageStore.recordBatch(events);
    }
  }

  return {
    report,
    snapshot,
    quotaDecision,
  };
}
