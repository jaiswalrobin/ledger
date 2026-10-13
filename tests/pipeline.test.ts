import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseEml } from "../src/ingestion/eml.ts";
import {
  ingestOriginal,
  type IngestOutcome,
  type IngestSource,
} from "../src/server/pipeline.ts";
import type { Db } from "../src/server/db.ts";
import { buildEml, forwardAsAttachment, type EmlSpec } from "./helpers/eml.ts";
import {
  createTestDb,
  seedMailbox,
  seedUser,
  type TestDb,
} from "./helpers/db.ts";
import {
  APPLICANT_A,
  APPLICANT_B,
  assessmentInvite,
  greenhouseConfirmation,
  interviewInvite,
  newsletter,
  offer,
  otpMessage,
  rejection,
} from "./helpers/fixtures.ts";

let t: TestDb;
let db: Db;
before(async () => {
  t = await createTestDb();
  db = t.db;
});
after(() => t.close());

const FORWARD: IngestSource = { kind: "FORWARDED_EML", syntheticFixture: true };

async function ingest(
  userId: string,
  spec: EmlSpec,
  source: IngestSource = FORWARD,
): Promise<IngestOutcome> {
  const [original] = await parseEml(new TextEncoder().encode(buildEml(spec)));
  return ingestOriginal(db, {
    userId,
    source,
    original: original!,
    observedAt: new Date("2027-02-01T12:00:00Z"),
  });
}

