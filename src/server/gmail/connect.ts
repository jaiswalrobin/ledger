import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { refreshAccessToken, revokeToken } from "../security/oauth.ts";
import { createGmailClient, type GmailClient } from "./client.ts";
import type { MailboxRef } from "./sync.ts";
import { decryptToken, encryptToken } from "./vault.ts";

export class MailboxNotFound extends Error {
  constructor() {
    super("MAILBOX_NOT_FOUND");
  }
}

const READ_ONLY_GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
const IDENTITY_SCOPES = new Set([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]);

/** The grant must include Gmail read access and nothing that could modify, send or delete mail. */
export function grantedScopesAreReadOnly(scope: string): boolean {
  const scopes = scope.split(/\s+/).filter(Boolean);
  return (
    scopes.includes(READ_ONLY_GMAIL) &&
    scopes.every((s) => s === READ_ONLY_GMAIL || IDENTITY_SCOPES.has(s))
  );
}

/**
 * Creates or refreshes the mailbox row for a Google account the owner just authorised.
 * The refresh token is encrypted with the row id as authenticated data before it is stored.
 */
export async function connectMailbox(
  db: Db,
  tokenKey: Buffer,
  userId: string,
  identity: { sub: string; email: string },
  refreshToken: string,
  now = new Date(),
): Promise<{ mailboxId: string; reconnected: boolean }> {
  return db.transaction(async (tx) => {
    if (
      !(
        await tx.query("SELECT id FROM ledger_users WHERE id=$1 FOR UPDATE", [
          userId,
        ])
      ).rows.length
    )
      throw new MailboxNotFound();
    const existing = await tx.query<{
      id: string;
      history_cursor: string | null;
    }>(
      "SELECT id, history_cursor FROM connected_mailboxes WHERE user_id = $1 AND provider = 'GMAIL' AND provider_subject = $2 FOR UPDATE",
      [userId, identity.sub],
    );
    const address = identity.email.trim().toLowerCase();
    const found = existing.rows[0];
    if (found) {
      // A reconnect may follow a gap, so a prior cursor means "resync over the gap", not "trust it".
      await tx.query(
        `UPDATE connected_mailboxes SET encrypted_refresh_token = $3, token_key_version = 1, address = $4,
                sync_state = $5, last_error_code = NULL, disconnected_at = NULL, scan_state = NULL, history_scan_state=NULL,
                sync_lease_until = NULL, sync_lease_owner = NULL
          WHERE id = $1 AND user_id = $2`,
        [
          found.id,
          userId,
          encryptToken(tokenKey, refreshToken, found.id),
          address,
          found.history_cursor ? "RESYNC_REQUIRED" : "INITIALIZING",
        ],
      );
      await tx.query(
        `UPDATE processing_tasks SET state='PENDING', outcome=NULL, safe_error_code=NULL,
          attempts=0, next_attempt_at=$3, finished_at=NULL
         WHERE mailbox_id=$1 AND user_id=$2 AND state='FAILED' AND outcome='DISCONNECTED'`,
        [found.id, userId, now.toISOString()],
      );
      return { mailboxId: found.id, reconnected: true };
    }
    const id = randomUUID();
    await tx.query(
      `INSERT INTO connected_mailboxes (id, user_id, provider, provider_subject, address, encrypted_refresh_token, token_key_version, sync_state)
       VALUES ($1, $2, 'GMAIL', $3, $4, $5, 1, 'INITIALIZING')`,
      [
        id,
        userId,
        identity.sub,
        address,
        encryptToken(tokenKey, refreshToken, id),
      ],
    );
    return { mailboxId: id, reconnected: false };
  });
}

/** Revokes at Google (best effort), wipes the token, fails pending work. Accepted history is kept. */
export async function disconnectMailbox(
  db: Db,
  tokenKey: Buffer,
  userId: string,
  mailboxId: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ revoked: boolean }> {
  const row = await db.transaction(async (tx) => {
    const found = await tx.query<{ encrypted_refresh_token: Buffer | null }>(
      "SELECT encrypted_refresh_token FROM connected_mailboxes WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [mailboxId, userId],
    );
    if (!found.rows[0]) throw new MailboxNotFound();
    await tx.query(
      `UPDATE connected_mailboxes SET encrypted_refresh_token = NULL, sync_state = 'DISCONNECTED', disconnected_at = now(),
              scan_state = NULL, history_scan_state=NULL, sync_lease_until = NULL, sync_lease_owner = NULL
        WHERE id = $1 AND user_id = $2`,
      [mailboxId, userId],
    );
    await tx.query(
      "UPDATE processing_tasks SET state = 'FAILED', outcome = 'DISCONNECTED', safe_error_code = 'DISCONNECTED', finished_at = now() WHERE mailbox_id = $1 AND user_id = $2 AND state = 'PENDING'",
      [mailboxId, userId],
    );
    return found.rows[0];
  });
  // Stop access locally first; provider slowness or a revoke failure cannot keep it active.
  let revoked = false;
  if (row.encrypted_refresh_token) {
    try {
      revoked = await revokeToken(
        decryptToken(
          tokenKey,
          Buffer.from(row.encrypted_refresh_token),
          mailboxId,
        ),
        fetchFn,
      );
    } catch {
      revoked = false;
    }
  }
  return { revoked };
}

/** The sole production path that decrypts a refresh token: returns a Gmail client for one run. */
export function gmailClientFactory(
  db: Db,
  cfg: { tokenKey: Buffer; clientId: string; clientSecret: string },
  fetchFn: typeof fetch = fetch,
): (mailbox: MailboxRef) => Promise<GmailClient> {
  return async (mailbox) => {
    const { rows } = await db.query<{ encrypted_refresh_token: Buffer | null }>(
      "SELECT encrypted_refresh_token FROM connected_mailboxes WHERE id = $1 AND user_id = $2",
      [mailbox.id, mailbox.userId],
    );
    const blob = rows[0]?.encrypted_refresh_token;
    if (!blob) throw new MailboxNotFound();
    const refreshToken = decryptToken(
      cfg.tokenKey,
      Buffer.from(blob),
      mailbox.id,
    );
    const accessToken = await refreshAccessToken({
      fetchFn,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      refreshToken,
    });
    return createGmailClient(accessToken, fetchFn);
  };
}
