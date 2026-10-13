import { randomUUID } from "node:crypto";
import { EmlError, parseEml } from "../../ingestion/eml.ts";
import { classifyHeaders } from "../../ingestion/header-gate.ts";
import type { Db } from "../db.ts";
import { ingestOriginal, type IngestSource } from "../pipeline.ts";
import { OAuthError } from "../security/oauth.ts";
import { GmailError, candidateQueries, type GmailClient } from "./client.ts";
import { TokenUnreadableError } from "./vault.ts";

export type SyncScope = { userId: string } | { system: true };
function scopeUser(scope: SyncScope): string | null | false {
  if (
    scope &&
    "system" in scope &&
    scope.system === true &&
    !("userId" in scope)
  )
    return null;
  if (
    scope &&
    "userId" in scope &&
    typeof scope.userId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      scope.userId,
    )
  )
    return scope.userId;
  return false;
}

export interface MailboxRef {
  id: string;
  userId: string;
  address: string;
}

export interface SyncDeps {
  db: Db;
  /** Production: decrypt the refresh token and mint an access token. Tests: a fake client. */
  clientFor(mailbox: MailboxRef): Promise<GmailClient>;
  now?: () => Date;
  /** Wall-clock budget for one run. Discovery always completes at least one page. */
  budgetMs?: number;
  lookbackDays?: number;
  concurrency?: number;
}

export type SyncStatus =
  "OK" | "PARTIAL" | "BUSY" | "DEGRADED" | "FAILED" | "SKIPPED";
export interface SyncResult {
  mailboxId: string;
  status: SyncStatus;
}

const LEASE_SECONDS = 330;
const MAX_TASK_ATTEMPTS = 5;
const DEFAULT_BUDGET_MS = 240_000;
const RESYNC_MARGIN_MS = 24 * 3_600_000;

interface MailboxRow {
  id: string;
  user_id: string;
  address: string;
  sync_state:
    | "INITIALIZING"
    | "HEALTHY"
    | "DEGRADED"
    | "RESYNC_REQUIRED"
    | "DISCONNECTED";
  history_cursor: string | null;
  backfill_complete: boolean;
  last_success_at: unknown;
  scan_state: ScanState | null;
  history_scan_state: {
    cursor: string;
    pageToken: string;
    historyId: string;
  } | null;
}

/** Resumable discovery position. Contains only query/page positions, never message data. */
interface ScanState {
  mode: "BACKFILL" | "RESYNC";
  queryIndex: number;
  pageToken?: string;
  after: number;
}

interface Counters {
  discovered: number;
  headers: number;
  bodies: number;
  skippedSensitive: number;
  skippedOther: number;
  applied: number;
  reviews: number;
  failed: number;
}

class AuthAbort extends Error {}
class LeaseLost extends Error {}

const outcomeForGmail: Record<GmailError["code"], string> = {
  unauthorized: "UNAUTHORIZED",
  history_expired: "GONE",
  rate_limited: "RATE_LIMITED",
  forbidden: "FORBIDDEN",
  server: "SERVER_ERROR",
  network: "NETWORK",
  oversized: "TOO_LARGE",
};

