import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { fromPool } from "../../src/server/db.ts";
import { applyMigrations } from "../../src/server/migrate.ts";
import { ingestOriginal } from "../../src/server/pipeline.ts";
import { setAttemptStatus } from "../../src/server/actions.ts";
import { syncMailbox } from "../../src/server/gmail/sync.ts";
import { requestMailboxRecheck } from "../../src/server/gmail/recheck.ts";
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
test("real PostgreSQL: concurrent recheck requests queue one generation and preserve an active sync", async () => {
  const userId = await owner(), mailboxId = await seedMailbox(db, userId);
  const now = new Date();
  const results = await Promise.all(Array.from({ length: 4 }, () => requestMailboxRecheck(db, userId, mailboxId, now)));
  assert.equal(results.filter(r => r === "QUEUED").length, 1);
  assert.equal(results.filter(r => r === "IN_PROGRESS").length, 3);
  await db.query("UPDATE connected_mailboxes SET sync_lease_until=$2 WHERE id=$1", [mailboxId,new Date(now.getTime()+60000).toISOString()]);
  assert.equal(await requestMailboxRecheck(db, userId, mailboxId, now), "BUSY");
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

test("real PostgreSQL: a populated legacy schema upgrades without losing company/opening identities", async () => {
  const { mkdtemp, readFile, writeFile, readdir, rm } =
    await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { randomUUID } = await import("node:crypto");
  const schema = "ledger_upgrade_" + randomUUID().replaceAll("-", "");
  const directory = await mkdtemp(join(tmpdir(), "ledger-native-upgrade-"));
  const source = new URL("../../migrations", import.meta.url).pathname;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const isolatedPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    options: `-c search_path=${schema}`,
  });
  const isolated = fromPool(isolatedPool);
  try {
    await writeFile(
      join(directory, "0001_core.sql"),
      await readFile(join(source, "0001_core.sql")),
    );
    await applyMigrations(isolated, directory);
    const user = await seedUser(isolated),
      ids = [randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      await isolated.query(
        "INSERT INTO companies(id,user_id,canonical_name)VALUES($1,$2,$3)",
        [id, user, index ? " ACME  Labs " : "Acme Labs"],
      );
      await isolated.query(
        "INSERT INTO job_openings(id,user_id,company_id,title)VALUES($1,$2,$3,'Engineer')",
        [randomUUID(), user, id],
      );
    }
    for (const file of await readdir(source))
      await writeFile(
        join(directory, file),
        await readFile(join(source, file)),
      );
    assert.equal((await applyMigrations(isolated, directory)).length, (await readdir(source)).filter(file=>file.endsWith(".sql")).length - 1);
    assert.equal(
      (await isolated.query("SELECT id FROM companies")).rows.length,
      2,
    );
    assert.equal(
      (await isolated.query("SELECT id FROM job_openings")).rows.length,
      2,
    );
    assert.deepEqual(await applyMigrations(isolated, directory), []);
  } finally {
    await isolatedPool.end();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await rm(directory, { recursive: true, force: true });
  }
});
