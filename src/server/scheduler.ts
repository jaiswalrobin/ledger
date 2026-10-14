import type { Db } from "./db.ts";
import { pruneDemos } from "./demo.ts";
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
  extra: { gmailConfigured: boolean; demosPruned: number; pruneFailed: boolean },
): SchedulerReport {
  const statuses = emptyStatuses();
  for (const run of runs) statuses[run.status] += 1;
  const outcome =
    statuses.FAILED > 0
      ? "failed"
      : statuses.DEGRADED > 0 || extra.pruneFailed
        ? "attention"
        : "healthy";
  return { ...extra, mailboxes: runs.length, statuses, outcome };
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
    demosPruned = await pruneDemos(input.db);
  } catch {
    pruneFailed = true;
  }
  if (!input.sync)
    return summarize([], { gmailConfigured: false, demosPruned, pruneFailed });
  const runs = await syncAllMailboxes(
    { ...input.sync, db: input.db },
    { system: true },
  );
  return summarize(runs, { gmailConfigured: true, demosPruned, pruneFailed });
}
