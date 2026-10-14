import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import { EmlError, parseEml } from "../src/ingestion/eml.ts";
import { extractSignal } from "../src/ingestion/extract.ts";
import { ingestOriginal } from "../src/server/pipeline.ts";
import { createGmailClient, GmailError } from "../src/server/gmail/client.ts";
import { syncMailbox, syncAllMailboxes } from "../src/server/gmail/sync.ts";
import { disconnectMailbox } from "../src/server/gmail/connect.ts";
import { OAuthError, parseIdToken } from "../src/server/security/oauth.ts";
import {
  createTestDb,
  seedUser,
  seedMailbox,
  type TestDb,
} from "./helpers/db.ts";
import { buildEml } from "./helpers/eml.ts";
import {
  greenhouseConfirmation,
  interviewInvite,
  offer,
  rejection,
} from "./helpers/fixtures.ts";
import { FakeGmail } from "./helpers/fake-gmail.ts";

let t: TestDb;
before(async () => {
  t = await createTestDb();
});
after(() => t.close());
test("database adapters report SELECT row counts consistently", async () => {
  const selected = await t.db.query("SELECT 1 AS value");
  assert.equal(selected.rowCount, 1);
  assert.equal(selected.rows.length, 1);
});
async function ingest(
  userId: string,
  spec: ReturnType<typeof greenhouseConfirmation>,
) {
  const [original] = await parseEml(Buffer.from(buildEml(spec)));
  return ingestOriginal(t.db, {
    userId,
    source: { kind: "FORWARDED_EML", syntheticFixture: true },
    original: original!,
    observedAt: new Date("2027-02-01T12:00:00Z"),
  });
}
test("SEC-01: hostile unterminated HTML completes within bounds", async () => {
  for (const html of [
    "<".repeat(240000),
    "<script ".repeat(25000),
    "<br ".repeat(50000),
    '<a href="x">'.repeat(15000),
    "<!--".repeat(50000),
  ]) {
    const started = performance.now();
    try {
      await parseEml(
        Buffer.from(buildEml({ ...greenhouseConfirmation(), text: "", html })),
      );
    } catch (error) {
      assert.ok(error instanceof EmlError && error.code === "MALFORMED");
    }
    assert.ok(
      performance.now() - started < 1500,
      "hostile HTML blocked the event loop",
    );
  }
});
test("SEC-02: oversized HTML, subjects, and text are refused before conversion or extraction", async () => {
  for (const spec of [
    { html: "<".repeat(1_100_000), text: "" },
    { subject: "a".repeat(10000) },
    { text: "a".repeat(110000) },
  ]) {
    await assert.rejects(
      parseEml(Buffer.from(buildEml({ ...greenhouseConfirmation(), ...spec }))),
      EmlError,
    );
  }
});
test("content-sensitive deduplication distinguishes re-used header identities", async () => {
  const user = await seedUser(t.db);
  const initial = greenhouseConfirmation();
  await ingest(user, initial);
  const second = await ingest(user, {
    ...initial,
    text: initial.text!.replace("GH-778899", "GH-NEW999"),
  });
  assert.equal(second.status, "APPLIED");
  assert.equal(
    (
      await t.db.query("SELECT id FROM application_attempts WHERE user_id=$1", [
        user,
      ])
    ).rowCount,
    2,
  );
});
test("hidden credentials do not become saved subjects, fields, or message IDs", async () => {
  const user = await seedUser(t.db);
  const result = await ingest(user, {
    ...greenhouseConfirmation(),
    text: greenhouseConfirmation().text + "\nYour verification code is 123456",
    messageId: "<credential-value@x>",
  });
  assert.equal(result.status, "SKIPPED_SENSITIVE");
  const saved = await t.db.query(
    "SELECT original_rfc_message_id,subject_redacted FROM source_artifacts WHERE user_id=$1",
    [user],
  );
  assert.deepEqual(saved.rows, [
    { original_rfc_message_id: null, subject_redacted: null },
  ]);
  assert.equal(
    (
      await t.db.query("SELECT id FROM extracted_signals WHERE user_id=$1", [
        user,
      ])
    ).rowCount,
    0,
  );
});
test("candidate IDs and arbitrary career links are not submission identities", async () => {
  const spec = {
    ...greenhouseConfirmation(),
    text: "Thank you for applying. Candidate ID: PERSON-1234\nhttps://evil.example/jobs/bearerSecret123456",
  };
  const [original] = await parseEml(Buffer.from(buildEml(spec)));
  const signal = extractSignal(original!.message);
  assert.equal(signal.fields.externalApplicationId, null);
  assert.equal(signal.fields.canonicalUrl, null);
});
test("a matching application ID cannot mutate an unrelated employer's attempt", async () => {
  const user = await seedUser(t.db);
  await ingest(user, greenhouseConfirmation());
  const bad = rejection();
  bad.subject = "Application update at Another Company";
  bad.text =
    "We will not be moving forward with your application.\nCompany: Another Company\nJob title: Analyst\nApplication ID: GH-778899";
  assert.equal((await ingest(user, bad)).status, "REVIEW");
  assert.equal(
    (
      await t.db.query<{ outcome: string }>(
        "SELECT outcome FROM application_attempts WHERE user_id=$1",
        [user],
      )
    ).rows[0]!.outcome,
    "PENDING",
  );
});
test("automatic terminal conflicts and impossible chronology are reviewed", async () => {
  const user = await seedUser(t.db);
  await ingest(user, greenhouseConfirmation());
  await ingest(user, rejection());
  const result = await ingest(user, offer());
  assert.equal(result.status, "REVIEW");
  if (result.status === "REVIEW")
    assert.equal(result.reason, "CONFLICTING_EVENTS");
  const another = await seedUser(t.db);
  await ingest(another, greenhouseConfirmation());
  const early = await ingest(
    another,
    interviewInvite(undefined, "Thu, 01 Oct 2026 10:00:00 +0000"),
  );
  assert.equal(early.status, "REVIEW");
  if (early.status === "REVIEW")
    assert.equal(early.reason, "EVENT_PRECEDES_SUBMISSION");
});
test("OIDC audience arrays require the correct authorized party", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const claims = {
    iss: "https://accounts.google.com",
    aud: ["client", "other"],
    azp: "other",
    sub: "1",
    email: "a@example.com",
    email_verified: true,
    nonce: "nonce",
    exp: now.getTime() / 1000 + 60,
  };
  const token =
    "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
  assert.throws(
    () => parseIdToken(token, { clientId: "client", nonce: "nonce", now }),
    OAuthError,
  );
});
test("SEC-04: sync requires an explicit scope and denies cross-owner mailbox access", async () => {
  const a = await seedUser(t.db),
    b = await seedUser(t.db),
    mailbox = await seedMailbox(t.db, a);
  const fake = new FakeGmail();
  const deps = {
    db: t.db,
    clientFor: async () => fake,
    now: () => new Date("2026-10-20T00:00:00Z"),
  };
  assert.equal(
    (await syncMailbox(deps, mailbox, { userId: b })).status,
    "SKIPPED",
  );
  assert.equal(
    (await syncMailbox(deps, mailbox, undefined as never)).status,
    "SKIPPED",
  );
  assert.deepEqual(await syncAllMailboxes(deps, undefined as never), []);
  assert.equal(fake.calls.profile, 0);
});
test("SEC-05: completed discovery is not restarted while durable tasks are waiting", async () => {
  const user = await seedUser(t.db),
    mailbox = await seedMailbox(t.db, user),
    fake = new FakeGmail();
  fake.add("one", greenhouseConfirmation());
  const deps = {
    db: t.db,
    clientFor: async () => fake,
    now: () => new Date("2026-10-20T00:00:00Z"),
  };
  // Complete one search page per run, then history, without processing bodies.
  await syncMailbox({ ...deps, budgetMs: 0 }, mailbox, { userId: user });
  await syncMailbox({ ...deps, budgetMs: 0 }, mailbox, { userId: user });
  const baseline = fake.calls.profile;
  fake.hiddenFromQueries.add("late");
  fake.add("late", interviewInvite());
  await syncMailbox({ ...deps, budgetMs: 60000 }, mailbox, { userId: user });
  assert.equal(fake.calls.profile, baseline);
  assert.ok(fake.calls.raw.includes("late"));
});
test("lease fencing prevents an old worker from clearing a replacement lease or persisting mail", async () => {
  const user = await seedUser(t.db),
    mailbox = await seedMailbox(t.db, user),
    fake = new FakeGmail();
  fake.add("one", greenhouseConfirmation());
  const original = fake.getRaw.bind(fake);
  fake.getRaw = async (id) => {
    await t.db.query(
      "UPDATE connected_mailboxes SET sync_lease_owner='replacement',sync_lease_until='2026-10-21T00:00:00Z' WHERE id=$1",
      [mailbox],
    );
    return original(id);
  };
  const result = await syncMailbox(
    {
      db: t.db,
      clientFor: async () => fake,
      now: () => new Date("2026-10-20T00:00:00Z"),
    },
    mailbox,
    { userId: user },
  );
  assert.equal(result.status, "BUSY");
  assert.equal(
    (
      await t.db.query<{ sync_lease_owner: string }>(
        "SELECT sync_lease_owner FROM connected_mailboxes WHERE id=$1",
        [mailbox],
      )
    ).rows[0]!.sync_lease_owner,
    "replacement",
  );
  assert.equal(
    (
      await t.db.query("SELECT id FROM application_events WHERE user_id=$1", [
        user,
      ])
    ).rowCount,
    0,
  );
});
test("disconnect during retrieval prevents subsequent ingestion", async () => {
  const user = await seedUser(t.db),
    mailbox = await seedMailbox(t.db, user),
    fake = new FakeGmail();
  fake.add("one", greenhouseConfirmation());
  const raw = fake.getRaw.bind(fake);
  fake.getRaw = async (id) => {
    await disconnectMailbox(t.db, randomBytes(32), user, mailbox);
    return raw(id);
  };
  const result = await syncMailbox(
    {
      db: t.db,
      clientFor: async () => fake,
      now: () => new Date("2026-10-20T00:00:00Z"),
    },
    mailbox,
    { userId: user },
  );
  assert.equal(result.status, "BUSY");
  assert.equal(
    (
      await t.db.query("SELECT id FROM application_events WHERE user_id=$1", [
        user,
      ])
    ).rowCount,
    0,
  );
});
test("SEC-03: crashed tasks consume attempts before retrieval; other mail can progress", async () => {
  const user = await seedUser(t.db),
    mailbox = await seedMailbox(t.db, user),
    fake = new FakeGmail();
  fake.add("poison", greenhouseConfirmation());
  fake.add(
    "good",
    greenhouseConfirmation(undefined, undefined, "good", "GH-NEW999"),
  );
  await t.db.query(
    `INSERT INTO processing_tasks(id,user_id,mailbox_id,provider_message_id,attempts,next_attempt_at)
    VALUES(gen_random_uuid(),$1,$2,'poison',5,'2026-01-01')`,
    [user, mailbox],
  );
  const result = await syncMailbox(
    {
      db: t.db,
      clientFor: async () => fake,
      now: () => new Date("2026-10-20T00:00:00Z"),
    },
    mailbox,
    { userId: user },
  );
  assert.equal(result.status, "DEGRADED");
  assert.ok(fake.calls.raw.includes("good"));
  assert.ok(!fake.calls.raw.includes("poison"));
  const tasks = await t.db.query<{
    provider_message_id: string;
    state: string;
    attempts: number;
  }>(
    "SELECT provider_message_id,state,attempts FROM processing_tasks WHERE mailbox_id=$1",
    [mailbox],
  );
  assert.equal(
    tasks.rows.find((r) => r.provider_message_id === "poison")!.state,
    "FAILED",
  );
  assert.equal(
    tasks.rows.find((r) => r.provider_message_id === "good")!.attempts,
    1,
  );
  const state = await t.db.query<{
    sync_state: string;
    backfill_complete: boolean;
  }>(
    "SELECT sync_state,backfill_complete FROM connected_mailboxes WHERE id=$1",
    [mailbox],
  );
  assert.equal(state.rows[0]!.sync_state, "DEGRADED");
  assert.equal(state.rows[0]!.backfill_complete, false);
});
test("Gmail bodies are bounded before base64 decoding", async () => {
  const client = createGmailClient("synthetic", (async () =>
    Response.json({ raw: "A".repeat(6 * 1024 * 1024) })) as typeof fetch);
  await assert.rejects(
    client.getRaw("one"),
    (e) => e instanceof GmailError && e.code === "oversized",
  );
});
test("uploaded headers cannot authorize an automatic terminal change", async () => {
  const user = await seedUser(t.db);
  await ingest(user, greenhouseConfirmation());
  const [original] = await parseEml(Buffer.from(buildEml(rejection())));
  const result = await ingestOriginal(t.db, {
    userId: user,
    source: { kind: "FORWARDED_EML" },
    original: original!,
    observedAt: new Date("2027-02-01T12:00:00Z"),
  });
  assert.equal(result.status, "REVIEW");
  if (result.status === "REVIEW")
    assert.equal(result.reason, "TERMINAL_NEEDS_REVIEW");
  assert.equal(
    (
      await t.db.query<{ outcome: string }>(
        "SELECT outcome FROM application_attempts WHERE user_id=$1",
        [user],
      )
    ).rows[0]!.outcome,
    "PENDING",
  );
});
test("Gmail trusts aligned Google DMARC metadata, not arbitrary Authentication-Results", async () => {
  for (const [auth, expected] of [
    [
      "mx.google.com; dmarc=pass (p=REJECT) header.from=us.greenhouse-mail.io",
      true,
    ],
    ["evil.example; dmarc=pass header.from=us.greenhouse-mail.io", false],
    ["mx.google.com; dmarc=fail header.from=us.greenhouse-mail.io", false],
    ["mx.google.com; dmarc=pass header.from=evil.example", false],
  ] as const) {
    const client = createGmailClient("synthetic", (async () =>
      Response.json({
        payload: {
          headers: [
            { name: "From", value: "Jobs <jobs@us.greenhouse-mail.io>" },
            { name: "Subject", value: "Application update" },
            { name: "Authentication-Results", value: auth },
          ],
        },
      })) as typeof fetch);
    assert.equal(
      (await client.getHeaders("test"))!.senderAuthenticated,
      expected,
    );
  }
});
test("original recipient alone never fabricates submitted contact", async () => {
  const spec = greenhouseConfirmation();
  spec.text = spec.text!.replace(/^Submitted email:.*$/m, "");
  const [original] = await parseEml(Buffer.from(buildEml(spec)));
  assert.equal(extractSignal(original!.message).fields.applicantEmail, null);
});
test("a conflicting requisition cannot be overridden by a reused application ID", async () => {
  const user = await seedUser(t.db);
  await ingest(user, greenhouseConfirmation());
  const update = rejection();
  update.text += "\nhttps://boards.greenhouse.io/acmerobotics/jobs/99988877";
  assert.equal((await ingest(user, update)).status, "REVIEW");
  assert.equal(
    (
      await t.db.query<{ outcome: string }>(
        "SELECT outcome FROM application_attempts WHERE user_id=$1",
        [user],
      )
    ).rows[0]!.outcome,
    "PENDING",
  );
});
