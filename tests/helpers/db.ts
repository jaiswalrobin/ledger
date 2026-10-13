import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, type Db } from "../../src/server/db.ts";
import { applyMigrations } from "../../src/server/migrate.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

export interface TestDb {
  db: Db;
  close(): Promise<void>;
}

/** In-process Postgres with every migration applied. Create one per test file. */
export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  const db = fromPglite(pg);
  await applyMigrations(db, MIGRATIONS_DIR);
  return { db, close: () => pg.close() };
}

export async function seedUser(db: Db): Promise<string> {
  const id = randomUUID();
  await db.query("INSERT INTO ledger_users (id) VALUES ($1)", [id]);
  return id;
}

export async function seedMailbox(db: Db, userId: string, address = "test@example.com"): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO connected_mailboxes (id, user_id, provider, provider_subject, address, encrypted_refresh_token)
     VALUES ($1, $2, 'GMAIL', $3, $4, '\\x00')`,
    [id, userId, "sub-" + id, address],
  );
  return id;
}
