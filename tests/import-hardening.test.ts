import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { parseEml } from "../src/ingestion/eml.ts";
import { EXTRACTOR_VERSION, extractSignal } from "../src/ingestion/extract.ts";
import { classifyHeaders, RECRUITMENT_SUBJECT_TERMS } from "../src/ingestion/header-gate.ts";
import { candidateQueries } from "../src/server/gmail/client.ts";
import { GmailError } from "../src/server/gmail/client.ts";
import { requestMailboxRecheck } from "../src/server/gmail/recheck.ts";
import { syncMailbox } from "../src/server/gmail/sync.ts";
import { ingestOriginal } from "../src/server/pipeline.ts";
import { listMailboxes, listOpenings, listReviews } from "../src/server/queries.ts";
import { dismissReview } from "../src/server/actions.ts";
import { createTestDb, seedMailbox, seedUser, type TestDb } from "./helpers/db.ts";
import { FakeGmail } from "./helpers/fake-gmail.ts";
import { buildEml, forwardAsAttachment, type EmlSpec } from "./helpers/eml.ts";
import { EmlError, EML_LIMITS } from "../src/ingestion/eml.ts";
import type { Db } from "../src/server/db.ts";
import { greenhouseConfirmation, newsletter } from "./helpers/fixtures.ts";

let t: TestDb;
before(async () => { t = await createTestDb(); });
after(() => t.close());
const NOW = new Date("2026-10-20T12:00:00Z");
const ibm: EmlSpec = {
  from: "IBM Talent Acquisition <talent@ibm.com>", to: "candidate@example.org",
  subject: "You have successfully submitted your IBM job application - 123456 - Senior Frontend Engineer I - Confluent",
  date: "Wed, 30 Sep 2026 02:59:00 +0000", messageId: "<ibm-confirmation@example.org>",
  text: "Dear Applicant, thank you for applying to the role of Senior Frontend Engineer I - Confluent - 123456 with Candidate ID - 98765432 at IBM. Your application is being reviewed by our team.",
};
const parse = async (spec: EmlSpec) => (await parseEml(Buffer.from(buildEml(spec))))[0]!;
async function setup() {
  const userId = await seedUser(t.db), mailboxId = await seedMailbox(t.db, userId);
  const fake = new FakeGmail();
  const deps = { db: t.db, clientFor: async () => fake, now: () => NOW };
  return { userId, mailboxId, fake, deps };
}
async function seedLegacyNoSignal(userId: string, mailboxId: string, id: string, spec: EmlSpec) {
  const original = await parse(spec), artifactId = randomUUID();
  await t.db.query(
    `INSERT INTO source_artifacts (id,user_id,source_kind,mailbox_id,provider_message_id,source_fingerprint,original_message_at,body_access_decision,extractor_version)
     VALUES ($1,$2,'GMAIL',$3,$4,$5,$6,'FETCHED_CANDIDATE','rules-3')`,
    [artifactId,userId,mailboxId,id,original.fingerprint,original.message.date],
  );
  await t.db.query(
    `INSERT INTO extracted_signals (id,user_id,source_artifact_id,extractor_version,event_kind,fields,confidence,processing_state)
     VALUES ($1,$2,$3,'rules-3',NULL,'{}','LOW','DISMISSED')`, [randomUUID(),userId,artifactId],
  );
  await t.db.query(
    `INSERT INTO processing_tasks (id,user_id,mailbox_id,provider_message_id,state,outcome,finished_at)
     VALUES ($1,$2,$3,$4,'DONE','NO_SIGNAL',$5)`, [randomUUID(),userId,mailboxId,id,NOW.toISOString()],
  );
  return original;
}

test("IBM confirmation travels through real MIME parsing, sync, storage, and the dashboard", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("ibm", ibm);
  assert.equal((await syncMailbox(deps, mailboxId, { userId })).status, "OK");
  const openings = await listOpenings(t.db, userId, NOW);
  assert.equal(openings.length, 1);
  assert.equal(openings[0]!.company, "IBM");
  assert.equal(openings[0]!.title, "Senior Frontend Engineer I - Confluent");
  assert.equal(openings[0]!.attempts[0]!.applicantEmailMasked, "unknown");
});

