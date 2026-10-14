/**
 * End-to-end precision: what the pipeline persists for messages that the extractor could
 * misread. A wrong employer/title pair creates a false application, and a dismissed receipt
 * loses a real one, so each case asserts the final database outcome, not only the extraction.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseEml } from "../src/ingestion/eml.ts";
import { ingestOriginal, type IngestOutcome } from "../src/server/pipeline.ts";
import type { Db } from "../src/server/db.ts";
import { buildEml } from "./helpers/eml.ts";
import { createTestDb, seedMailbox, seedUser, type TestDb } from "./helpers/db.ts";

let t: TestDb;
let db: Db;
before(async () => {
  t = await createTestDb();
  db = t.db;
});
after(() => t.close());

let sequence = 0;

/** A Gmail message from a direct employer address (not a hiring platform). */
async function gmail(
  user: string,
  mailbox: string,
  mail: { subject: string; text: string; from?: string; date?: string },
): Promise<IngestOutcome> {
  sequence += 1;
  const raw = buildEml({
    from: mail.from ?? '"Acme Careers" <careers@acme.example>',
    to: "robin.example@example.com",
    subject: mail.subject,
    date: mail.date ?? "Mon, 12 Oct 2026 09:30:00 +0000",
    messageId: `<precision-${sequence}@acme.example>`,
    text: mail.text,
  });
  const [original] = await parseEml(new TextEncoder().encode(raw));
  return ingestOriginal(db, {
    userId: user,
    source: { kind: "GMAIL", mailboxId: mailbox, providerMessageId: `p-${sequence}` },
    original: original!,
    observedAt: new Date("2026-10-20T12:00:00Z"),
  });
}

async function fresh() {
  const user = await seedUser(db);
  return { user, mailbox: await seedMailbox(db, user) };
}

const openings = async (user: string) =>
  (
    await db.query<{ company: string; title: string }>(
      `SELECT c.canonical_name AS company, o.title FROM job_openings o
        JOIN companies c ON c.id = o.company_id AND c.user_id = o.user_id
       WHERE o.user_id = $1 ORDER BY c.canonical_name, o.title`,
      [user],
    )
  ).rows;

const events = async (user: string) =>
  (
    await db.query<{ kind: string }>(
      "SELECT event_kind AS kind FROM application_events WHERE user_id = $1 AND review_state = 'ACCEPTED' ORDER BY occurred_at",
      [user],
    )
  ).rows.map((r) => r.kind);

describe("classification reaches the right outcome", () => {
  it("footer adjacency cannot create a fake Privacy Policy application", async () => {
    const { user, mailbox } = await fresh();
    const out = await gmail(user, mailbox, {
      subject: "Application received",
      text: "We received your application.\nCompany: Acme\nAcme\nPrivacy Policy",
    });
    assert.equal(out.status === "REVIEW" && out.reason, "MISSING_JOB_DETAILS");
    assert.deepEqual(await openings(user), []);
  });
  it("field contradictions create review evidence, never an opening or attempt", async () => {
    const { user, mailbox } = await fresh();
    const out = await gmail(user, mailbox, {
      subject: "Application received",
      text: "We received your application.\nCompany: Acme\nJob Title: Backend Engineer\nFor the Frontend Engineer role at Globex.",
    });
    assert.equal(out.status === "REVIEW" && out.reason, "CONFLICTING_FIELDS");
    assert.deepEqual(await openings(user), []);
    assert.deepEqual(await events(user), []);
    const saved = await db.query<{ fields: { fieldDecisions: { title: { state: string } } } }>(
      "SELECT fields FROM extracted_signals WHERE user_id=$1", [user],
    );
    assert.equal(saved.rows[0]!.fields.fieldDecisions.title.state, "AMBIGUOUS");
  });
  it("a receipt with a talent-community footer creates the application", async () => {
    const { user, mailbox } = await fresh();
    const out = await gmail(user, mailbox, {
      subject: "Your application",
      text: "We received your application for the Backend Engineer role at Acme.\n\nJoin our talent community for more opportunities.",
    });
    assert.equal(out.status, "APPLIED");
    assert.deepEqual(await openings(user), [{ company: "Acme", title: "Backend Engineer" }]);
  });

  it("a negated receipt goes to review instead of creating or disappearing", async () => {
    const { user, mailbox } = await fresh();
    const out = await gmail(user, mailbox, {
      subject: "About your application",
      text: "We have not received your application for the Backend Engineer role at Acme. Please try again.",
    });
    assert.equal(out.status, "REVIEW");
    assert.equal(out.status === "REVIEW" && out.reason, "NOT_SUBMITTED");
    assert.deepEqual(await openings(user), []);
  });

  it("a cancelled interview never records INTERVIEW_SCHEDULED, even with a matching application id", async () => {
    const { user, mailbox } = await fresh();
    const applied = await gmail(user, mailbox, {
      subject: "Application received",
      text: "We received your application for the Backend Engineer role at Acme.\nApplication ID: A-12345",
    });
    assert.equal(applied.status, "APPLIED");
    const out = await gmail(user, mailbox, {
      subject: "Interview update",
      text: "Your final interview for the Backend Engineer role at Acme has been cancelled.\nApplication ID: A-12345",
      date: "Tue, 13 Oct 2026 09:30:00 +0000",
    });
    assert.equal(out.status === "REVIEW" && out.reason, "INTERVIEW_CANCELLED");
    assert.deepEqual(await events(user), ["CONFIRMATION_RECEIVED"]);
  });

  it("an interview that is still to be scheduled is not recorded as scheduled", async () => {
    const { user, mailbox } = await fresh();
    await gmail(user, mailbox, {
      subject: "Application received",
      text: "We received your application for the Backend Engineer role at Acme.\nApplication ID: A-22345",
    });
    await gmail(user, mailbox, {
      subject: "Next steps",
      text: "Your final interview for the Backend Engineer role at Acme will be scheduled once you send us your availability.\nApplication ID: A-22345",
      date: "Tue, 13 Oct 2026 09:30:00 +0000",
    });
    assert.ok(!(await events(user)).includes("INTERVIEW_SCHEDULED"));
  });
});

describe("employer spelling variants", () => {
  it("an update naming 'Acme' reaches the application confirmed as 'Acme Inc'", async () => {
    const { user, mailbox } = await fresh();
    const applied = await gmail(user, mailbox, {
      subject: "Application received",
      text: "We received your application for the Data Engineer role at Acme Inc.\nApplication ID: A-77881",
    });
    assert.equal(applied.status, "APPLIED");
    const invited = await gmail(user, mailbox, {
      subject: "Interview invitation",
      text: "We would like to invite you to an interview for the Data Engineer role at Acme.\nApplication ID: A-77881",
      date: "Tue, 13 Oct 2026 09:30:00 +0000",
    });
    assert.deepEqual(invited, { ...invited, status: "APPLIED" });
    assert.deepEqual(await events(user), ["CONFIRMATION_RECEIVED", "INTERVIEW_INVITED"]);
  });
});
