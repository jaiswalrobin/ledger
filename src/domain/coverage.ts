/**
 * Monitoring coverage is derived from sources and sync health, never from application status.
 * A quiet inbox is only meaningful when the sources that would have seen a reply are healthy.
 */
export type SyncState =
  "INITIALIZING" | "HEALTHY" | "DEGRADED" | "RESYNC_REQUIRED" | "DISCONNECTED";

export type Coverage =
  | "CONTINUOUS_HEALTHY"
  | "CONTINUOUS_DEGRADED"
  | "BACKFILL_INCOMPLETE"
  | "DISCONNECTED"
  | "FORWARD_OR_MANUAL";

export interface MailboxFacts {
  syncState: SyncState;
  backfillComplete: boolean;
}

const SEVERITY: Record<Coverage, number> = {
  CONTINUOUS_HEALTHY: 0,
  BACKFILL_INCOMPLETE: 1,
  CONTINUOUS_DEGRADED: 2,
  DISCONNECTED: 3,
  FORWARD_OR_MANUAL: 4,
};

function ofMailbox(m: MailboxFacts): Coverage {
  if (m.syncState === "DISCONNECTED") return "DISCONNECTED";
  if (m.syncState !== "HEALTHY") return "CONTINUOUS_DEGRADED";
  return m.backfillComplete ? "CONTINUOUS_HEALTHY" : "BACKFILL_INCOMPLETE";
}

/** `mailboxes` are the connected mailboxes that observed this attempt's evidence; the worst one wins. */
export function deriveCoverage(mailboxes: readonly MailboxFacts[]): Coverage {
  if (!mailboxes.length) return "FORWARD_OR_MANUAL";
  return mailboxes
    .map(ofMailbox)
    .reduce((worst, next) => (SEVERITY[next] > SEVERITY[worst] ? next : worst));
}

export const COVERAGE_LABEL: Record<Coverage, string> = {
  CONTINUOUS_HEALTHY: "Monitored · healthy",
  CONTINUOUS_DEGRADED: "Monitored · degraded",
  BACKFILL_INCOMPLETE: "Monitored · backfill incomplete",
  DISCONNECTED: "Mailbox disconnected",
  FORWARD_OR_MANUAL: "Forwarded / manual",
};

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** Silence is never rejection. This text always states which sources it is about. */
export function describeActivity(
  lastActivityAt: string | null,
  now: Date,
  coverage: Coverage,
): string {
  if (!lastActivityAt) return "No activity recorded yet.";
  const since = new Date(lastActivityAt);
  const days = Math.max(
    0,
    Math.floor((now.getTime() - since.getTime()) / 86_400_000),
  );
  const when = `${DATE.format(since)} (${days} day${days === 1 ? "" : "s"})`;
  if (coverage === "FORWARD_OR_MANUAL")
    return `Not continuously monitored. Last recorded activity ${when}.`;
  if (coverage === "CONTINUOUS_HEALTHY")
    return `No response observed in connected sources since ${when}.`;
  return `No response observed since ${when}, but monitoring is incomplete (${COVERAGE_LABEL[coverage].toLowerCase()}).`;
}

export function maskEmail(email: string | null): string {
  if (!email) return "unknown";
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}