const count = async (sql: string, params: unknown[]): Promise<number> =>
  Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM (${sql}) q`,
        params,
      )
    ).rows[0]!.n,
  );

const counts = async (user: string) => ({
  openings: await count("SELECT 1 FROM job_openings WHERE user_id = $1", [
    user,
  ]),
  attempts: await count(
    "SELECT 1 FROM application_attempts WHERE user_id = $1",
    [user],
  ),
  events: await count(
    "SELECT 1 FROM application_events WHERE user_id = $1 AND review_state = 'ACCEPTED'",
    [user],
  ),
  reviews: await count(
    "SELECT 1 FROM review_items WHERE user_id = $1 AND state = 'OPEN'",
    [user],
  ),
});

const attemptRows = async (user: string) =>
  (
    await db.query<{
      id: string;
      stage: string;
      outcome: string;
      applicant_email_snapshot: string | null;
      external_application_id: string | null;
    }>(
      "SELECT id, stage, outcome, applicant_email_snapshot, external_application_id FROM application_attempts WHERE user_id = $1 ORDER BY created_at, id",
      [user],
    )
  ).rows;

describe("submissions", () => {
  it("a confirmation creates one opening, one attempt and one accepted event, and projects APPLIED", async () => {
    const u = await seedUser(db);
    const out = await ingest(u, greenhouseConfirmation());
    assert.equal(out.status, "APPLIED");
    assert.deepEqual(await counts(u), {
      openings: 1,
      attempts: 1,
      events: 1,
      reviews: 0,
    });
    const [a] = await attemptRows(u);
    assert.equal(a!.stage, "APPLIED");
    assert.equal(a!.outcome, "PENDING");
    assert.equal(a!.applicant_email_snapshot, APPLICANT_A);
    assert.equal(a!.external_application_id, "GH-778899");
  });

  it("re-ingesting the identical file is idempotent", async () => {
    const u = await seedUser(db);
    const spec = greenhouseConfirmation();
    await ingest(u, spec);
    const before = await counts(u);
    const second = await ingest(u, spec);
    assert.equal(second.status, "DUPLICATE");
    assert.deepEqual(await counts(u), before);
  });

  it("the same original seen via Gmail and via a forward is one signal with two evidence observations", async () => {
    const u = await seedUser(db);
    const mailbox = await seedMailbox(db, u);
    const raw = buildEml(greenhouseConfirmation());
    const [direct] = await parseEml(new TextEncoder().encode(raw));
    const first = await ingestOriginal(db, {
      userId: u,
      source: { kind: "GMAIL", mailboxId: mailbox, providerMessageId: "g-1" },
      original: direct!,
    });
    assert.equal(first.status, "APPLIED");
    // A different byte-level copy (e.g. re-serialised by a forward) of the SAME original message.
    const [viaForward] = await parseEml(
      new TextEncoder().encode(
        forwardAsAttachment([raw.replace("Hi Robin", "Hi  Robin")]),
      ),
    );
    const second = await ingestOriginal(db, {
      userId: u,
      source: FORWARD,
      original: viaForward!,
    });
    assert.equal(second.status, "DUPLICATE_OBSERVATION");
    assert.deepEqual(await counts(u), {
      openings: 1,
      attempts: 1,
      events: 1,
      reviews: 0,
    });
    assert.equal(
      await count("SELECT 1 FROM source_artifacts WHERE user_id = $1", [u]),
      2,
    );
    assert.equal(
      await count("SELECT 1 FROM event_evidence WHERE user_id = $1", [u]),
      2,
    );
  });

  it("two distinct confirmations for the same job through two applicant identities give one opening, two attempts", async () => {
    const u = await seedUser(db);
    await ingest(
      u,
      greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-1"),
    );
    await ingest(
      u,
      greenhouseConfirmation(
        APPLICANT_B,
        "Wed, 07 Oct 2026 10:00:00 +0000",
        "b",
        "GH-2",
      ),
    );
    assert.deepEqual(await counts(u), {
      openings: 1,
      attempts: 2,
      events: 2,
      reviews: 0,
    });
    const rows = await attemptRows(u);
    assert.deepEqual(
      rows.map((r) => r.applicant_email_snapshot).sort(),
      [APPLICANT_A, APPLICANT_B].sort(),
    );
  });

  it("the same email submitting twice with distinct application ids yields two attempts", async () => {
    const u = await seedUser(db);
    await ingest(
      u,
      greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-1"),
    );
    await ingest(
      u,
      greenhouseConfirmation(
        APPLICANT_A,
        "Mon, 05 Jan 2027 10:00:00 +0000",
        "b",
        "GH-9",
      ),
    );
    assert.equal((await counts(u)).attempts, 2);
  });

  it("the same email twice with NO distinguishing id is sent to review, never silently merged or split", async () => {
    const u = await seedUser(db);
    await ingest(u, greenhouseConfirmation(APPLICANT_A, undefined, "a", null));
    const second = await ingest(
      u,
      greenhouseConfirmation(
        APPLICANT_A,
        "Tue, 06 Oct 2026 10:00:00 +0000",
        "b",
        null,
      ),
    );
    assert.equal(second.status, "REVIEW");
    assert.deepEqual(await counts(u), {
      openings: 1,
      attempts: 1,
      events: 1,
      reviews: 1,
    });
  });

  it("different requisitions with an identical title are different openings", async () => {
    const u = await seedUser(db);
    await ingest(
      u,
      greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-1", "1001"),
    );
    await ingest(
      u,
      greenhouseConfirmation(
        APPLICANT_A,
        "Tue, 06 Oct 2026 10:00:00 +0000",
        "b",
        "GH-2",
        "1002",
      ),
    );
    assert.deepEqual(await counts(u), {
      openings: 2,
      attempts: 2,
      events: 2,
      reviews: 0,
    });
  });

  it("the applicant on a forwarded original is the ORIGINAL recipient, not the forwarding target", async () => {
    const u = await seedUser(db);
    const [original] = await parseEml(
      new TextEncoder().encode(
        forwardAsAttachment([buildEml(greenhouseConfirmation(APPLICANT_B))], {
          to: "tracker@example.org",
        }),
      ),
    );
    await ingestOriginal(db, {
      userId: u,
      source: FORWARD,
      original: original!,
    });
    assert.equal(
      (await attemptRows(u))[0]!.applicant_email_snapshot,
      APPLICANT_B,
    );
  });
});

describe("updates", () => {
  async function applied(u: string) {
    await ingest(
      u,
      greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-778899"),
    );
    await ingest(
      u,
      greenhouseConfirmation(
        APPLICANT_B,
        "Wed, 07 Oct 2026 10:00:00 +0000",
        "b",
        "GH-555000",
      ),
    );
  }
  const byEmail = async (u: string, email: string) =>
    (await attemptRows(u)).find((r) => r.applicant_email_snapshot === email)!;

  it("a rejection with an exact application id rejects only that attempt; the other keeps progressing", async () => {
    const u = await seedUser(db);
    await applied(u);
    assert.equal(
      (await ingest(u, rejection(APPLICANT_A, "GH-778899"))).status,
      "APPLIED",
    );
    assert.equal(
      (await ingest(u, interviewInvite(APPLICANT_B, undefined, "GH-555000")))
        .status,
      "APPLIED",
    );
    assert.equal((await byEmail(u, APPLICANT_A)).outcome, "REJECTED");
    const b = await byEmail(u, APPLICANT_B);
    assert.equal(b.outcome, "PENDING");
    assert.equal(b.stage, "INTERVIEW");
  });

  it("a rejection that names only the employer is not assigned when several attempts exist", async () => {
    const u = await seedUser(db);
    await applied(u);
    const out = await ingest(u, {
      ...rejection(APPLICANT_A, null),
      to: "someone.else@example.com",
    });
    assert.equal(out.status, "REVIEW");
    const rows = await attemptRows(u);
    assert.ok(rows.every((r) => r.outcome === "PENDING"));
  });

  it("a rejection matched only through company/title (weak opening match) still needs review", async () => {
    const u = await seedUser(db);
    await ingest(
      u,
      greenhouseConfirmation(APPLICANT_A, undefined, "a", null, "1001"),
    );
    // No application id and no job URL in this rejection.
    const out = await ingest(u, {
      ...rejection(APPLICANT_A, null),
      subject:
        "Update on your application: Senior Backend Engineer at Acme Robotics",
    });
    assert.equal(out.status, "REVIEW");
    assert.equal((await attemptRows(u))[0]!.outcome, "PENDING");
  });

  it("a non-terminal update on a unique company/title/email match is accepted and stays reversible", async () => {
    const u = await seedUser(db);
    await ingest(
      u,
      greenhouseConfirmation(APPLICANT_A, undefined, "a", null, "1001"),
    );
    const out = await ingest(u, interviewInvite(APPLICANT_A, undefined, null));
    assert.equal(out.status, "APPLIED");
    assert.equal((await attemptRows(u))[0]!.stage, "INTERVIEW");
  });

  it("an update arriving four months after the submission still updates it (no 60-day cutoff)", async () => {
    const u = await seedUser(db);
    await ingest(
      u,
      greenhouseConfirmation(
        APPLICANT_A,
        "Mon, 05 Jan 2026 09:00:00 +0000",
        "old",
        "GH-1",
      ),
    );
    const out = await ingest(u, assessmentInvite(APPLICANT_A)); // different job, so use an id-bearing interview instead
    assert.notEqual(out.status, "APPLIED"); // unrelated Northwind job: no known submission
    const late = await ingest(u, {
      ...interviewInvite(
        APPLICANT_A,
        "Mon, 04 May 2026 09:00:00 +0000",
        "GH-1",
      ),
    });
    assert.equal(late.status, "APPLIED");
    assert.equal((await attemptRows(u))[0]!.stage, "INTERVIEW");
  });

  it("an update with no known submission goes to review instead of inventing an attempt", async () => {
    const u = await seedUser(db);
    const out = await ingest(u, interviewInvite(APPLICANT_A, undefined, null));
    assert.equal(out.status, "REVIEW");
    assert.deepEqual(await counts(u), {
      openings: 0,
      attempts: 0,
      events: 0,
      reviews: 1,
    });
  });

  it("an update that arrives before its confirmation waits in review, then applies itself once the confirmation arrives", async () => {
    const u = await seedUser(db);
    const early = await ingest(
      u,
      interviewInvite(APPLICANT_A, undefined, "GH-778899"),
    );
    assert.equal(early.status, "REVIEW");
    await ingest(
      u,
      greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-778899"),
    );
    assert.equal((await attemptRows(u))[0]!.stage, "INTERVIEW");
    assert.deepEqual(await counts(u), {
      openings: 1,
      attempts: 1,
      events: 2,
      reviews: 0,
    });
    const { rows } = await db.query<{ resolution: string }>(
      "SELECT resolution FROM review_items WHERE user_id = $1",
      [u],
    );
    assert.deepEqual(
      rows.map((r) => r.resolution),
      ["AUTO_RECONCILED"],
    );
  });

  it("a rejection that arrives first is applied once its application id is known, and not before", async () => {
    const u = await seedUser(db);
    assert.equal(
      (await ingest(u, rejection(APPLICANT_A, "GH-778899"))).status,
      "REVIEW",
    );
    await ingest(
      u,
      greenhouseConfirmation(
        APPLICANT_B,
        "Wed, 07 Oct 2026 10:00:00 +0000",
        "other",
        "GH-OTHER",
      ),
    );
    assert.equal(
      (await counts(u)).reviews,
      1,
      "an unrelated submission must not absorb it",
    );
    await ingest(
      u,
      greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-778899"),
    );
    const rows = await attemptRows(u);
    assert.equal(
      rows.find((r) => r.applicant_email_snapshot === APPLICANT_A)!.outcome,
      "REJECTED",
    );
    assert.equal(
      rows.find((r) => r.applicant_email_snapshot === APPLICANT_B)!.outcome,
      "PENDING",
    );
    assert.equal((await counts(u)).reviews, 0);
  });

  it("an offer with an exact application id is accepted", async () => {
    const u = await seedUser(db);
    await ingest(
      u,
      greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-778899"),
    );
    assert.equal((await ingest(u, offer(APPLICANT_A))).status, "APPLIED");
    assert.equal((await attemptRows(u))[0]!.outcome, "OFFERED");
  });
});

describe("safety", () => {
  it("OTP mail records no signal and keeps no subject", async () => {
    const u = await seedUser(db);
    assert.equal((await ingest(u, otpMessage())).status, "SKIPPED_SENSITIVE");
    assert.deepEqual(await counts(u), {
      openings: 0,
      attempts: 0,
      events: 0,
      reviews: 0,
    });
    const { rows } = await db.query<{
      subject_redacted: string | null;
      body_access_decision: string;
    }>(
      "SELECT subject_redacted, body_access_decision FROM source_artifacts WHERE user_id = $1",
      [u],
    );
    assert.equal(rows[0]!.subject_redacted, null);
    assert.equal(rows[0]!.body_access_decision, "SKIPPED_SENSITIVE");
  });

  it("an unrecognised forwarded email becomes a review item; an unrecognised Gmail message is just dismissed", async () => {
    const u = await seedUser(db);
    const mailbox = await seedMailbox(db, u);
    const fwd = await ingest(u, newsletter());
    assert.equal(fwd.status, "REVIEW");
    const [orig] = await parseEml(
      new TextEncoder().encode(
        buildEml({ ...newsletter(), messageId: "<n2@x>" }),
      ),
    );
    const gm = await ingestOriginal(db, {
      userId: u,
      source: { kind: "GMAIL", mailboxId: mailbox, providerMessageId: "g9" },
      original: orig!,
    });
    assert.equal(gm.status, "NO_SIGNAL");
    assert.equal((await counts(u)).reviews, 1);
  });

  it("a recognised email without a Date header is never given an invented time", async () => {
    const u = await seedUser(db);
    const out = await ingest(u, { ...greenhouseConfirmation(), date: null });
    assert.equal(out.status, "REVIEW");
    assert.deepEqual(await counts(u), {
      openings: 0,
      attempts: 0,
      events: 0,
      reviews: 1,
    });
  });

  it("users are isolated: the same email creates independent data for each", async () => {
    const a = await seedUser(db);
    const b = await seedUser(db);
    const spec = greenhouseConfirmation();
    await ingest(a, spec);
    const second = await ingest(b, spec);
    assert.equal(second.status, "APPLIED");
    assert.equal((await counts(a)).openings, 1);
    assert.equal((await counts(b)).openings, 1);
  });

  it("a very large body is processed quickly (no catastrophic regex backtracking)", async () => {
    const u = await seedUser(db);
    const started = Date.now();
    await assert.rejects(
      ingest(u, {
        ...greenhouseConfirmation(),
        text:
          "Thank you for applying to " +
          "A".repeat(90_000) +
          " at at at at " +
          "x ".repeat(5000),
      }),
      /TOO_LARGE/,
    );
    assert.ok(
      Date.now() - started < 2000,
      "took " + (Date.now() - started) + "ms",
    );
  });
});
