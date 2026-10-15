import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Db } from "../src/server/db.ts";
import { runScheduledSync, summarize } from "../src/server/scheduler.ts";
import { syncAllMailboxes } from "../src/server/gmail/sync.ts";
import { seedDemo } from "../src/server/demo.ts";
import { FakeGmail } from "./helpers/fake-gmail.ts";
import {
  createTestDb,
  seedMailbox,
  seedUser,
  type TestDb,
} from "./helpers/db.ts";
import { greenhouseConfirmation } from "./helpers/fixtures.ts";

let t: TestDb;
let db: Db;
before(async () => {
  t = await createTestDb();
  db = t.db;
});
after(() => t.close());

const NOW = new Date("2026-10-20T12:00:00Z");

describe("scheduler report", () => {
  it("classifies runs: failures fail, degraded mailboxes need attention, the rest are healthy", () => {
    const base = { gmailConfigured: true, demosPruned: 0, pruneFailed: false };
    const run = (
      status: "OK" | "PARTIAL" | "BUSY" | "DEGRADED" | "FAILED" | "SKIPPED",
    ) => ({ mailboxId: "m", status });
    assert.equal(
      summarize([run("OK"), run("PARTIAL"), run("BUSY")], base).outcome,
      "healthy",
    );
    assert.equal(
      summarize([run("OK"), run("DEGRADED")], base).outcome,
      "attention",
    );
    assert.equal(
      summarize([run("DEGRADED"), run("FAILED")], base).outcome,
      "failed",
    );
    assert.equal(
      summarize([], { ...base, pruneFailed: true }).outcome,
      "attention",
    );
    const report = summarize([run("OK"), run("OK"), run("FAILED")], base);
    assert.equal(report.mailboxes, 3);
    assert.equal(report.statuses.OK, 2);
    assert.equal(report.statuses.FAILED, 1);
  });

  it("contains counts only: no mailbox ids or addresses", async () => {
    const userId = await seedUser(db);
    await seedMailbox(db, userId, "private-address@example.org");
    const fake = new FakeGmail();
    fake.add("m1", greenhouseConfirmation());
    const report = await runScheduledSync({
      db,
      sync: { clientFor: async () => fake, now: () => NOW, budgetMs: 60_000 },
    });
    const text = JSON.stringify(report);
    assert.ok(
      !text.includes("private-address"),
      "address leaked into the report",
    );
    assert.ok(
      !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text),
      "an id leaked into the report",
    );
    assert.equal(report.gmailConfigured, true);
    assert.ok(report.mailboxes >= 1);
  });

  it("reports an unconfigured deployment instead of pretending to sync", async () => {
    const report = await runScheduledSync({ db, sync: null });
    assert.equal(report.gmailConfigured, false);
    assert.equal(report.mailboxes, 0);
  });

  it("a failed demo cleanup never blocks mailbox sync", async () => {
    let synced = false;
    const broken: Db = {
      ...db,
      query: (async (sql: string, params?: unknown[]) => {
        if (/demo_workspaces/.test(sql)) throw new Error("cleanup broke");
        if (
          /FROM connected_mailboxes WHERE sync_state <> 'DISCONNECTED'/.test(
            sql,
          )
        )
          synced = true;
        return db.query(sql, params as never);
      }) as Db["query"],
    };
    const report = await runScheduledSync({
      db: broken,
      sync: {
        clientFor: async () => new FakeGmail(),
        now: () => NOW,
        budgetMs: 1_000,
      },
    });
    assert.equal(report.pruneFailed, true);
    assert.ok(synced, "mailbox sync did not run after the cleanup failed");
    assert.notEqual(report.outcome, "healthy");
  });
});

describe("demo cleanup accounting", () => {
  it("reports deletions that committed before a later cleanup step failed", async () => {
    const a = await seedDemo(db),
      b = await seedDemo(db);
    await db.query(
      "UPDATE demo_workspaces SET expires_at = now() - interval '1 day' WHERE user_id = ANY($1::uuid[])",
      [[a, b]],
    );
    const failing: Db = {
      ...db,
      query: (async (sql: string, params?: unknown[]) => {
        if (/DELETE FROM browser_rate_limits/.test(sql))
          throw new Error("late failure");
        return db.query(sql, params as never);
      }) as Db["query"],
    };
    const report = await runScheduledSync({ db: failing, sync: null });
    assert.equal(report.pruneFailed, true);
    assert.ok(
      report.demosPruned >= 2,
      `expected the two committed deletions, got ${report.demosPruned}`,
    );
    const left = await db.query(
      "SELECT 1 FROM ledger_users WHERE id = ANY($1::uuid[])",
      [[a, b]],
    );
    assert.equal(left.rows.length, 0);
  });
});

describe("syncAllMailboxes isolation", () => {
  it("an unexpected error on one mailbox is reported as FAILED and the others still sync", async () => {
    const userId = await seedUser(db);
    const first = await seedMailbox(db, userId, "first@example.org");
    const second = await seedMailbox(db, userId, "second@example.org");
    const fake = new FakeGmail();
    fake.add("m1", greenhouseConfirmation());
    // Make the lease UPDATE for the first mailbox throw, as a database error would.
    const flaky: Db = {
      ...db,
      query: (async (sql: string, params?: unknown[]) => {
        if (
          /^UPDATE connected_mailboxes SET sync_lease_until = \$2/.test(
            sql.trim(),
          ) &&
          params?.[0] === first
        )
          throw new Error("connection reset");
        return db.query(sql, params as never);
      }) as Db["query"],
    };
    const results = await syncAllMailboxes(
      {
        db: flaky,
        clientFor: async () => fake,
        now: () => NOW,
        budgetMs: 60_000,
      },
      { userId },
    );
    const byId = Object.fromEntries(
      results.map((r) => [r.mailboxId, r.status]),
    );
    assert.equal(byId[first], "FAILED");
    assert.equal(byId[second], "OK");
    // The crash leaves a safe, findable trace on the mailbox itself.
    const trace = await db.query<{
      last_error_code: string | null;
      last_attempt_at: unknown;
    }>(
      "SELECT last_error_code, last_attempt_at FROM connected_mailboxes WHERE id=$1",
      [first],
    );
    assert.equal(trace.rows[0]!.last_error_code, "SYNC_CRASHED");
    assert.ok(trace.rows[0]!.last_attempt_at);
  });
});
