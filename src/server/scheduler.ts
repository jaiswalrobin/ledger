import type { Db } from "./db.ts";
import { pruneDemos } from "./demo.ts";
import { drainReviewReconciliations } from "./pipeline.ts";
import {
  syncAllMailboxes,
  type SyncDeps,
  type SyncResult,
  type SyncStatus,
} from "./gmail/sync.ts";

/**
 * What one scheduled run did, as counts only. No mailbox addresses, ids or message data, so the
 * scheduler can print it in public CI logs.
 */
export interface SchedulerReport {
  /** False when Google credentials are not configured: nothing could be synced. */
  gmailConfigured: boolean;
  mailboxes: number;
  statuses: Record<SyncStatus, number>;
  demosPruned: number;
  /** Demo retention cleanup failed; mailbox sync still ran. */
  pruneFailed: boolean;
  reviewUpdatesApplied: number;
  reconciliationFailed: boolean;
  /**
   * "healthy": every mailbox synced or saved progress.
   * "attention": a mailbox needs its owner (revoked token, failed messages) but the run worked.
   * "failed": a mailbox sync crashed or the run could not complete; the operator must look.
   */
  outcome: "healthy" | "attention" | "failed";
}

const emptyStatuses = (): Record<SyncStatus, number> => ({
  OK: 0,
  PARTIAL: 0,
  BUSY: 0,
  DEGRADED: 0,
  FAILED: 0,
  SKIPPED: 0,
});

export function summarize(
  runs: readonly SyncResult[],
  extra: { gmailConfigured: boolean; demosPruned: number; pruneFailed: boolean;
    reviewUpdatesApplied?: number; reconciliationFailed?: boolean },
): SchedulerReport {
  const statuses = emptyStatuses();
  for (const run of runs) statuses[run.status] += 1;
  const outcome =
    statuses.FAILED > 0
      ? "failed"
      : statuses.DEGRADED > 0 || extra.pruneFailed || extra.reconciliationFailed
        ? "attention"
        : "healthy";
  return { reviewUpdatesApplied: 0, reconciliationFailed: false, ...extra, mailboxes: runs.length, statuses, outcome };
}

/**
 * One scheduled run: demo retention, then every connected mailbox. Each part is isolated, so a
 * failed cleanup never blocks mail sync and the caller always receives a truthful report.
 */
export async function runScheduledSync(input: {
  db: Db;
  /** Absent when Google credentials are not configured on this deployment. */
  sync: Omit<SyncDeps, "db"> | null;
}): Promise<SchedulerReport> {
  let demosPruned = 0,
    pruneFailed = false;
  try {
    // Each workspace is deleted in its own transaction; count as they commit so a later failure
    // still reports the deletions that happened.
    await pruneDemos(input.db, (count) => (demosPruned = count));
  } catch {
    pruneFailed = true;
  }
  let reviewUpdatesApplied = 0, reconciliationFailed = false;
  try {
    const result = await drainReviewReconciliations(input.db, input.sync?.now?.() ?? new Date());
    reviewUpdatesApplied = result.applied;
    reconciliationFailed = result.failed > 0;
  } catch { reconciliationFailed = true; }
  const extra = { demosPruned, pruneFailed, reviewUpdatesApplied, reconciliationFailed };
  if (!input.sync)
    return summarize([], { gmailConfigured: false, ...extra });
  const runs = await syncAllMailboxes(
    { ...input.sync, db: input.db },
    { system: true },
  );
  return summarize(runs, { gmailConfigured: true, ...extra });
}
