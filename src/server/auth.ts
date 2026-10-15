import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";

export function isAllowed(email: string, allowed: readonly string[]): boolean {
  const candidate = email.trim().toLowerCase();
  return candidate.length > 0 && allowed.includes(candidate);
}

/** One Ledger user per Google login subject. The address is informational and may change. */
export async function upsertLoginUser(
  db: Db,
  subject: string,
  email: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ledger_users (id, login_subject, login_email) VALUES ($1, $2, $3)
     ON CONFLICT (login_subject) DO UPDATE SET login_email = EXCLUDED.login_email
     RETURNING id`,
    [randomUUID(), subject, email],
  );
  return rows[0]!.id;
}
