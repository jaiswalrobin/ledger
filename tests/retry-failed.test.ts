import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { retryFailedTasks } from "../src/server/gmail/recheck.ts";
import type { Db } from "../src/server/db.ts";
import {
  createTestDb,
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

const AT = new Date("2026-01-02T03:04:05.678Z");

async function failedTask(userId: string, mailboxId: string, message: string) {
  await db.query(
    `INSERT INTO processing_tasks (id, user_id, mailbox_id, provider_message_id, state, outcome, safe_error_code, attempts, finished_at, next_attempt_at)
     VALUES ($1, $2, $3, $4, 'FAILED', 'FETCH_ERROR', 'FETCH_ERROR', 5, now(), '2030-01-01T00:00:00Z')`,
    [randomUUID(), userId, mailboxId, message],
  );
}
const task = async (mailboxId: string, message: string) =>
  (
    await db.query<{
      state: string;
      attempts: number;
      outcome: string | null;
      safe_error_code: string | null;
      next_attempt_at: unknown;
    }>(
      "SELECT state, attempts, outcome, safe_error_code, next_attempt_at FROM processing_tasks WHERE mailbox_id = $1 AND provider_message_id = $2",
      [mailboxId, message],
    )
  ).rows[0]!;

describe("retryFailedTasks", () => {
  it("returns the owner's failed work to the queue, due at the supplied time", async () => {
    const user = await seedUser(db);
    const mailbox = await seedMailbox(db, user);
    await failedTask(user, mailbox, "m1");
    await retryFailedTasks(db, user, mailbox, AT);
    const after = await task(mailbox, "m1");
    assert.equal(after.state, "PENDING");
    assert.equal(after.attempts, 0);
    assert.equal(after.outcome, null);
    assert.equal(after.safe_error_code, null);
    assert.equal(
      new Date(after.next_attempt_at as string | Date).toISOString(),
      AT.toISOString(),
    );
  });

  it("leaves another user's work and a disconnected mailbox's work alone", async () => {
    const owner = await seedUser(db);
    const intruder = await seedUser(db);
    const mailbox = await seedMailbox(db, owner);
    const gone = await seedMailbox(db, owner, "gone@example.com");
    await db.query(
      "UPDATE connected_mailboxes SET sync_state = 'DISCONNECTED' WHERE id = $1",
      [gone],
    );
    await failedTask(owner, mailbox, "m1");
    await failedTask(owner, gone, "m2");
    await retryFailedTasks(db, intruder, mailbox, AT);
    await retryFailedTasks(db, owner, gone, AT);
    assert.equal((await task(mailbox, "m1")).state, "FAILED");
    assert.equal((await task(gone, "m2")).state, "FAILED");
  });

  it("does not touch finished work", async () => {
    const user = await seedUser(db);
    const mailbox = await seedMailbox(db, user);
    await db.query(
      "INSERT INTO processing_tasks (id, user_id, mailbox_id, provider_message_id, state, outcome) VALUES ($1, $2, $3, 'done', 'DONE', 'PROCESSED')",
      [randomUUID(), user, mailbox],
    );
    await retryFailedTasks(db, user, mailbox, AT);
    assert.equal((await task(mailbox, "done")).state, "DONE");
  });
});