test("every subject admitted by the header gate is covered by initial search", () => {
  const query = candidateQueries(1)[1]!;
  for (const term of RECRUITMENT_SUBJECT_TERMS) {
    assert.equal(classifyHeaders({ from: "talent@example.org", subject: `Your ${term} update` }).kind, "CANDIDATE");
    assert.ok(query.includes(term.includes(" ") ? `"${term}"` : term));
  }
  assert.equal(classifyHeaders({ from: "talent@example.org", subject: "Application portal verification code" }).kind, "SKIP_SENSITIVE");
});

test("complementary MIME representations supply missing facts without guessing", async () => {
  const original = await parse({ ...ibm, subject: "Thank you for applying to Example Employer!",
    text: "Thank you for applying to Example Employer!",
    html: "<p>Thank you for applying to Example Employer!</p><p>Job Title: Frontend Engineer</p>",
  });
  const signal = extractSignal(original.message);
  assert.equal(signal.fields.company, "Example Employer");
  assert.equal(signal.fields.title, "Frontend Engineer");
  assert.equal(signal.reasons.includes("conflicting-alternatives"), false);
});

test("contradictions inside one MIME body go to review, not silent dismissal", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("contradiction", { ...ibm, text: "We regret to inform you. We are pleased to extend an offer of employment." });
  await syncMailbox(deps, mailboxId, { userId });
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 0);
  assert.equal((await listReviews(t.db, userId)).length, 1);
});

test("two different job links require review rather than choosing the first", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("two-jobs", { ...greenhouseConfirmation(), text: greenhouseConfirmation().text + "\nhttps://boards.greenhouse.io/other/jobs/987654" });
  await syncMailbox(deps, mailboxId, { userId });
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 0);
  assert.equal((await listReviews(t.db, userId))[0]!.reason, "AMBIGUOUS_OPENING");
});

test("a hiring email with a portal access link is processed, and the link is stored nowhere", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("portal", { ...ibm, html: '<p>Application received.</p><a href="https://example.org/portal?token=never-persist-me">Career portal</a>' });
  await syncMailbox(deps, mailboxId, { userId });
  assert.equal((await t.db.query("SELECT outcome FROM processing_tasks WHERE mailbox_id=$1", [mailboxId])).rows[0]!.outcome, "PROCESSED");
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 1);
  for (const table of ["source_artifacts", "extracted_signals", "job_openings", "application_attempts", "application_events", "review_items"]) {
    const { rows } = await t.db.query(`SELECT row_to_json(x)::text AS row FROM ${table} x WHERE user_id=$1`, [userId]);
    for (const { row } of rows) assert.ok(!String(row).includes("never-persist-me"), table);
  }
});

test("body privacy exclusions have their own durable outcome and no retained secret facts", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("secret", { ...ibm, html: '<p>Application received.</p><a href="https://example.org/verify-email?token=never-persist-me">Verify your email</a>' });
  await syncMailbox(deps, mailboxId, { userId });
  assert.equal((await t.db.query("SELECT outcome FROM processing_tasks WHERE mailbox_id=$1", [mailboxId])).rows[0]!.outcome, "SKIPPED_SENSITIVE");
  const a = (await t.db.query("SELECT subject_redacted,original_key FROM source_artifacts WHERE user_id=$1", [userId])).rows[0]!;
  assert.equal(a.subject_redacted, null);
  assert.equal(a.original_key, null);
  const view = (await listMailboxes(t.db, userId))[0]!;
  assert.equal(view.processingSummary.skippedSensitive, 1);
  assert.equal(view.processingSummary.unrecognized, 0);
  assert.equal(view.excludedMessages[0]!.reason, "PRIVACY_CHECK");
  assert.deepEqual(Object.keys(view.excludedMessages[0]!).sort(), ["messageId", "originalMessageAt", "reason"]);
  assert.equal((await t.db.query("SELECT id FROM extracted_signals WHERE user_id=$1", [userId])).rows.length, 0);
});

