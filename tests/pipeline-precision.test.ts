/**
 * End-to-end precision: what the pipeline persists for messages that the extractor could
 * misread. A wrong employer/title pair creates a false application, and a dismissed receipt
 * loses a real one, so each case asserts the final database outcome, not only the extraction.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseEml } from "../src/ingestion/eml.ts";
import { ingestOriginal, type IngestOutcome } from "../src/server/pipeline.ts";
import { resolveReviewCreate } from "../src/server/actions.ts";
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
  mail: { subject: string; text: string; from?: string; date?: string; authenticated?: boolean },
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
    source: {
      kind: "GMAIL",
      mailboxId: mailbox,
      providerMessageId: `p-${sequence}`,
      senderAuthenticated: mail.authenticated ?? false,
    },
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
  it("an exact application and ATS key cannot override a contradictory employer assertion", async () => {
    const { user, mailbox } = await fresh();
    const link = "https://boards.greenhouse.io/acme/jobs/4012345";
    assert.equal((await gmail(user, mailbox, { subject: "Application received",
      text: `We received your application for the Backend Engineer role at Acme.\nApplication ID: APP-11111\n${link}` })).status, "APPLIED");
    const update = await gmail(user, mailbox, { subject: "Interview invitation",
      text: `Please schedule your interview for the Backend Engineer role at OtherCo.\nApplication ID: APP-11111\n${link}` });
    assert.equal(update.status === "REVIEW" && update.reason, "AMBIGUOUS_OPENING");
    assert.deepEqual(await events(user), ["CONFIRMATION_RECEIVED"]);
  });
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

describe("links in hiring mail", () => {
  it("an assessment invite with a tokenized login link is processed", async () => {
    const { user, mailbox } = await fresh();
    await gmail(user, mailbox, {
      subject: "Application received",
      text: "We received your application for the Data Engineer role at Acme.\nView status: https://acme.example/candidate/status?token=Zx81Qp",
    });
    const out = await gmail(user, mailbox, {
      subject: "Next step: coding assessment",
      text: "Please complete the coding assessment for the Data Engineer role at Acme: https://www.hackerrank.com/tests/abc123/login?token=Zx81Qp",
      date: "Tue, 13 Oct 2026 09:30:00 +0000",
    });
    assert.notEqual(out.status, "SKIPPED_SENSITIVE");
    assert.deepEqual(await openings(user), [{ company: "Acme", title: "Data Engineer" }]);
  });

  it("an access link in mail with no hiring signal is still skipped", async () => {
    const { user, mailbox } = await fresh();
    const out = await gmail(user, mailbox, {
      subject: "Your candidate profile",
      text: "Open your dashboard: https://acme.example/portal?token=Zx81Qp",
    });
    assert.equal(out.status, "SKIPPED_SENSITIVE");
  });
});

describe("follow-ups without an application ID or submitted email", () => {
  const ats = '"Acme" <no-reply@us.greenhouse-mail.io>';
  const confirm = {
    from: ats,
    authenticated: true,
    subject: "Thank you for applying to Acme",
    text: "Hi Robin,\n\nThank you for applying to Acme. We've received your application for the Data Engineer position.",
  };

  it("an interview invite and an authenticated rejection reach the only attempt", async () => {
    const { user, mailbox } = await fresh();
    assert.equal((await gmail(user, mailbox, confirm)).status, "APPLIED");
    const invite = await gmail(user, mailbox, {
      from: ats, authenticated: true, date: "Tue, 13 Oct 2026 09:30:00 +0000",
      subject: "Interview invitation - Data Engineer",
      text: "Hi Robin,\n\nWe would like to invite you to interview for the Data Engineer position at Acme.",
    });
    assert.equal(invite.status, "APPLIED");
    const reject = await gmail(user, mailbox, {
      from: ats, authenticated: true, date: "Wed, 14 Oct 2026 09:30:00 +0000",
      subject: "Your application to Acme",
      text: "Hi Robin,\n\nThank you for your interest in the Data Engineer position at Acme. Unfortunately, we have decided to move forward with other candidates.",
    });
    assert.equal(reject.status, "APPLIED");
    assert.deepEqual(await events(user), ["CONFIRMATION_RECEIVED", "INTERVIEW_INVITED", "REJECTION_RECEIVED"]);
  });

  it("a rejection from an unauthenticated sender still needs a person", async () => {
    const { user, mailbox } = await fresh();
    await gmail(user, mailbox, confirm);
    const reject = await gmail(user, mailbox, {
      from: ats, authenticated: false, date: "Wed, 14 Oct 2026 09:30:00 +0000",
      subject: "Your application to Acme",
      text: "Hi Robin,\n\nUnfortunately, we have decided to move forward with other candidates for the Data Engineer position at Acme.",
    });
    assert.equal(reject.status === "REVIEW" && reject.reason, "TERMINAL_NEEDS_REVIEW");
  });

  it("a rejection in another mailbox than the confirmation still needs a person", async () => {
    const { user, mailbox } = await fresh();
    await gmail(user, mailbox, confirm);
    const other = await seedMailbox(db, user, "second@example.com");
    const reject = await gmail(user, other, {
      from: ats, authenticated: true, date: "Wed, 14 Oct 2026 09:30:00 +0000",
      subject: "Your application to Acme",
      text: "Hi Robin,\n\nUnfortunately, we have decided to move forward with other candidates for the Data Engineer position at Acme.",
    });
    assert.equal(reject.status === "REVIEW" && reject.reason, "TERMINAL_NEEDS_REVIEW");
  });
});

describe("waiting updates reconcile when the attempt they need appears", () => {
  const openReviews = async (user: string) =>
    (await db.query<{ reason_code: string }>(
      "SELECT reason_code FROM review_items WHERE user_id=$1 AND state='OPEN'", [user])).rows.map(r => r.reason_code);

  // Both confirmations link the same Greenhouse job, so the opening is identified; company and
  // title alone never merge two confirmations into one opening.
  it("an update for a second application waits as AMBIGUOUS_ATTEMPT and applies once that application is confirmed", async () => {
    const { user, mailbox } = await fresh();
    await gmail(user, mailbox, {
      subject: "Application received",
      text: "We received your application for the Data Engineer role at Acme.\nApplication ID: GH-1\nJob: https://boards.greenhouse.io/acme/jobs/4012345",
    });
    const early = await gmail(user, mailbox, {
      subject: "Interview invitation", date: "Wed, 14 Oct 2026 09:30:00 +0000",
      text: "We would like to invite you to interview for the Data Engineer role at Acme.\nApplication ID: GH-2",
    });
    assert.equal(early.status === "REVIEW" && early.reason, "AMBIGUOUS_ATTEMPT");
    const second = await gmail(user, mailbox, {
      subject: "Application received", date: "Tue, 13 Oct 2026 09:30:00 +0000",
      text: "We received your application for the Data Engineer role at Acme.\nApplication ID: GH-2\nJob: https://boards.greenhouse.io/acme/jobs/4012345",
    });
    assert.deepEqual(second, { ...second, status: "APPLIED", reconciled: 1 });
    assert.deepEqual(await openReviews(user), []);
    const { rows } = await db.query<{ id: string; kind: string }>(
      `SELECT a.external_application_id AS id, e.event_kind AS kind FROM application_events e
         JOIN application_attempts a ON a.id = e.attempt_id WHERE e.user_id=$1 AND e.review_state='ACCEPTED'
        ORDER BY a.external_application_id, e.occurred_at`, [user]);
    assert.deepEqual(rows, [
      { id: "GH-1", kind: "CONFIRMATION_RECEIVED" },
      { id: "GH-2", kind: "CONFIRMATION_RECEIVED" },
      { id: "GH-2", kind: "INTERVIEW_INVITED" },
    ]);
  });

  it("an attempt created from review lets a waiting update apply", async () => {
    const { user, mailbox } = await fresh();
    const incomplete = await gmail(user, mailbox, {
      subject: "Application received",
      text: "Thank you for applying to Acme. We have received your application.",
    });
    assert.equal(incomplete.status === "REVIEW" && incomplete.reason, "MISSING_JOB_DETAILS");
    const waiting = await gmail(user, mailbox, {
      subject: "Interview invitation", date: "Wed, 14 Oct 2026 09:30:00 +0000",
      text: "We would like to invite you to interview for the Data Engineer role at Acme.",
    });
    assert.equal(waiting.status === "REVIEW" && waiting.reason, "NO_KNOWN_SUBMISSION");
    await resolveReviewCreate(db, user, (incomplete as { reviewId: string }).reviewId, { company: "Acme", title: "Data Engineer" });
    assert.deepEqual(await openReviews(user), []);
    assert.deepEqual(await events(user), ["CONFIRMATION_RECEIVED", "INTERVIEW_INVITED"]);
  });
});
