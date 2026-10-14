import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ingestOriginal } from "../src/server/pipeline.ts";
import { OAuthError } from "../src/server/security/oauth.ts";
import {
  syncAllMailboxes,
  syncMailbox,
  type SyncDeps,
} from "../src/server/gmail/sync.ts";
import type { Db } from "../src/server/db.ts";
import { listOpenings } from "../src/server/queries.ts";
import { forwardAsAttachment } from "./helpers/eml.ts";
import { FakeGmail } from "./helpers/fake-gmail.ts";
import {
  createTestDb,
  seedMailbox,
  seedUser,
  type TestDb,
} from "./helpers/db.ts";
import {
  APPLICANT_A,
  APPLICANT_B,
  greenhouseConfirmation,
  interviewInvite,
  leverConfirmation,
  newsletter,
  otpMessage,
  rejection,
} from "./helpers/fixtures.ts";
import { buildEml } from "./helpers/eml.ts";

let t: TestDb;
let db: Db;
before(async () => {
  t = await createTestDb();
  db = t.db;
});
after(() => t.close());

const NOW = new Date("2026-10-20T12:00:00Z");
const minutesLater = (m: number) => new Date(NOW.getTime() + m * 60_000);
void ingestOriginal;

async function setup(address = "jobs@example.org") {
  const userId = await seedUser(db);
  const mailboxId = await seedMailbox(db, userId, address);
  return { userId, mailboxId };
}

function deps(fake: FakeGmail, over: Partial<SyncDeps> = {}): SyncDeps {
  return {
    db,
    clientFor: async () => fake,
    now: () => NOW,
    budgetMs: 60_000,
    ...over,
  };
}

const bank = {
  from: '"Bank" <alerts@bank.example>',
  to: APPLICANT_A,
  subject: "Your statement is ready",
  date: "Mon, 05 Oct 2026 08:00:00 +0000",
  text: "Balance: 100",
};

const mailbox = async (id: string) =>
  (
    await db.query<{
      sync_state: string;
      backfill_complete: boolean;
      history_cursor: string | null;
      last_error_code: string | null;
      sync_lease_until: unknown;
    }>(
      "SELECT sync_state, backfill_complete, history_cursor, last_error_code, sync_lease_until FROM connected_mailboxes WHERE id = $1",
      [id],
    )
  ).rows[0]!;
const attempts = async (u: string) =>
  (
    await db.query<{
      stage: string;
      outcome: string;
      applicant_email_snapshot: string;
    }>(
      "SELECT stage, outcome, applicant_email_snapshot FROM application_attempts WHERE user_id = $1 ORDER BY created_at, id",
      [u],
    )
  ).rows;
const tasks = async (id: string) =>
  (
    await db.query<{
      provider_message_id: string;
      state: string;
      outcome: string | null;
      attempts: number;
      next_attempt_at: unknown;
    }>(
      "SELECT provider_message_id, state, outcome, attempts, next_attempt_at FROM processing_tasks WHERE mailbox_id = $1 ORDER BY provider_message_id",
      [id],
    )
  ).rows;
const lastRun = async (id: string) =>
  (
    await db.query<Record<string, unknown>>(
      "SELECT * FROM sync_runs WHERE mailbox_id = $1 ORDER BY started_at DESC, id LIMIT 1",
      [id],
    )
  ).rows[0]!;