test("recheck upgrades a legacy skipped IBM message once across overlapping queries", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("ibm", ibm);
  await seedLegacyNoSignal(userId, mailboxId, "ibm", ibm);
  assert.equal(await requestMailboxRecheck(t.db, userId, mailboxId, NOW), "QUEUED");
  assert.equal((await syncMailbox(deps, mailboxId, { userId })).status, "OK");
  assert.deepEqual(fake.calls.raw, ["ibm"]);
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 1);
  assert.equal((await t.db.query("SELECT id FROM extracted_signals WHERE user_id=$1 AND extractor_version=$2", [userId, EXTRACTOR_VERSION])).rows.length, 1);
  assert.equal((await listMailboxes(t.db, userId))[0]!.recheckInProgress, false);
  await requestMailboxRecheck(t.db, userId, mailboxId, NOW);
  await syncMailbox(deps, mailboxId, { userId });
  assert.deepEqual(fake.calls.raw, ["ibm"], "processed mail must never be refetched on another recheck");
});

test("recheck retries survive transient provider errors and preserve recovery intent", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("ibm", ibm).rateLimitRaw.set("ibm", 1);
  await seedLegacyNoSignal(userId, mailboxId, "ibm", ibm);
  await requestMailboxRecheck(t.db, userId, mailboxId, NOW);
  assert.equal((await syncMailbox(deps, mailboxId, { userId })).status, "PARTIAL");
  assert.equal(await requestMailboxRecheck(t.db, userId, mailboxId, NOW), "IN_PROGRESS");
  assert.equal((await syncMailbox({ ...deps, now: () => new Date(NOW.getTime() + 120000) }, mailboxId, { userId })).status, "OK");
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 1);
});

test("recheck preserves applied evidence and dismissed reviews even with stale task outcomes", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("ibm", ibm).add("unknown-role", { ...ibm, messageId: "<other@example.org>", subject: "Thank you for applying to Example Employer!", text: "Thank you for applying to Example Employer!" });
  await syncMailbox(deps, mailboxId, { userId });
  const reviews = await listReviews(t.db, userId);
  assert.equal(reviews.length, 1);
  await dismissReview(t.db, userId, reviews[0]!.id);
  await t.db.query("UPDATE processing_tasks SET outcome='NO_SIGNAL' WHERE mailbox_id=$1", [mailboxId]);
  await requestMailboxRecheck(t.db, userId, mailboxId, NOW);
  await syncMailbox(deps, mailboxId, { userId });
  assert.equal(fake.calls.raw.length, 2);
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 1);
  assert.equal((await listReviews(t.db, userId)).length, 0);
  const original = await parse(ibm);
  assert.equal((await ingestOriginal(t.db, { userId, source: { kind: "GMAIL", mailboxId, providerMessageId: "ibm" }, original, reprocessUnapplied: true, observedAt: NOW })).status, "DUPLICATE");
});

test("recheck is owner scoped and cannot replace active or disconnected workers", async () => {
  const { userId, mailboxId } = await setup();
  const stranger = await seedUser(t.db);
  assert.equal(await requestMailboxRecheck(t.db, stranger, mailboxId, NOW), "NOT_FOUND");
  await t.db.query("UPDATE connected_mailboxes SET sync_lease_until=$2 WHERE id=$1", [mailboxId,new Date(NOW.getTime()+60000).toISOString()]);
  assert.equal(await requestMailboxRecheck(t.db, userId, mailboxId, NOW), "BUSY");
  await t.db.query("UPDATE connected_mailboxes SET sync_state='DISCONNECTED' WHERE id=$1", [mailboxId]);
  assert.equal(await requestMailboxRecheck(t.db, userId, mailboxId, NOW), "NOT_FOUND");
});

test("recovery respects the 60-day window and leaves older skipped mail untouched", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  const old = { ...ibm, date: "Tue, 01 Jul 2025 02:59:00 +0000" };
  fake.add("old", old);
  await seedLegacyNoSignal(userId, mailboxId, "old", old);
  await requestMailboxRecheck(t.db, userId, mailboxId, NOW);
  await syncMailbox(deps, mailboxId, { userId });
  assert.equal(fake.calls.raw.length, 0);
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 0);
});

