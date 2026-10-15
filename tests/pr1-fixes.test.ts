import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { fromPglite } from "../src/server/db.ts";
import { applyMigrations } from "../src/server/migrate.ts";
import { EmlError, parseEml } from "../src/ingestion/eml.ts";
import { ingestOriginal } from "../src/server/pipeline.ts";
import {
  connectMailbox,
  disconnectMailbox,
} from "../src/server/gmail/connect.ts";
import { syncMailbox } from "../src/server/gmail/sync.ts";
import { revokeToken } from "../src/server/security/oauth.ts";
import {
  correctSubmissionDate,
  resolveReviewCreate,
  ActionError,
} from "../src/server/actions.ts";
import { getOpening } from "../src/server/queries.ts";
import { usableEventDate } from "../src/ingestion/dates.ts";
import {
  createTestDb,
  seedUser,
  MIGRATIONS_DIR,
  type TestDb,
} from "./helpers/db.ts";
import { buildEml } from "./helpers/eml.ts";
import {
  greenhouseConfirmation,
  rejection,
  interviewInvite,
} from "./helpers/fixtures.ts";
import { FakeGmail } from "./helpers/fake-gmail.ts";

let t: TestDb;
before(async () => {
  t = await createTestDb();
});
after(() => t.close());
async function ingest(
  userId: string,
  spec: Parameters<typeof buildEml>[0],
  observedAt = new Date("2026-10-31T12:00:00Z"),
) {
  const [original] = await parseEml(Buffer.from(buildEml(spec)));
  return ingestOriginal(t.db, {
    userId,
    source: { kind: "FORWARDED_EML", syntheticFixture: true },
    original: original!,
    observedAt,
  });
}
test("PR1: sensitive content in either MIME representation is discarded before persistence", async () => {
  for (const content of [
    "<p>Your verification code is 123456</p>",
    "<!-- password reset https://login.example/?token=synthetic -->",
  ]) {
    const user = await seedUser(t.db);
    assert.equal(
      (await ingest(user, { ...greenhouseConfirmation(), html: content }))
        .status,
      "SKIPPED_SENSITIVE",
    );
    const a = (
      await t.db.query<{
        subject_redacted: string | null;
        original_key: string | null;
      }>(
        "SELECT subject_redacted,original_key FROM source_artifacts WHERE user_id=$1",
        [user],
      )
    ).rows[0]!;
    assert.equal(a.subject_redacted, null);
    assert.equal(a.original_key, null);
    assert.equal(
      (
        await t.db.query("SELECT id FROM extracted_signals WHERE user_id=$1", [
          user,
        ])
      ).rows.length,
      0,
    );
  }
});
test("PR1: contradictory outcomes or application IDs across MIME alternatives require review", async () => {
  for (const html of [
    `<p>${rejection().text}</p>`,
    `<p>${greenhouseConfirmation().text!.replace("GH-778899", "GH-999999")}</p>`,
  ]) {
    const user = await seedUser(t.db),
      out = await ingest(user, { ...greenhouseConfirmation(), html });
    assert.equal(out.status, "REVIEW");
    if (out.status === "REVIEW")
      assert.equal(out.reason, "CONFLICTING_ALTERNATIVES");
    assert.equal(
      (
        await t.db.query(
          "SELECT id FROM application_attempts WHERE user_id=$1",
          [user],
        )
      ).rows.length,
      0,
    );
  }
});
test("PR1: consistent MIME alternatives are accepted and all excessive anchor nesting is rejected", async () => {
  const user = await seedUser(t.db);
  assert.equal(
    (
      await ingest(user, {
        ...greenhouseConfirmation(),
        html: `<p>${greenhouseConfirmation().text}</p>`,
      })
    ).status,
    "APPLIED",
  );
  for (const text of ["", greenhouseConfirmation().text!])
    await assert.rejects(
      parseEml(
        Buffer.from(
          buildEml({
            ...greenhouseConfirmation(),
            text,
            html:
              "<p>Thank you for applying</p>" +
              "<a>".repeat(21) +
              "Your verification code is 123456",
          }),
        ),
      ),
      (e) => e instanceof EmlError && e.code === "MALFORMED",
    );
});
test("PR1: future dates are reviewed before creating attempts; valid clock skew is bounded", async () => {
  const user = await seedUser(t.db),
    out = await ingest(user, {
      ...greenhouseConfirmation(),
      date: "Mon, 05 Oct 2099 09:30:00 +0000",
    });
  assert.equal(out.status, "REVIEW");
  if (out.status === "REVIEW") assert.equal(out.reason, "NO_DATE");
  assert.equal(
    (
      await t.db.query("SELECT id FROM application_attempts WHERE user_id=$1", [
        user,
      ])
    ).rows.length,
    0,
  );
  const now = new Date("2026-10-31T12:00:00Z");
  assert.equal(
    usableEventDate("2026-10-31T12:04:59Z", now),
    "2026-10-31T12:04:59.000Z",
  );
  for (const date of [
    "2026-10-31T12:05:01Z",
    "2026-10-31T12:00:00",
    "1960-10-05T00:00:00Z",
  ])
    assert.equal(usableEventDate(date, now), null);
  assert.equal(
    usableEventDate("2026-10-31T12:00:00Z", new Date("invalid")),
    null,
  );
  // An old review with a future timestamp must not silently auto-reconcile.
  const legacy = await seedUser(t.db);
  const waiting = await ingest(
    legacy,
    interviewInvite(undefined, "Mon, 05 Oct 2099 09:30:00 +0000"),
    new Date("2100-01-01T00:00:00Z"),
  );
  if (waiting.status !== "REVIEW") throw new Error("Expected a waiting review");
  await ingest(legacy, greenhouseConfirmation());
  assert.equal(
    (
      await t.db.query<{ state: string }>(
        "SELECT state FROM review_items WHERE id=$1",
        [waiting.reviewId],
      )
    ).rows[0]!.state,
    "OPEN",
  );
});
test("PR1: reconnect retries only interrupted work and actually processes it", async () => {
  const user = await seedUser(t.db),
    other = await seedUser(t.db),
    key = randomBytes(32),
    identity = { sub: randomUUID(), email: "synthetic@example.com" };
  const { mailboxId } = await connectMailbox(
    t.db,
    key,
    user,
    identity,
    "synthetic",
  );
  const { mailboxId: otherMailbox } = await connectMailbox(
    t.db,
    key,
    other,
    identity,
    "synthetic",
  );
  for (const [mailbox, owner, message] of [
    [mailboxId, user, "interrupted"],
    [otherMailbox, other, "other-user"],
  ])
    await t.db.query(
      "INSERT INTO processing_tasks(id,user_id,mailbox_id,provider_message_id)VALUES($1,$2,$3,$4)",
      [randomUUID(), owner, mailbox, message],
    );
  await disconnectMailbox(
    t.db,
    key,
    user,
    mailboxId,
    async () => new Response("", { status: 200 }),
  );
  await t.db.query(
    "INSERT INTO processing_tasks(id,user_id,mailbox_id,provider_message_id,state,outcome,attempts)VALUES($1,$2,$3,'failed', 'FAILED','FETCH_ERROR',5),($4,$2,$3,'done','DONE','PROCESSED',1)",
    [randomUUID(), user, mailboxId, randomUUID()],
  );
  await connectMailbox(t.db, key, user, identity, "replacement");
  const states = (
    await t.db.query<{
      provider_message_id: string;
      state: string;
      attempts: number;
    }>(
      "SELECT provider_message_id,state,attempts FROM processing_tasks WHERE mailbox_id=$1",
      [mailboxId],
    )
  ).rows;
  assert.equal(
    states.find((x) => x.provider_message_id === "interrupted")!.state,
    "PENDING",
  );
  assert.equal(
    states.find((x) => x.provider_message_id === "interrupted")!.attempts,
    0,
  );
  assert.equal(
    states.find((x) => x.provider_message_id === "failed")!.state,
    "FAILED",
  );
  assert.equal(
    states.find((x) => x.provider_message_id === "done")!.state,
    "DONE",
  );
  const fake = new FakeGmail();
  fake.add("interrupted", greenhouseConfirmation());
  await syncMailbox(
    {
      db: t.db,
      clientFor: async () => fake,
      now: () => new Date("2026-10-31T12:00:00Z"),
    },
    mailboxId,
    { userId: user },
  );
  assert.equal(
    (
      await t.db.query<{ state: string }>(
        "SELECT state FROM processing_tasks WHERE mailbox_id=$1 AND provider_message_id='interrupted'",
        [mailboxId],
      )
    ).rows[0]!.state,
    "DONE",
  );
  assert.equal(
    (
      await t.db.query("SELECT id FROM application_attempts WHERE user_id=$1", [
        user,
      ])
    ).rows.length,
    1,
  );
  assert.equal(
    (
      await t.db.query<{ state: string }>(
        "SELECT state FROM processing_tasks WHERE mailbox_id=$1",
        [otherMailbox],
      )
    ).rows[0]!.state,
    "PENDING",
  );
});
test("PR1: revocation supplies a bounded abort signal, refuses redirects, and fails best effort", async () => {
  let options: RequestInit | undefined;
  assert.equal(
    await revokeToken("synthetic", async (_url, init) => {
      options = init;
      return new Response("", { status: 200 });
    }),
    true,
  );
  assert.ok(options!.signal instanceof AbortSignal);
  assert.equal(options!.redirect, "error");
  assert.equal(
    await revokeToken("synthetic", async () => {
      throw new DOMException("synthetic", "TimeoutError");
    }),
    false,
  );
});
test("PR1: date correction is audited, owner scoped, rejects future values, and unblocks later updates", async () => {
  const user = await seedUser(t.db),
    stranger = await seedUser(t.db),
    first = await ingest(user, greenhouseConfirmation());
  assert.equal(first.status, "APPLIED");
  if (first.status !== "APPLIED") return;
  await t.db.query(
    "UPDATE application_attempts SET submitted_at='2099-10-05T09:30:00Z' WHERE id=$1",
    [first.attemptId],
  );
  await t.db.query(
    "UPDATE application_events SET occurred_at='2099-10-05T09:30:00Z' WHERE attempt_id=$1",
    [first.attemptId],
  );
  await assert.rejects(
    correctSubmissionDate(
      t.db,
      stranger,
      first.attemptId,
      "2026-10-05T09:30:00Z",
    ),
    ActionError,
  );
  await assert.rejects(
    correctSubmissionDate(t.db, user, first.attemptId, "2099-10-05T09:30:00Z"),
    ActionError,
  );
  await correctSubmissionDate(
    t.db,
    user,
    first.attemptId,
    "2026-10-05T09:30:00Z",
  );
  const detail = await getOpening(t.db, user, first.openingId);
  assert.equal(
    detail!.attempts[0]!.submissionDateCorrections[0]!.previousAt,
    "2099-10-05T09:30:00.000Z",
  );
  assert.equal(
    detail!.attempts[0]!.events[0]!.occurredAt,
    "2026-10-05T09:30:00.000Z",
  );
  assert.equal(detail!.attempts[0]!.events[0]!.evidence.length, 1);
  assert.equal((await ingest(user, interviewInvite())).status, "APPLIED");
});
test("PR1: a review without job details can create an attempt under an owner-selected opening", async () => {
  const user = await seedUser(t.db),
    first = await ingest(user, greenhouseConfirmation());
  if (first.status !== "APPLIED") throw new Error("seed failed");
  const out = await ingest(user, {
    from: "Updates <updates@example.com>",
    to: "test@example.com",
    subject: "Application notes",
    text: "A note selected by the owner.",
  });
  if (out.status !== "REVIEW") throw new Error("review missing");
  await resolveReviewCreate(t.db, user, out.reviewId, {
    openingId: first.openingId,
    kind: "CONFIRMATION_RECEIVED",
  });
  assert.equal(
    (
      await t.db.query(
        "SELECT id FROM application_attempts WHERE user_id=$1 AND job_opening_id=$2",
        [user, first.openingId],
      )
    ).rows.length,
    2,
  );
});
test("PR1: populated core databases upgrade without changing applied checksums or losing company IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ledger-upgrade-")),
    pg = new PGlite(),
    db = fromPglite(pg);
  try {
    await writeFile(
      join(directory, "0001_core.sql"),
      await readFile(join(MIGRATIONS_DIR, "0001_core.sql")),
    );
    await applyMigrations(db, directory);
    const user = await seedUser(db),
      other = await seedUser(db);
    const companies = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < companies.length; i++) {
      await db.query(
        "INSERT INTO companies(id,user_id,canonical_name,normalized_domain)VALUES($1,$2,$3,$4)",
        [
          companies[i],
          i === 3 ? other : user,
          i === 1
            ? "  ACME   Labs "
            : i === 2
              ? `legacy:${companies[1]}`
              : "Acme Labs",
          `domain-${i}.example`,
        ],
      );
      await db.query(
        "INSERT INTO job_openings(id,user_id,company_id,title)VALUES($1,$2,$3,'Engineer')",
        [randomUUID(), i === 3 ? other : user, companies[i]],
      );
    }
    for (const file of await readdir(MIGRATIONS_DIR))
      await writeFile(
        join(directory, file),
        await readFile(join(MIGRATIONS_DIR, file)),
      );
    assert.equal(
      (await applyMigrations(db, directory)).length,
      (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql"))
        .length - 1,
    );
    assert.equal((await db.query("SELECT id FROM companies")).rows.length, 4);
    assert.equal(
      (await db.query("SELECT company_id FROM job_openings")).rows.length,
      4,
    );
    const keys = (
      await db.query<{ id: string; name_key: string }>(
        "SELECT id,name_key FROM companies WHERE user_id=$1",
        [user],
      )
    ).rows;
    assert.equal(new Set(keys.map((c) => c.name_key)).size, 3);
    assert.ok(keys.some((c) => c.name_key === "acme labs"));
    const original = await readFile(join(MIGRATIONS_DIR, "0002_ingestion.sql"));
    assert.equal(
      (
        await db.query<{ checksum: string }>(
          "SELECT checksum FROM schema_migrations WHERE name='0002_ingestion.sql'",
        )
      ).rows[0]!.checksum,
      createHash("sha256").update(original).digest("hex"),
    );
    assert.deepEqual(await applyMigrations(db, directory), []);
    await writeFile(
      join(directory, "0002_ingestion.sql"),
      original + "\n-- altered",
    );
    await assert.rejects(
      applyMigrations(db, directory),
      /MIGRATION_CHECKSUM_MISMATCH/,
    );
  } finally {
    await pg.close();
    await rm(directory, { recursive: true, force: true });
  }
});