function seedBackfillMailbox(fake: FakeGmail) {
  fake.add("m1", greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-1"));
  fake.add("m2", interviewInvite(APPLICANT_A, undefined, "GH-1"));
  fake.add("m3", otpMessage());
  fake.add("m4", newsletter());
  fake.add("m5", bank);
}

describe("initial backfill", () => {
  it("stores the baseline cursor first, fetches bodies only for approved headers, and completes", async () => {
    const { userId, mailboxId } = await setup();
    const fake = new FakeGmail();
    seedBackfillMailbox(fake);
    const result = await syncMailbox(deps(fake), mailboxId, { system: true });
    assert.equal(result.status, "OK");

    assert.deepEqual(
      [...fake.calls.raw].sort(),
      ["m1", "m2", "m4"],
      "OTP and unrelated bank mail never have their bodies fetched",
    );
    const run = await lastRun(mailboxId);
    assert.equal(run["discovered_count"], 5);
    assert.equal(run["headers_inspected"], 5);
    assert.equal(run["bodies_fetched"], 3);
    assert.equal(run["skipped_sensitive"], 1);
    assert.equal(run["skipped_other"], 2);
    assert.equal(run["signals_applied"], 2);

    const m = await mailbox(mailboxId);
    assert.equal(m.sync_state, "HEALTHY");
    assert.equal(m.backfill_complete, true);
    assert.equal(m.history_cursor, "1005");
    assert.deepEqual(
      (await attempts(userId)).map((a) => [a.stage, a.outcome]),
      [["INTERVIEW", "PENDING"]],
    );
    assert.ok((await tasks(mailboxId)).every((x) => x.state === "DONE"));
  });

  it("picks up a message that arrives mid-backfill through the catch-up history scan", async () => {
    const { userId, mailboxId } = await setup();
    const fake = new FakeGmail();
    seedBackfillMailbox(fake);
    // Arrives after the baseline is recorded and is invisible to the search queries.
    const originalList = fake.listMessageIds.bind(fake);
    let injected = false;
    fake.listMessageIds = async (q, token) => {
      if (!injected) {
        injected = true;
        fake.hiddenFromQueries.add("late");
        fake.add("late", leverConfirmation(APPLICANT_B));
      }
      return originalList(q, token);
    };
    await syncMailbox(deps(fake), mailboxId, { system: true });
    assert.ok(fake.calls.raw.includes("late"));
    assert.equal((await attempts(userId)).length, 2);
    assert.equal(
      (await mailbox(mailboxId)).history_cursor,
      String(fake.historyId),
    );
  });
});

describe("incremental sync", () => {
  it("processes only new mail, advances the cursor, and is a no-op when nothing changed", async () => {
    const { userId, mailboxId } = await setup();
    const fake = new FakeGmail();
    seedBackfillMailbox(fake);
    await syncMailbox(deps(fake), mailboxId, { system: true });
    const rawBefore = fake.calls.raw.length;

    fake.add("m6", rejection(APPLICANT_A, "GH-1"));
    await syncMailbox(deps(fake, { now: () => minutesLater(1) }), mailboxId, {
      system: true,
    });
    assert.deepEqual(fake.calls.raw.slice(rawBefore), ["m6"]);
    assert.equal((await attempts(userId))[0]!.outcome, "REJECTED");

    const rawAfter = fake.calls.raw.length;
    await syncMailbox(deps(fake, { now: () => minutesLater(2) }), mailboxId, {
      system: true,
    });
    assert.equal(fake.calls.raw.length, rawAfter);
    assert.equal((await lastRun(mailboxId))["discovered_count"], 0);
  });

  it("re-delivering already-seen history does not duplicate attempts or events", async () => {
    const { userId, mailboxId } = await setup();
    const fake = new FakeGmail();
    seedBackfillMailbox(fake);
    await syncMailbox(deps(fake), mailboxId, { system: true });
    const events = async () =>
      Number(
        (
          await db.query<{ n: string }>(
            "SELECT count(*) AS n FROM application_events WHERE user_id = $1",
            [userId],
          )
        ).rows[0]!.n,
      );
    const before = await events();
    await db.query(
      "UPDATE connected_mailboxes SET history_cursor = '1000' WHERE id = $1",
      [mailboxId],
    );
    const rawBefore = fake.calls.raw.length;
    await syncMailbox(deps(fake), mailboxId, { system: true });
    assert.equal(await events(), before);
    assert.equal(
      fake.calls.raw.length,
      rawBefore,
      "tasks are unique per message, so nothing is fetched twice",
    );
    assert.equal((await attempts(userId)).length, 1);
  });

  it("registers discovered work durably even if the run ends before processing it", async () => {
    const { userId, mailboxId } = await setup();
    const fake = new FakeGmail();
    seedBackfillMailbox(fake);
    await syncMailbox(deps(fake), mailboxId, { system: true });
    fake.add("m6", rejection(APPLICANT_A, "GH-1"));
    await syncMailbox(deps(fake, { budgetMs: 0 }), mailboxId, { system: true });
    assert.equal(
      (await tasks(mailboxId)).find((x) => x.provider_message_id === "m6")!
        .state,
      "PENDING",
    );
    assert.equal(
      (await mailbox(mailboxId)).history_cursor,
      String(fake.historyId),
      "cursor advanced because the work item is durable",
    );
    assert.equal((await attempts(userId))[0]!.outcome, "PENDING");
    await syncMailbox(deps(fake), mailboxId, { system: true });
    assert.equal((await attempts(userId))[0]!.outcome, "REJECTED");
  });

  it("backs off on rate limits and retries later without losing the message", async () => {
    const { userId, mailboxId } = await setup();
    const fake = new FakeGmail();
    fake.add("m1", greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-1"));
    fake.rateLimitRaw.set("m1", 1);
    const first = await syncMailbox(deps(fake), mailboxId, { system: true });
    assert.equal(first.status, "PARTIAL");
    const pending = (await tasks(mailboxId))[0]!;
    assert.equal(pending.state, "PENDING");
    assert.equal(pending.attempts, 1);
    assert.ok(
      new Date(pending.next_attempt_at as string).getTime() > NOW.getTime(),
    );
    assert.equal((await attempts(userId)).length, 0);

    await syncMailbox(deps(fake), mailboxId, { system: true }); // same clock: not yet due
    assert.equal((await tasks(mailboxId))[0]!.attempts, 1);
    await syncMailbox(deps(fake, { now: () => minutesLater(30) }), mailboxId, {
      system: true,
    });
    assert.equal((await tasks(mailboxId))[0]!.state, "DONE");
    assert.equal((await attempts(userId)).length, 1);
  });

  it("gives up on a message after bounded retries and records only a safe code", async () => {
    const { mailboxId } = await setup();
    const fake = new FakeGmail();
    fake.add("m1", greenhouseConfirmation());
    fake.rateLimitRaw.set("m1", 99);
    for (let i = 0; i < 6; i++)
      await syncMailbox(
        deps(fake, { now: () => minutesLater(i * 120) }),
        mailboxId,
        { system: true },
      );
    const task = (await tasks(mailboxId))[0]!;
    assert.equal(task.state, "FAILED");
    assert.equal(task.outcome, "RATE_LIMITED");
  });

  it("skips sent mail and drafts, and never treats a deleted message as an error", async () => {
    const { mailboxId } = await setup();
    const fake = new FakeGmail();
    fake.add("sent", greenhouseConfirmation(), ["SENT"]);
    fake.add("gone", greenhouseConfirmation(APPLICANT_A, undefined, "x"));
    fake.messages.delete("gone");
    await syncMailbox(deps(fake), mailboxId, { system: true });
    assert.equal(fake.calls.raw.length, 0);
    assert.ok((await tasks(mailboxId)).every((x) => x.state === "DONE"));
  });
});

describe("recovery", () => {
  it("an expired history cursor triggers a bounded resync that finds missed mail, once", async () => {
    const { userId, mailboxId } = await setup();
    const fake = new FakeGmail();
    seedBackfillMailbox(fake);
    await syncMailbox(deps(fake), mailboxId, { system: true });

    fake.add(
      "missed",
      leverConfirmation(APPLICANT_B),
      ["INBOX"],
      NOW.getTime(),
    );
    fake.minValidHistoryId = fake.historyId; // every cursor stored so far is now too old; a fresh baseline is valid
    const rawBefore = fake.calls.raw.length;
    const result = await syncMailbox(
      deps(fake, { now: () => minutesLater(60) }),
      mailboxId,
      { system: true },
    );
    assert.equal(result.status, "OK");
    assert.deepEqual(
      fake.calls.raw.slice(rawBefore),
      ["missed"],
      "already-processed messages are not refetched",
    );
    const m = await mailbox(mailboxId);
    assert.equal(m.sync_state, "HEALTHY");
    assert.equal(m.history_cursor, String(fake.historyId));
    assert.equal((await attempts(userId)).length, 2);
    const kinds = (
      await db.query<{ kind: string }>(
        "SELECT kind FROM sync_runs WHERE mailbox_id = $1",
        [mailboxId],
      )
    ).rows.map((r) => r.kind);
    assert.ok(kinds.includes("RESYNC"));
  });

  it("while a resync is incomplete the mailbox stays flagged instead of claiming health", async () => {
    const { mailboxId } = await setup();
    const fake = new FakeGmail();
    seedBackfillMailbox(fake);
    await syncMailbox(deps(fake), mailboxId, { system: true });
    for (const id of ["x1", "x2", "x3"])
      fake.add(
        id,
        greenhouseConfirmation(APPLICANT_B, undefined, id, "GH-" + id),
        ["INBOX"],
        NOW.getTime(),
      );
    fake.minValidHistoryId = fake.historyId;
    const result = await syncMailbox(deps(fake, { budgetMs: 0 }), mailboxId, {
      system: true,
    });
    assert.equal(result.status, "PARTIAL");
    assert.equal((await mailbox(mailboxId)).sync_state, "RESYNC_REQUIRED");
  });

  it("a revoked token degrades only that mailbox; others keep syncing", async () => {
    const userId = await seedUser(db);
    const bad = await seedMailbox(db, userId, "bad@example.org");
    const good = await seedMailbox(db, userId, "good@example.org");
    const fake = new FakeGmail();
    fake.add("m1", greenhouseConfirmation());
    const results = await syncAllMailboxes(
      {
        ...deps(fake),
        clientFor: async (m) => {
          if (m.id === bad) throw new OAuthError("invalid_grant");
          return fake;
        },
      },
      { userId: userId },
    );
    assert.deepEqual(results.map((r) => r.status).sort(), ["DEGRADED", "OK"]);
    const m = await mailbox(bad);
    assert.equal(m.sync_state, "DEGRADED");
    assert.equal(m.last_error_code, "TOKEN_REVOKED");
    assert.equal((await mailbox(good)).sync_state, "HEALTHY");
    assert.equal((await attempts(userId)).length, 1);
  });

  it("a held lease prevents a concurrent run; an expired one allows it", async () => {
    const { mailboxId } = await setup();
    const fake = new FakeGmail();
    fake.add("m1", greenhouseConfirmation());
    await db.query(
      "UPDATE connected_mailboxes SET sync_lease_until = $2 WHERE id = $1",
      [mailboxId, minutesLater(2).toISOString()],
    );
    assert.equal(
      (await syncMailbox(deps(fake), mailboxId, { system: true })).status,
      "BUSY",
    );
    assert.equal(fake.calls.profile, 0);
    assert.equal(
      (
        await syncMailbox(
          deps(fake, { now: () => minutesLater(10) }),
          mailboxId,
          { system: true },
        )
      ).status,
      "OK",
    );
    assert.equal(
      (await mailbox(mailboxId)).sync_lease_until,
      null,
      "lease released after the run",
    );
  });

  it("does not sync disconnected mailboxes", async () => {
    const { mailboxId } = await setup();
    await db.query(
      "UPDATE connected_mailboxes SET sync_state = 'DISCONNECTED', encrypted_refresh_token = NULL WHERE id = $1",
      [mailboxId],
    );
    const fake = new FakeGmail();
    assert.equal(
      (await syncMailbox(deps(fake), mailboxId, { system: true })).status,
      "SKIPPED",
    );
    assert.equal(fake.calls.profile, 0);
  });
});

describe("evidence and coverage", () => {
  it("a forward-as-attachment arriving in the connected mailbox is recorded as forwarded evidence of the ORIGINAL", async () => {
    const { userId, mailboxId } = await setup();
    const fake = new FakeGmail();
    fake.add(
      "fwd",
      forwardAsAttachment([buildEml(greenhouseConfirmation(APPLICANT_B))], {
        subject: "Fwd: Thank you for applying to Acme Robotics",
        to: "jobs@example.org",
      }),
    );
    await syncMailbox(deps(fake), mailboxId, { system: true });
    const [row] = await attempts(userId);
    assert.equal(row!.applicant_email_snapshot, APPLICANT_B);
    const kinds = (
      await db.query<{ source_kind: string }>(
        "SELECT source_kind FROM source_artifacts WHERE user_id = $1",
        [userId],
      )
    ).rows.map((r) => r.source_kind);
    assert.deepEqual(kinds, ["FORWARDED_EML"]);
    const [opening] = await listOpenings(db, userId, NOW);
    assert.equal(opening!.attempts[0]!.coverage, "FORWARD_OR_MANUAL");
  });

  it("directly received mail makes the attempt continuously monitored once healthy", async () => {
    const { userId, mailboxId } = await setup();
    const fake = new FakeGmail();
    fake.add("m1", greenhouseConfirmation());
    await syncMailbox(deps(fake), mailboxId, { system: true });
    const [opening] = await listOpenings(db, userId, NOW);
    assert.equal(opening!.attempts[0]!.coverage, "CONTINUOUS_HEALTHY");
  });

  it("two mailboxes sync independently even when message ids collide", async () => {
    const userId = await seedUser(db);
    const a = await seedMailbox(db, userId, "a@example.org");
    const b = await seedMailbox(db, userId, "b@example.org");
    const fakeA = new FakeGmail();
    const fakeB = new FakeGmail();
    fakeA.add(
      "same-id",
      greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-1"),
    );
    fakeB.add(
      "same-id",
      greenhouseConfirmation(
        APPLICANT_B,
        "Wed, 07 Oct 2026 10:00:00 +0000",
        "b",
        "GH-2",
      ),
    );
    await syncAllMailboxes(
      { ...deps(fakeA), clientFor: async (m) => (m.id === a ? fakeA : fakeB) },
      { userId: userId },
    );
    assert.equal((await mailbox(a)).sync_state, "HEALTHY");
    assert.equal((await mailbox(b)).sync_state, "HEALTHY");
    assert.equal((await attempts(userId)).length, 2);
    assert.equal((await tasks(a)).length + (await tasks(b)).length, 2);
  });
});
