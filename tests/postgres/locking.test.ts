import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { fromPool } from "../../src/server/db.ts";
import { applyMigrations } from "../../src/server/migrate.ts";
import { ingestOriginal } from "../../src/server/pipeline.ts";
import { setAttemptStatus } from "../../src/server/actions.ts";
import { syncMailbox } from "../../src/server/gmail/sync.ts";
import { parseEml } from "../../src/ingestion/eml.ts";
import { sampleEmail } from "../../src/server/demo.ts";
import { seedUser, seedMailbox } from "../helpers/db.ts";
import { FakeGmail } from "../helpers/fake-gmail.ts";
import { greenhouseConfirmation } from "../helpers/fixtures.ts";

if (!process.env.DATABASE_URL)
  throw new Error(
    "DATABASE_URL must point to an isolated development PostgreSQL database",
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const db = fromPool(pool);
const owners: string[] = [];
async function owner() {
  const id = await seedUser(db);
  owners.push(id);
  return id;
}
before(async () => {
  await applyMigrations(
    db,
    new URL("../../migrations", import.meta.url).pathname,
  );
});
after(async () => {
  for (const id of owners)
    await db.query("DELETE FROM ledger_users WHERE id=$1", [id]);
  await pool.end();
});
test("real PostgreSQL: concurrent replay creates one attempt and one event", async () => {
  const user = await owner(),
    [original] = await parseEml(Buffer.from(sampleEmail()));
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      ingestOriginal(db, {
        userId: user,
        source: { kind: "FORWARDED_EML" },
        original: original!,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "APPLIED").length, 1);
  assert.equal(
    (
      await db.query("SELECT id FROM application_attempts WHERE user_id=$1", [
        user,
      ])
    ).rows.length,
    1,
  );
  assert.equal(
    (
      await db.query("SELECT id FROM application_events WHERE user_id=$1", [
        user,
      ])
    ).rows.length,
    1,
  );
});
test("real PostgreSQL: concurrent manual correction and ingestion preserve the complete projection", async () => {
  const user = await owner(),
    [first] = await parseEml(Buffer.from(sampleEmail()));
  const seeded = await ingestOriginal(db, {
    userId: user,
    source: { kind: "FORWARDED_EML" },
    original: first!,
  });
  assert.equal(seeded.status, "APPLIED");
  if (seeded.status !== "APPLIED") throw new Error("Expected a seeded attempt");
  const [interview] = await parseEml(
    Buffer.from(
      sampleEmail({
        id: "concurrent-interview",
        phrase: "Please schedule your interview.",
        daysAgo: 2,
      }),
    ),
  );
  await Promise.all([
    setAttemptStatus(db, user, seeded.attemptId, {
      stage: "ASSESSMENT",
      outcome: "PENDING",
    }),
    ingestOriginal(db, {
      userId: user,
      source: { kind: "FORWARDED_EML" },
      original: interview!,
    }),
  ]);
  const row = (
    await db.query<{ stage: string; outcome: string }>(
      "SELECT stage,outcome FROM application_attempts WHERE id=$1",
      [seeded.attemptId],
    )
  ).rows[0]!;
  assert.deepEqual(row, { stage: "ASSESSMENT", outcome: "PENDING" });
  assert.equal(
    (
      await db.query("SELECT id FROM application_events WHERE user_id=$1", [
        user,
      ])
    ).rows.length,
    3,
  );
});
test("real PostgreSQL: a replaced lease fences a still-running worker", async () => {
  const user = await owner(),
    mailbox = await seedMailbox(db, user),
    fake = new FakeGmail();
  fake.add("message", greenhouseConfirmation());
  const at = new Date("2026-10-20T00:00:00Z");
  let signal!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
      signal = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  const raw = fake.getRaw.bind(fake);
  fake.getRaw = async (id) => {
    signal();
    await blocked;
    return raw(id);
  };
  const running = syncMailbox(
    { db, clientFor: async () => fake, now: () => at },
    mailbox,
    { userId: user },
  );
  await reached;
  await db.query(
    "UPDATE connected_mailboxes SET sync_lease_owner='replacement',sync_lease_until=$2 WHERE id=$1",
    [mailbox, new Date(at.getTime() + 600000).toISOString()],
  );
  release();
  assert.equal((await running).status, "BUSY");
  assert.equal(
    (
      await db.query<{ sync_lease_owner: string }>(
        "SELECT sync_lease_owner FROM connected_mailboxes WHERE id=$1",
        [mailbox],
      )
    ).rows[0]!.sync_lease_owner,
    "replacement",
  );
  assert.equal(
    (
      await db.query("SELECT id FROM application_events WHERE user_id=$1", [
        user,
      ])
    ).rows.length,
    0,
  );
});
