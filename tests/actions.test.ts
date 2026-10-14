import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseEml } from "../src/ingestion/eml.ts";
import {
  ActionError,
  dismissReview,
  resolveReviewAssign,
  resolveReviewCreate,
  setAttemptStatus,
  setEventState,
} from "../src/server/actions.ts";
import type { Db } from "../src/server/db.ts";
import { ingestOriginal, type IngestOutcome } from "../src/server/pipeline.ts";
import { buildEml, forwardAsAttachment, type EmlSpec } from "./helpers/eml.ts";
import { createTestDb, seedUser, type TestDb } from "./helpers/db.ts";
import {
  APPLICANT_A,
  APPLICANT_B,
  greenhouseConfirmation,
  interviewInvite,
  newsletter,
  rejection,
} from "./helpers/fixtures.ts";

let t: TestDb;
let db: Db;
before(async () => {
  t = await createTestDb();
  db = t.db;
});
after(() => t.close());

async function ingest(
  userId: string,
  spec: EmlSpec | string,
): Promise<IngestOutcome> {
  const raw = typeof spec === "string" ? spec : buildEml(spec);
  const [original] = await parseEml(new TextEncoder().encode(raw));
  return ingestOriginal(db, {
    userId,
    source: { kind: "FORWARDED_EML", syntheticFixture: true },
    original: original!,
    observedAt: new Date("2027-02-01T12:00:00Z"),
  });
}

const attempts = async (u: string) =>
  (
    await db.query<{
      id: string;
      stage: string;
      outcome: string;
      applicant_email_snapshot: string;
    }>(
      "SELECT id, stage, outcome, applicant_email_snapshot FROM application_attempts WHERE user_id = $1 ORDER BY created_at, id",
      [u],
    )
  ).rows;

const reviewState = async (id: string) =>
  (
    await db.query<{ state: string; resolution: string | null }>(
      "SELECT state, resolution FROM review_items WHERE id = $1",
      [id],
    )
  ).rows[0]!;

async function twoAttempts(u: string) {
  await ingest(u, greenhouseConfirmation(APPLICANT_A, undefined, "a", "GH-1"));
  await ingest(
    u,
    greenhouseConfirmation(
      APPLICANT_B,
      "Wed, 07 Oct 2026 10:00:00 +0000",
      "b",
      "GH-2",
    ),
  );
  return attempts(u);
}

async function acceptedEventId(
  u: string,
  attemptId: string,
  kind: string,
): Promise<string> {
  return (
    await db.query<{ id: string }>(
      "SELECT id FROM application_events WHERE user_id = $1 AND attempt_id = $2 AND event_kind = $3",
      [u, attemptId, kind],
    )
  ).rows[0]!.id;
}

describe("reversible events", () => {
  it("rejecting an auto event rolls the projection back, and re-observing the email does not resurrect it", async () => {
    const u = await seedUser(db);
    const [a] = await twoAttempts(u);
    await ingest(u, interviewInvite(APPLICANT_A, undefined, "GH-1"));
    assert.equal((await attempts(u))[0]!.stage, "INTERVIEW");

    await setEventState(
      db,
      u,
      await acceptedEventId(u, a!.id, "INTERVIEW_INVITED"),
      "REJECTED",
    );
    assert.equal((await attempts(u))[0]!.stage, "APPLIED");

    // A differently serialised copy of the SAME original arrives via a forward: evidence is
    // linked as a second observation, no event is recreated, and the owner's correction stands.
    const copy = buildEml(
      interviewInvite(APPLICANT_A, undefined, "GH-1"),
    ).replace("Hi Robin", "Hi  Robin");
    const again = await ingest(u, forwardAsAttachment([copy]));
    assert.equal(again.status, "DUPLICATE_OBSERVATION");
    assert.equal((await attempts(u))[0]!.stage, "APPLIED");

    await setEventState(
      db,
      u,
      await acceptedEventId(u, a!.id, "INTERVIEW_INVITED"),
      "ACCEPTED",
    );
    assert.equal((await attempts(u))[0]!.stage, "INTERVIEW");
  });

  it("a manual status correction becomes the projected state and keeps provenance as an event", async () => {
    const u = await seedUser(db);
    const [a] = await twoAttempts(u);
    await setAttemptStatus(db, u, a!.id, {
      stage: "INTERVIEW",
      outcome: "WITHDRAWN",
    });
    const row = (await attempts(u))[0]!;
    assert.deepEqual([row.stage, row.outcome], ["INTERVIEW", "WITHDRAWN"]);
    const { rows } = await db.query(
      "SELECT 1 FROM application_events WHERE attempt_id = $1 AND event_kind = 'MANUAL_CORRECTION' AND origin = 'MANUAL'",
      [a!.id],
    );
    assert.equal(rows.length, 1);
  });
});