export async function syncMailbox(
  deps: SyncDeps,
  mailboxId: string,
  scope: SyncScope,
): Promise<SyncResult> {
  const scopeId = scopeUser(scope);
  if (scopeId === false) return { mailboxId, status: "SKIPPED" };
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const started = now();
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const elapsed = () => now().getTime() - started.getTime();
  const leaseOwner = randomUUID();

  const leased = await db.query<MailboxRow>(
    `UPDATE connected_mailboxes SET sync_lease_until = $2, sync_lease_owner = $3, last_attempt_at = $4
      WHERE id = $1 AND ($5::uuid IS NULL OR user_id=$5) AND sync_state <> 'DISCONNECTED' AND (sync_lease_until IS NULL OR sync_lease_until < $4)
      RETURNING id, user_id, address, sync_state, history_cursor, backfill_complete, last_success_at, scan_state, history_scan_state`,
    [
      mailboxId,
      new Date(started.getTime() + LEASE_SECONDS * 1000).toISOString(),
      leaseOwner,
      started.toISOString(),
      scopeId,
    ],
  );
  const row = leased.rows[0];
  if (!row) {
    const existing = await db.query<{ sync_state: string }>(
      "SELECT sync_state FROM connected_mailboxes WHERE id = $1 AND ($2::uuid IS NULL OR user_id=$2)",
      [mailboxId, scopeId],
    );
    const state = existing.rows[0]?.sync_state;
    return {
      mailboxId,
      status: !state || state === "DISCONNECTED" ? "SKIPPED" : "BUSY",
    };
  }

  const mailbox: MailboxRef = {
    id: row.id,
    userId: row.user_id,
    address: row.address,
  };
  const counters: Counters = {
    discovered: 0,
    headers: 0,
    bodies: 0,
    skippedSensitive: 0,
    skippedOther: 0,
    applied: 0,
    reviews: 0,
    failed: 0,
  };
  const runId = randomUUID();
  let runKind =
    row.scan_state?.mode ??
    (!row.history_cursor || row.sync_state === "INITIALIZING"
      ? "BACKFILL"
      : row.sync_state === "RESYNC_REQUIRED"
        ? "RESYNC"
        : "INCREMENTAL");
  let status: SyncStatus = "OK";
  let errorCode: string | null = null;

  // Fence every durable mutation. A disconnected/reconnected or expired worker cannot
  // overwrite a replacement run's cursor, ingest with an old grant, or clear its lease.
  const fenced = <T>(work: (tx: Db) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      const owner = await tx.query(
        "SELECT id FROM ledger_users WHERE id=$1 FOR UPDATE",
        [mailbox.userId],
      );
      if (!owner.rows.length) throw new LeaseLost();
      const valid = await tx.query(
        `SELECT id FROM connected_mailboxes WHERE id=$1 AND
      sync_lease_owner=$2 AND sync_lease_until>$3 AND sync_state<>'DISCONNECTED' FOR UPDATE`,
        [mailboxId, leaseOwner, now().toISOString()],
      );
      if (!valid.rows.length) throw new LeaseLost();
      await tx.query(
        "UPDATE connected_mailboxes SET sync_lease_until=$3 WHERE id=$1 AND sync_lease_owner=$2",
        [
          mailboxId,
          leaseOwner,
          new Date(now().getTime() + LEASE_SECONDS * 1000).toISOString(),
        ],
      );
      return work(tx);
    });
  const setMailbox = (sets: string, params: unknown[] = []) =>
    fenced((tx) =>
      tx.query(`UPDATE connected_mailboxes SET ${sets} WHERE id = $1`, [
        mailboxId,
        ...params,
      ]),
    );

  try {
    await fenced((tx) =>
      tx.query(
        "INSERT INTO sync_runs (id, mailbox_id, kind, started_at) VALUES ($1,$2,$3,$4)",
        [runId, mailboxId, runKind, started.toISOString()],
      ),
    );
    let client: GmailClient;
    try {
      client = await deps.clientFor(mailbox);
    } catch (error) {
      const revoked =
        error instanceof OAuthError &&
        (error.code === "invalid_grant" || error.code === "invalid_client");
      const unreadable = error instanceof TokenUnreadableError;
      if (revoked || unreadable) {
        errorCode = revoked ? "TOKEN_REVOKED" : "TOKEN_UNREADABLE";
        await setMailbox("sync_state = 'DEGRADED', last_error_code = $2", [
          errorCode,
        ]);
        status = "DEGRADED";
      } else {
        errorCode = "AUTH_TEMPORARY";
        await setMailbox("sync_state='DEGRADED', last_error_code = $2", [
          errorCode,
        ]);
        status = "FAILED";
      }
      return { mailboxId, status };
    }

    let state = row.sync_state;
    let scan = row.scan_state;
    let cursor = row.history_cursor;
    let historyScan = row.history_scan_state;
    if (!cursor || scan?.mode === "BACKFILL") state = "INITIALIZING";
    else if (scan?.mode === "RESYNC") state = "RESYNC_REQUIRED";
    let discoveryDone = true;

    const registerTasks = async (
      tx: Db,
      ids: readonly string[],
    ): Promise<number> => {
      if (!ids.length) return 0;
      const r = await tx.query(
        `INSERT INTO processing_tasks (id, user_id, mailbox_id, provider_message_id)
         SELECT gen_random_uuid(), $1, $2, x FROM unnest($3::text[]) AS x
         ON CONFLICT (mailbox_id, provider_message_id) DO NOTHING`,
        [mailbox.userId, mailboxId, [...new Set(ids)]],
      );
      return r.rowCount;
    };

    /** Windowed search discovery (initial backfill, or resync after an expired cursor). Resumable. */
    const discover = async (mode: "BACKFILL" | "RESYNC"): Promise<boolean> => {
      if (!scan || scan.mode !== mode) {
        const profile = await client.getProfile();
        const lookbackMs = (deps.lookbackDays ?? 60) * 86_400_000;
        const windowStart =
          mode === "BACKFILL"
            ? started.getTime() - lookbackMs
            : row.last_success_at
              ? new Date(row.last_success_at as string | Date).getTime() -
                RESYNC_MARGIN_MS
              : started.getTime() - lookbackMs;
        scan = { mode, queryIndex: 0, after: Math.floor(windowStart / 1000) };
        cursor = profile.historyId;
        // The baseline is durable BEFORE any scanning, so mail arriving mid-scan is caught by history.
        await setMailbox(
          mode === "BACKFILL"
            ? "history_cursor = $2, scan_state = $3::jsonb, backfill_start = $4, backfill_end = $5"
            : "history_cursor = $2, scan_state = $3::jsonb",
          mode === "BACKFILL"
            ? [
                profile.historyId,
                JSON.stringify(scan),
                new Date(windowStart).toISOString(),
                started.toISOString(),
              ]
            : [profile.historyId, JSON.stringify(scan)],
        );
      }
      const queries = candidateQueries(scan.after);
      let position: ScanState = scan;
      while (position.queryIndex < queries.length) {
        const page = await client.listMessageIds(
          queries[position.queryIndex]!,
          position.pageToken,
        );
        const next: ScanState = page.nextPageToken
          ? { ...position, pageToken: page.nextPageToken }
          : {
              mode: position.mode,
              after: position.after,
              queryIndex: position.queryIndex + 1,
            };
        const finished = next.queryIndex >= queries.length;
        await fenced(async (tx) => {
          counters.discovered += await registerTasks(tx, page.ids);
          await tx.query(
            "UPDATE connected_mailboxes SET scan_state = $2::jsonb WHERE id = $1",
            [mailboxId, JSON.stringify(next)],
          );
        });
        position = next;
        scan = next;
        if (!finished && elapsed() >= budgetMs) return false;
      }
      return true;
    };

    /** history.list from the stored cursor. Tasks and the new cursor commit together. */
    const catchUp = async (): Promise<boolean> => {
      let pageToken: string | undefined =
        historyScan?.cursor === cursor ? historyScan.pageToken : undefined;
      let latest = cursor!;
      do {
        const page = await client.listHistory(cursor!, pageToken);
        latest = page.historyId;
        pageToken = page.nextPageToken;
        await fenced(async (tx) => {
          counters.discovered += await registerTasks(tx, page.ids);
          if (pageToken) {
            historyScan = { cursor: cursor!, pageToken, historyId: latest };
            await tx.query(
              "UPDATE connected_mailboxes SET history_scan_state=$2::jsonb WHERE id=$1",
              [mailboxId, JSON.stringify(historyScan)],
            );
          } else {
            await tx.query(
              "UPDATE connected_mailboxes SET history_cursor=$2,history_scan_state=NULL WHERE id=$1",
              [mailboxId, latest],
            );
            historyScan = null;
          }
        });
        if (pageToken && elapsed() >= budgetMs) return false;
      } while (pageToken);
      cursor = latest;
      return true;
    };

    try {
      if (state === "INITIALIZING") {
        discoveryDone = await discover("BACKFILL");
        if (discoveryDone) discoveryDone = await catchUp();
      } else if (state === "RESYNC_REQUIRED") {
        discoveryDone = await discover("RESYNC");
        if (discoveryDone) discoveryDone = await catchUp();
      } else {
        try {
          discoveryDone = await catchUp();
        } catch (error) {
          if (
            !(error instanceof GmailError) ||
            error.code !== "history_expired"
          )
            throw error;
          // The cursor aged out: flag the gap, then rebuild a valid checkpoint with a bounded scan.
          state = "RESYNC_REQUIRED";
          runKind = "RESYNC";
          scan = null;
          historyScan = null;
          await setMailbox(
            "sync_state = 'RESYNC_REQUIRED', scan_state = NULL, history_scan_state=NULL, last_error_code = 'CURSOR_EXPIRED'",
          );
          await fenced((tx) =>
            tx.query("UPDATE sync_runs SET kind = 'RESYNC' WHERE id = $1", [
              runId,
            ]),
          );
          discoveryDone = await discover("RESYNC");
          if (discoveryDone) discoveryDone = await catchUp();
        }
      }
    } catch (error) {
      if (error instanceof GmailError && error.code === "unauthorized")
        throw new AuthAbort();
      throw error;
    }

    // ---- process durable work, within the time budget -----------------------------------
    const concurrency = Math.max(
      1,
      Math.min(8, Math.floor(deps.concurrency ?? 4) || 1),
    );
    const sourceFor = (
      id: string,
      enveloped: boolean,
      senderAuthenticated: boolean,
    ): IngestSource =>
      enveloped
        ? { kind: "FORWARDED_EML" }
        : {
            kind: "GMAIL",
            mailboxId,
            providerMessageId: id,
            senderAuthenticated,
          };

    const finish = (id: string, outcome: string) =>
      fenced((tx) =>
        tx.query(
          "UPDATE processing_tasks SET state = 'DONE', outcome = $2, finished_at = $3 WHERE id = $1",
          [id, outcome, now().toISOString()],
        ),
      );

    const retry = async (
      id: string,
      attemptsSoFar: number,
      outcome: string,
    ) => {
      const attempts = attemptsSoFar + 1;
      if (attempts >= MAX_TASK_ATTEMPTS) {
        counters.failed += 1;
        await fenced((tx) =>
          tx.query(
            "UPDATE processing_tasks SET state = 'FAILED', outcome = $2, attempts = $3, finished_at = $4, safe_error_code = $2 WHERE id = $1",
            [id, outcome, attempts, now().toISOString()],
          ),
        );
        return;
      }
      const backoff = Math.min(30 * 2 ** attempts, 3600) * 1000;
      await fenced((tx) =>
        tx.query(
          "UPDATE processing_tasks SET attempts = $2, outcome = $3, safe_error_code = $3, next_attempt_at = $4 WHERE id = $1",
          [
            id,
            attempts,
            outcome,
            new Date(now().getTime() + backoff).toISOString(),
          ],
        ),
      );
    };

    const processTask = async (task: {
      id: string;
      provider_message_id: string;
      attempts: number;
    }): Promise<void> => {
      const id = task.provider_message_id;
      try {
        const claimed = await fenced(async (tx) => {
          if (task.attempts >= MAX_TASK_ATTEMPTS) {
            await tx.query(
              "UPDATE processing_tasks SET state='FAILED',outcome='CRASHED_OR_TIMED_OUT',safe_error_code='CRASHED_OR_TIMED_OUT',finished_at=$2 WHERE id=$1",
              [task.id, now().toISOString()],
            );
            counters.failed += 1;
            return false;
          }
          const attempts = task.attempts + 1;
          await tx.query(
            "UPDATE processing_tasks SET attempts=$2,next_attempt_at=$3 WHERE id=$1",
            [
              task.id,
              attempts,
              new Date(
                now().getTime() + Math.min(30 * 2 ** attempts, 3600) * 1000,
              ).toISOString(),
            ],
          );
          return true;
        });
        if (!claimed) return;
        const headers = await client.getHeaders(id);
        counters.headers += 1;
        if (!headers) return void (await finish(task.id, "GONE"));
        if (headers.labelIds.some((l) => l === "SENT" || l === "DRAFT")) {
          counters.skippedOther += 1;
          return void (await finish(task.id, "SKIPPED_OUTBOUND"));
        }
        const gate = classifyHeaders({
          from: headers.from,
          subject: headers.subject,
        });
        if (gate.kind === "SKIP_SENSITIVE") {
          counters.skippedSensitive += 1;
          return void (await finish(task.id, "SKIPPED_SENSITIVE"));
        }
        if (gate.kind !== "CANDIDATE") {
          counters.skippedOther += 1;
          return void (await finish(
            task.id,
            gate.kind === "SKIP_UNRELATED"
              ? "SKIPPED_UNRELATED"
              : "SKIPPED_UNCERTAIN",
          ));
        }
        await fenced(async () => undefined);
        const raw = await client.getRaw(id);
        if (!raw) return void (await finish(task.id, "GONE"));
        counters.bodies += 1;
        let originals;
        try {
          originals = await parseEml(raw);
        } catch (error) {
          const code = error instanceof EmlError ? error.code : "MALFORMED";
          counters.skippedOther += 1;
          return void (await finish(
            task.id,
            code === "INLINE_FORWARD"
              ? "SKIPPED_INLINE_FORWARD"
              : `QUARANTINED_${code}`,
          ));
        }
        let outcome = "NO_SIGNAL";
        for (const original of originals) {
          const result = await fenced((tx) =>
            ingestOriginal(tx, {
              userId: mailbox.userId,
              source: sourceFor(
                id,
                original.envelopeDate !== null,
                headers.senderAuthenticated === true,
              ),
              original,
              observedAt: now(),
            }),
          );
          if (result.status === "APPLIED") {
            counters.applied += 1 + result.reconciled;
            outcome = "PROCESSED";
          } else if (result.status === "REVIEW") {
            counters.reviews += 1;
            outcome = "PROCESSED";
          } else if (result.status === "SKIPPED_SENSITIVE")
            counters.skippedSensitive += 1;
          else if (
            outcome === "NO_SIGNAL" &&
            (result.status === "DUPLICATE" ||
              result.status === "DUPLICATE_OBSERVATION")
          )
            outcome = "PROCESSED";
        }
        await finish(task.id, outcome);
      } catch (error) {
        if (error instanceof LeaseLost || error instanceof AuthAbort)
          throw error;
        if (error instanceof GmailError) {
          if (error.code === "unauthorized") throw new AuthAbort();
          if (error.code === "oversized") {
            counters.skippedOther += 1;
            return void (await finish(task.id, "QUARANTINED_TOO_LARGE"));
          }
          return retry(task.id, task.attempts, outcomeForGmail[error.code]);
        }
        return retry(task.id, task.attempts, "INTERNAL");
      }
    };

    const dueSql =
      "SELECT id, provider_message_id, attempts FROM processing_tasks WHERE mailbox_id = $1 AND state = 'PENDING' AND next_attempt_at <= $2 ORDER BY created_at, id LIMIT $3";
    while (elapsed() < budgetMs) {
      const batch = await db.query<{
        id: string;
        provider_message_id: string;
        attempts: number;
      }>(dueSql, [mailboxId, now().toISOString(), concurrency * 4]);
      if (!batch.rows.length) break;
      const queue = [...batch.rows];
      const outcomes = await Promise.allSettled(
        Array.from({ length: concurrency }, async () => {
          for (let task = queue.shift(); task; task = queue.shift())
            await processTask(task);
        }),
      );
      const aborted = outcomes.find((r) => r.status === "rejected");
      if (aborted?.status === "rejected") throw aborted.reason;
    }

    const due = await db.query(
      "SELECT 1 FROM processing_tasks WHERE mailbox_id = $1 AND state = 'PENDING' AND next_attempt_at <= $2 LIMIT 1",
      [mailboxId, now().toISOString()],
    );
    const pending = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM processing_tasks WHERE mailbox_id = $1 AND state = 'PENDING'",
      [mailboxId],
    );
    const failed = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM processing_tasks WHERE mailbox_id=$1 AND state='FAILED' AND outcome<>'DISCONNECTED'",
      [mailboxId],
    );
    if (!discoveryDone || due.rows.length || Number(pending.rows[0]!.n) > 0)
      status = "PARTIAL";
    if (Number(failed.rows[0]!.n) > 0) {
      status = "DEGRADED";
      errorCode = "PROCESSING_INCOMPLETE";
      await setMailbox(
        "sync_state='DEGRADED',backfill_complete=false,last_error_code=$2",
        [errorCode],
      );
    }
    if (
      discoveryDone &&
      Number(pending.rows[0]!.n) === 0 &&
      Number(failed.rows[0]!.n) === 0
    ) {
      await setMailbox("last_success_at=$2", [now().toISOString()]);
    }

    if (
      discoveryDone &&
      Number(pending.rows[0]!.n) === 0 &&
      Number(failed.rows[0]!.n) === 0 &&
      (state === "INITIALIZING" ||
        state === "RESYNC_REQUIRED" ||
        state === "DEGRADED")
    ) {
      await setMailbox(
        "sync_state = 'HEALTHY', backfill_complete = backfill_complete OR $2, scan_state=NULL, last_error_code = NULL",
        [state === "INITIALIZING"],
      );
    } else if (
      discoveryDone &&
      state === "HEALTHY" &&
      Number(failed.rows[0]!.n) === 0
    ) {
      await setMailbox("last_error_code = NULL");
    }
    return { mailboxId, status };
  } catch (error) {
    if (error instanceof LeaseLost) {
      status = "BUSY";
      errorCode = "LEASE_LOST";
      return { mailboxId, status };
    }
    if (error instanceof AuthAbort) {
      errorCode = "TOKEN_REVOKED";
      await setMailbox("sync_state = 'DEGRADED', last_error_code = $2", [
        errorCode,
      ]);
      status = "DEGRADED";
      return { mailboxId, status };
    }
    errorCode =
      error instanceof GmailError ? outcomeForGmail[error.code] : "INTERNAL";
    status = "FAILED";
    await setMailbox("sync_state='DEGRADED',last_error_code = $2", [
      errorCode,
    ]).catch(() => undefined);
    return { mailboxId, status };
  } finally {
    await db
      .query(
        `UPDATE sync_runs SET finished_at = $2, state = $3, safe_error_code = $4, discovered_count = $5, headers_inspected = $6, bodies_fetched = $7,
         skipped_sensitive = $8, skipped_other = $9, signals_applied = $10, reviews_created = $11, tasks_failed = $12 WHERE id = $1`,
        [
          runId,
          now().toISOString(),
          status === "FAILED" || status === "DEGRADED" ? "FAILED" : "COMPLETED",
          errorCode,
          counters.discovered,
          counters.headers,
          counters.bodies,
          counters.skippedSensitive,
          counters.skippedOther,
          counters.applied,
          counters.reviews,
          counters.failed,
        ],
      )
      .catch(() => undefined);
    await db
      .query(
        "UPDATE connected_mailboxes SET sync_lease_until = NULL, sync_lease_owner = NULL WHERE id = $1 AND sync_lease_owner=$2",
        [mailboxId, leaseOwner],
      )
      .catch(() => undefined);
  }
}

/** Runs every connected mailbox in turn. A failing mailbox never blocks the others. */
export async function syncAllMailboxes(
  deps: SyncDeps,
  scope: SyncScope,
): Promise<SyncResult[]> {
  const userId = scopeUser(scope);
  if (userId === false) return [];
  const now = deps.now ?? (() => new Date());
  const started = now().getTime();
  const total = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const { rows } = await deps.db.query<{ id: string }>(
    `SELECT id FROM connected_mailboxes WHERE sync_state <> 'DISCONNECTED' AND ($1::uuid IS NULL OR user_id = $1::uuid) ORDER BY created_at, id`,
    [userId ?? null],
  );
  const results: SyncResult[] = [];
  for (const [index, mailbox] of rows.entries()) {
    const remaining = Math.max(0, total - (now().getTime() - started));
    results.push(
      await syncMailbox(
        { ...deps, budgetMs: remaining / (rows.length - index) },
        mailbox.id,
        scope,
      ),
    );
  }
  return results;
}
