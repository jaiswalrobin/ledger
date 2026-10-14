import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";

/** Owner-only recovery. No artifacts, events, reviews, or Gmail messages are deleted. */
export async function requestMailboxRecheck(
  db: Db,
  userId: string,
  mailboxId: string,
  now = new Date(),
): Promise<"QUEUED" | "BUSY" | "IN_PROGRESS" | "NOT_FOUND"> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT id FROM ledger_users WHERE id=$1 FOR UPDATE", [userId]);
    const { rows } = await tx.query<{
      recheck_id: string | null;
      active_lease: boolean;
    }>(
      `SELECT recheck_id, coalesce(sync_lease_until >= $3, false) AS active_lease
       FROM connected_mailboxes WHERE id=$1 AND user_id=$2 AND sync_state<>'DISCONNECTED' FOR UPDATE`,
      [mailboxId, userId, now.toISOString()],
    );
    const mailbox = rows[0];
    if (!mailbox) return "NOT_FOUND";
    if (mailbox.active_lease) return "BUSY";
    if (mailbox.recheck_id) return "IN_PROGRESS";
    await tx.query(
      `UPDATE connected_mailboxes SET recheck_id=$3, sync_state='INITIALIZING',
         history_cursor=NULL, scan_state=NULL, history_scan_state=NULL,
         sync_lease_until=NULL, sync_lease_owner=NULL, backfill_complete=false,
         backfill_start=NULL, backfill_end=NULL, last_error_code=NULL WHERE id=$1 AND user_id=$2`,
      [mailboxId, userId, randomUUID()],
    );
    return "QUEUED";
  });
}