describe("review resolution", () => {
  async function ambiguousRejection(u: string) {
    const out = await ingest(u, {
      ...rejection(APPLICANT_A, null),
      date: "Mon, 12 Oct 2026 15:00:00 +0000",
      to: "unknown@example.com",
    });
    assert.equal(out.status, "REVIEW");
    return (out as Extract<IngestOutcome, { status: "REVIEW" }>).reviewId;
  }

  it("assigning an ambiguous rejection to a chosen attempt applies it there only", async () => {
    const u = await seedUser(db);
    const [a, b] = await twoAttempts(u);
    const reviewId = await ambiguousRejection(u);
    await resolveReviewAssign(db, u, reviewId, a!.id);
    const rows = await attempts(u);
    assert.equal(rows.find((r) => r.id === a!.id)!.outcome, "REJECTED");
    assert.equal(rows.find((r) => r.id === b!.id)!.outcome, "PENDING");
    assert.deepEqual(await reviewState(reviewId), {
      state: "RESOLVED",
      resolution: "ASSIGNED",
    });
  });

  it("an item cannot be resolved twice", async () => {
    const u = await seedUser(db);
    const [a] = await twoAttempts(u);
    const reviewId = await ambiguousRejection(u);
    await resolveReviewAssign(db, u, reviewId, a!.id);
    await assert.rejects(
      resolveReviewAssign(db, u, reviewId, a!.id),
      (e: unknown) => e instanceof ActionError && e.code === "ALREADY_RESOLVED",
    );
  });

  it("an update with no known submission can create the opening and attempt on request", async () => {
    const u = await seedUser(db);
    const out = await ingest(u, interviewInvite(APPLICANT_A, undefined, null));
    assert.equal(out.status, "REVIEW");
    await resolveReviewCreate(
      db,
      u,
      (out as { reviewId: string }).reviewId,
      {},
    );
    const [row] = await attempts(u);
    assert.equal(row!.stage, "INTERVIEW");
    assert.equal(row!.applicant_email_snapshot, APPLICANT_A);
    assert.equal(
      (await db.query("SELECT 1 FROM job_openings WHERE user_id = $1", [u]))
        .rows.length,
      1,
    );
  });

  it("an unrecognised forward needs the owner to say what it is, then creates the attempt", async () => {
    const u = await seedUser(db);
    const out = await ingest(u, newsletter());
    const reviewId = (out as { reviewId: string }).reviewId;
    await assert.rejects(
      resolveReviewCreate(db, u, reviewId, {
        company: "Initech",
        title: "Analyst",
      }),
      (e: unknown) => e instanceof ActionError && e.code === "KIND_REQUIRED",
    );
    await resolveReviewCreate(db, u, reviewId, {
      kind: "CONFIRMATION_RECEIVED",
      company: "Initech",
      title: "Analyst",
      applicantEmail: APPLICANT_A,
    });
    assert.equal((await attempts(u))[0]!.stage, "APPLIED");
  });

  it("dismissing records the decision and changes nothing else", async () => {
    const u = await seedUser(db);
    await twoAttempts(u);
    const reviewId = await ambiguousRejection(u);
    await dismissReview(db, u, reviewId);
    assert.deepEqual(await reviewState(reviewId), {
      state: "DISMISSED",
      resolution: "DISMISSED",
    });
    assert.ok((await attempts(u)).every((r) => r.outcome === "PENDING"));
  });
});

describe("authorization", () => {
  it("another user cannot act on someone else's attempt, event or review item", async () => {
    const owner = await seedUser(db);
    const intruder = await seedUser(db);
    const [a] = await twoAttempts(owner);
    const out = await ingest(owner, {
      ...rejection(APPLICANT_A, null),
      date: "Mon, 12 Oct 2026 15:00:00 +0000",
      to: "unknown@example.com",
    });
    const reviewId = (out as { reviewId: string }).reviewId;
    const eventId = await acceptedEventId(
      owner,
      a!.id,
      "CONFIRMATION_RECEIVED",
    );
    const notFound = (e: unknown) =>
      e instanceof ActionError && e.code === "NOT_FOUND";
    await assert.rejects(
      setAttemptStatus(db, intruder, a!.id, {
        stage: "APPLIED",
        outcome: "REJECTED",
      }),
      notFound,
    );
    await assert.rejects(
      setEventState(db, intruder, eventId, "REJECTED"),
      notFound,
    );
    await assert.rejects(
      resolveReviewAssign(db, intruder, reviewId, a!.id),
      notFound,
    );
    await assert.rejects(dismissReview(db, intruder, reviewId), notFound);
    assert.equal((await attempts(owner))[0]!.outcome, "PENDING");
  });
});

it("manual confirmation assignment fills missing submission facts and preserves existing snapshots", async()=>{
  const user=await seedUser(db);
  const invitation=await ingest(user,{from:"Acme Careers <careers@acme.example>",to:"applicant@example.com",subject:"Interview invitation",date:"Mon, 12 Oct 2026 09:30:00 +0000",text:"We would like to invite you to interview for the Backend Engineer role at Acme."});
  assert.equal(invitation.status,"REVIEW");if(invitation.status!=="REVIEW")return;
  const created=await resolveReviewCreate(db,user,invitation.reviewId,{company:"Acme",title:"Backend Engineer"});
  const query=async()=>(await db.query<{submitted_at:unknown;applicant_email_snapshot:string|null;external_application_id:string|null;submission_evidence_ids:string[]}>("SELECT submitted_at,applicant_email_snapshot,external_application_id,submission_evidence_ids FROM application_attempts WHERE id=$1",[created.attemptId])).rows[0]!;
  assert.deepEqual((await query()).submission_evidence_ids,[]);
  const receipt=await ingest(user,{from:"Acme Careers <careers@acme.example>",to:"applicant@example.com",subject:"Application received",date:"Mon, 05 Oct 2026 09:30:00 +0000",text:"We received your application.\nCompany: Acme\nApplicant email: robin@example.com\nApplication ID: APP-9000"});
  assert.equal(receipt.status,"REVIEW");if(receipt.status!=="REVIEW")return;
  await resolveReviewAssign(db,user,receipt.reviewId,created.attemptId);
  const accepted=await query();
  assert.equal(new Date(accepted.submitted_at as string).toISOString(),"2026-10-05T09:30:00.000Z");
  assert.equal(accepted.applicant_email_snapshot,"robin@example.com");
  assert.equal(accepted.external_application_id,"APP-9000");
  assert.equal(accepted.submission_evidence_ids.length,1);
});
