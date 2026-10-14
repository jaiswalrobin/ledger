import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { applyMigrations } from "../src/server/migrate.ts";
import type { Db } from "../src/server/db.ts";
import {
  createTestDb,
  MIGRATIONS_DIR,
  seedMailbox,
  seedUser,
  type TestDb,
} from "./helpers/db.ts";

let t: TestDb;
let db: Db;
before(async () => {
  t = await createTestDb();
  db = t.db;
});
after(() => t.close());

async function rejects(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

async function seedOpening(userId: string): Promise<string> {
  const companyId = randomUUID();
  const openingId = randomUUID();
  await db.query(
    "INSERT INTO companies (id, user_id, canonical_name, name_key) VALUES ($1,$2,'Acme',$3)",
    [companyId, userId, "acme-" + companyId],
  );
  await db.query(
    "INSERT INTO job_openings (id, user_id, company_id, title) VALUES ($1,$2,$3,'Engineer')",
    [openingId, userId, companyId],
  );
  return openingId;
}

async function seedAttempt(
  userId: string,
  openingId: string,
  email: string | null,
): Promise<string> {
  const id = randomUUID();
  await db.query(
    "INSERT INTO application_attempts (id, user_id, job_opening_id, applicant_email_snapshot) VALUES ($1,$2,$3,$4)",
    [id, userId, openingId, email],
  );
  return id;
}

describe("schema", () => {
  it("rejects changed contents of an applied migration", async () => {
    const copy = await mkdtemp(join(tmpdir(), "ledger-migrations-"));
    try {
      for (const file of await readdir(MIGRATIONS_DIR))
        if (file.endsWith(".sql"))
          await writeFile(
            join(copy, file),
            await readFile(join(MIGRATIONS_DIR, file)),
          );
      await writeFile(
        join(copy, "0001_core.sql"),
        (await readFile(join(copy, "0001_core.sql"), "utf8")) +
          "\n-- changed after application\n",
      );
      await assert.rejects(
        applyMigrations(db, copy),
        /MIGRATION_CHECKSUM_MISMATCH/,
      );
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });
  it("applies every migration once and is a no-op the second time", async () => {
    const again = await applyMigrations(db, MIGRATIONS_DIR);
    assert.deepEqual(again, []);
    const { rows } = await db.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    assert.deepEqual(
      rows.map((r) => r.name),
      [
        "0001_core.sql",
        "0002_ingestion.sql",
        "0003_sync_fencing.sql",
        "0004_browser_sessions.sql",
        "0005_sender_trust.sql",
        "0006_demo_retention.sql",
        "0007_submission_date_corrections.sql",
        "0008_mailbox_recheck.sql",
        "0009_calendar_uid_index.sql",
      ],
    );
  });

  it("allows repeated attempts for one opening with the SAME email (no identity key)", async () => {
    const user = await seedUser(db);
    const opening = await seedOpening(user);
    await seedAttempt(user, opening, "me@example.com");
    await seedAttempt(user, opening, "me@example.com");
    const { rows } = await db.query(
      "SELECT 1 FROM application_attempts WHERE job_opening_id = $1",
      [opening],
    );
    assert.equal(rows.length, 2);
  });

  it("refuses to link an attempt to another user's opening", async () => {
    const alice = await seedUser(db);
    const mallory = await seedUser(db);
    const aliceOpening = await seedOpening(alice);
    await rejects(seedAttempt(mallory, aliceOpening, null), /foreign key/i);
  });

  it("dedupes accepted events per user by dedupe_key", async () => {
    const user = await seedUser(db);
    const attempt = await seedAttempt(user, await seedOpening(user), null);
    const insert = () =>
      db.query(
        `INSERT INTO application_events (id, user_id, attempt_id, event_kind, occurred_at, review_state, source_type, dedupe_key)
       VALUES ($1,$2,$3,'CONFIRMATION_RECEIVED', now(), 'ACCEPTED', 'GMAIL', 'k1')`,
        [randomUUID(), user, attempt],
      );
    await insert();
    await rejects(insert(), /unique|duplicate/i);
  });

  it("registers each Gmail message once per mailbox, but allows the same id in another mailbox", async () => {
    const user = await seedUser(db);
    const m1 = await seedMailbox(db, user, "a@example.com");
    const m2 = await seedMailbox(db, user, "b@example.com");
    const artifact = (mailbox: string) =>
      db.query(
        `INSERT INTO source_artifacts (id, user_id, source_kind, mailbox_id, provider_message_id, source_fingerprint)
       VALUES ($1,$2,'GMAIL',$3,'msg-1','fp')`,
        [randomUUID(), user, mailbox],
      );
    await artifact(m1);
    await artifact(m2);
    await rejects(artifact(m1), /unique|duplicate/i);
  });

  it("keeps one work task per mailbox message", async () => {
    const user = await seedUser(db);
    const mailbox = await seedMailbox(db, user);
    const task = () =>
      db.query(
        "INSERT INTO processing_tasks (id, user_id, mailbox_id, provider_message_id) VALUES ($1,$2,$3,'m1')",
        [randomUUID(), user, mailbox],
      );
    await task();
    await rejects(task(), /unique|duplicate/i);
  });

  it("requires a payload for manual corrections", async () => {
    const user = await seedUser(db);
    const attempt = await seedAttempt(user, await seedOpening(user), null);
    await rejects(
      db.query(
        `INSERT INTO application_events (id, user_id, attempt_id, event_kind, occurred_at, review_state, source_type, dedupe_key)
       VALUES ($1,$2,$3,'MANUAL_CORRECTION', now(), 'ACCEPTED', 'MANUAL', 'm')`,
        [randomUUID(), user, attempt],
      ),
      /check/i,
    );
  });
});