test("a no-event message remains visible in totals after repeated rechecks", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("newsletter", newsletter());
  await syncMailbox(deps, mailboxId, { userId });
  for (let i=0; i<2; i++) {
    await requestMailboxRecheck(t.db, userId, mailboxId, NOW);
    await syncMailbox(deps, mailboxId, { userId });
    const view = (await listMailboxes(t.db, userId))[0]!;
    assert.equal(view.processingSummary.unrecognized, 1);
    assert.equal(view.processingSummary.processed, 0);
  }
});

test("replay after a crash keeps exclusions instead of counting them as processed", async () => {
  for (const spec of [newsletter(), { ...ibm, text: "Your verification code is synthetic-secret." }]) {
    const { userId, mailboxId, fake, deps } = await setup();
    fake.add("crash-replay", spec);
    await syncMailbox(deps, mailboxId, { userId });
    await t.db.query("UPDATE processing_tasks SET state='PENDING',next_attempt_at=$2 WHERE mailbox_id=$1", [mailboxId,NOW.toISOString()]);
    await syncMailbox(deps, mailboxId, { userId });
    const summary = (await listMailboxes(t.db, userId))[0]!.processingSummary;
    assert.equal(summary.processed, 0);
    assert.equal(summary.skippedSensitive + summary.unrecognized, 1);
  }
});

test("IBM requisition joins related updates to the opening, but never guesses the applicant identity", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("ibm", ibm);
  fake.add("assessment", { ...ibm, messageId: "<assessment@example.org>", subject: "Action Required: IBM Coding Assessment", text: "Ref: 123456 - Senior Frontend Engineer I - Confluent\nPlease complete your coding assessment. Candidate ID - 98765432" });
  await syncMailbox(deps, mailboxId, { userId });
  const openings = await listOpenings(t.db, userId, NOW), reviews = await listReviews(t.db, userId);
  assert.equal(openings.length, 1);
  assert.equal(reviews.length, 1, "without a submission-specific ID or declared applicant email, assigning to an attempt requires review");
  assert.equal(reviews[0]!.fields.externalApplicationId, null);
  assert.equal(reviews[0]!.fields.title, openings[0]!.title);
  assert.equal(reviews[0]!.kind, "ASSESSMENT_INVITED");
});

test("contradictory IBM requisitions in subject and body require review", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("ibm", { ...ibm, text: ibm.text!.replace("123456", "654321") });
  await syncMailbox(deps, mailboxId, { userId });
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 0);
  assert.equal((await listReviews(t.db, userId))[0]!.reason, "AMBIGUOUS_OPENING");
});

test("recheck detects a changed provider payload instead of silently overwriting prior evidence", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("ibm", { ...ibm, text: ibm.text! + " Changed content." });
  await seedLegacyNoSignal(userId, mailboxId, "ibm", ibm);
  await requestMailboxRecheck(t.db, userId, mailboxId, NOW);
  assert.equal((await syncMailbox(deps, mailboxId, { userId })).status, "PARTIAL");
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 0);
});

test("partial attachment parsing imports valid originals and explicitly reports omissions", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("batch", forwardAsAttachment([buildEml(ibm), "not a message"], { subject: "Fwd: application confirmations" }));
  await syncMailbox(deps, mailboxId, { userId });
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 1);
  const view = (await listMailboxes(t.db, userId))[0]!;
  assert.equal(view.processingSummary.partiallyProcessed, 1);
  assert.equal(view.excludedMessages[0]!.reason, "PARSE_LIMIT");
});

test("recipients beyond the bound are quarantined rather than silently changing dedupe identity", async () => {
  const to = Array.from({ length: EML_LIMITS.maxRecipients+1 }, (_, i) => `person${i}@example.org`);
  await assert.rejects(parse({ ...ibm, to }), e => e instanceof EmlError && e.code === "TOO_MANY");
});

test("recheck can recover a legacy tracking-link exclusion without persisting the token", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  const spec = { ...ibm, text: ibm.text + "\nUnsubscribe: https://mail.example.org/unsubscribe?token=private-tracking-value" };
  fake.add("ibm", spec);
  await seedLegacyNoSignal(userId, mailboxId, "ibm", spec);
  await t.db.query("UPDATE source_artifacts SET body_access_decision='SKIPPED_SENSITIVE',extractor_version=NULL WHERE mailbox_id=$1", [mailboxId]);
  await t.db.query("DELETE FROM extracted_signals WHERE user_id=$1", [userId]);
  await requestMailboxRecheck(t.db, userId, mailboxId, NOW);
  await syncMailbox(deps, mailboxId, { userId });
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 1);
  const signals = await t.db.query("SELECT fields FROM extracted_signals WHERE user_id=$1", [userId]);
  assert.equal(JSON.stringify(signals.rows).includes("private-tracking-value"), false);
  assert.equal((await listMailboxes(t.db, userId))[0]!.processingSummary.skippedSensitive, 0);
});

test("unexpected constraint failures roll back and are never disguised as duplicate emails", async () => {
  const { userId } = await setup();
  const db: Db = { ...t.db, transaction: fn => t.db.transaction(tx => fn({ ...tx,
    async query<T extends object>(sql: string, params?: readonly unknown[]) {
      if (sql.includes("INSERT INTO source_artifacts")) throw Object.assign(new Error("synthetic database failure"), { code: "23505" });
      return tx.query<T>(sql, params);
    },
  })) };
  await assert.rejects(ingestOriginal(db, { userId, source: { kind: "FORWARDED_EML" }, original: await parse(ibm), observedAt: NOW }), { code: "23505" });
  assert.equal((await t.db.query("SELECT id FROM source_artifacts WHERE user_id=$1", [userId])).rows.length, 0);
});

test("missing envelope dates do not collapse multiple attached originals into one Gmail artifact", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  const raw = forwardAsAttachment([buildEml(ibm), buildEml(greenhouseConfirmation())], { subject: "Fwd: application confirmations" }).replace(/^Date:.*\r?\n/m, "");
  fake.add("batch", raw, ["INBOX"], NOW.getTime());
  await syncMailbox(deps, mailboxId, { userId });
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 2);
  const artifacts = (await t.db.query("SELECT source_kind FROM source_artifacts WHERE user_id=$1", [userId])).rows;
  assert.equal(artifacts.length, 2);
  assert.ok(artifacts.every(a => a.source_kind === "FORWARDED_EML"));
});

test("Workday canonical URLs require a public job path rather than arbitrary token-bearing paths", async () => {
  const original = await parse({ ...ibm, text: "Thank you for applying. https://acme.myworkdayjobs.com/unsubscribe/opaque-token/job/Berlin/Engineer_JR-12345?token=tracking-only" });
  const signal = extractSignal(original.message);
  assert.equal(signal.fields.canonicalUrl, null);
  assert.equal(signal.fields.atsKey?.provider, "ibm");
});

test("an expired baseline during recheck restarts the full window and completes without losing candidates", async () => {
  const { userId, mailboxId, fake, deps } = await setup();
  fake.add("ibm", ibm);
  await seedLegacyNoSignal(userId, mailboxId, "ibm", ibm);
  await t.db.query("UPDATE connected_mailboxes SET last_success_at=$2 WHERE id=$1", [mailboxId, NOW.toISOString()]);
  const listHistory = fake.listHistory.bind(fake);
  let expired = false;
  fake.listHistory = async (cursor, token) => {
    if (!expired) { expired = true; throw new GmailError("history_expired"); }
    return listHistory(cursor, token);
  };
  await requestMailboxRecheck(t.db, userId, mailboxId, NOW);
  assert.equal((await syncMailbox(deps, mailboxId, { userId })).status, "OK");
  const view = (await listMailboxes(t.db, userId))[0]!;
  assert.equal(view.backfillComplete, true);
  assert.equal(view.recheckInProgress, false);
  assert.equal((await listOpenings(t.db, userId, NOW)).length, 1);
  assert.equal(fake.calls.profile, 2);
});
