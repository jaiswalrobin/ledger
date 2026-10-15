import assert from "node:assert/strict";
import { it } from "node:test";
import { parseEml } from "../src/ingestion/eml.ts";
import { ingestOriginal, type IngestSource } from "../src/server/pipeline.ts";
import { buildEml } from "./helpers/eml.ts";
import { createTestDb, seedMailbox, seedUser } from "./helpers/db.ts";

/** A synthetic copy of one employer's interview thread: two rounds, reminders, two reschedules. */
const invite = (sequence: number, start: string) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:weave-round-two@calendar.example",
    `SEQUENCE:${sequence}`,
    "DTSTAMP:20261009T093000Z",
    `DTSTART:${start}`,
    "SUMMARY:Interview with Weave",
    "DESCRIPTION:Interview with Weave for the Senior Frontend Engineer role.",
    "ORGANIZER:mailto:swati.jain@weave.example",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
const swati = "Swati Jain <swati.jain@weave.example>";
const ats = "Weave Talent Acquisition <no-reply@ashbyhq.com>";

export const WEAVE = [
  {
    id: "applied",
    from: ats,
    subject: "Thank you for applying to Weave",
    date: "Mon, 14 Sep 2026 09:00:00 +0000",
    text: "Hi Robin, thank you for applying to the Senior Frontend Engineer position at Weave. We have received your application.",
  },
  {
    id: "first-round",
    from: swati,
    subject: "Interview confirmed - Weave",
    date: "Mon, 28 Sep 2026 09:00:00 +0000",
    text: "Hi Robin, your interview for the Senior Frontend Engineer role is confirmed for Wednesday, Sep 30.",
  },
  {
    id: "next-round",
    from: "Nikita Rathi <nikita.rathi@weave.example>",
    subject: "Robin, Weave Next Steps!",
    date: "Wed, 07 Oct 2026 09:00:00 +0000",
    text: "Hi Robin, Good news! We received positive feedback from your previous interview for the Senior Frontend Engineer role. We would like to invite you to the next round. Please submit your availability.",
  },
  {
    id: "availability",
    from: ats,
    subject: "Reminder: Submit Your Availability for Weave",
    date: "Thu, 08 Oct 2026 09:00:00 +0000",
    text: "Hi Robin, Just a quick reminder to share your availability so we can schedule your interview for the Senior Frontend Engineer role.",
  },
  {
    id: "details",
    from: swati,
    subject: "Robin, Interview Confirmation and Details- Weave",
    date: "Fri, 09 Oct 2026 08:00:00 +0000",
    text: "Hi Robin, Thanks for submitting your availability for the Senior Frontend Engineer role. Your interview is confirmed for Thursday, Oct 15 at 9am IST. Here is what to expect in the interview.",
  },
  {
    id: "invite-0",
    from: swati,
    subject:
      "Invitation: Interview with Weave @ Thu Oct 15, 2026 9am - 10:30am (IST)",
    date: "Fri, 09 Oct 2026 08:05:00 +0000",
    text: "Interview with Weave",
    calendar: invite(0, "20261015T033000Z"),
  },
  {
    id: "reschedule",
    from: swati,
    subject: "[Reschedule], Interview Confirmation and Details- Weave",
    date: "Thu, 15 Oct 2026 06:14:00 +0000",
    text: "Hi Robin, I apologise for the inconvenience caused. Your interview has been rescheduled to Friday, Oct 16.",
    inReplyTo: "<details@weave.example>",
  },
  {
    id: "invite-1",
    from: swati,
    subject:
      "Updated invitation: Interview with Weave @ Fri Oct 16, 2026 11am - 12:30pm (IST)",
    date: "Thu, 15 Oct 2026 06:14:30 +0000",
    text: "Interview with Weave",
    calendar: invite(1, "20261016T053000Z"),
  },
  {
    id: "invite-2",
    from: swati,
    subject:
      "Updated invitation: Interview with Weave @ Fri Oct 16, 2026 4pm - 5:30pm (IST)",
    date: "Thu, 15 Oct 2026 06:30:00 +0000",
    text: "Interview with Weave",
    calendar: invite(2, "20261016T103000Z"),
  },
  {
    id: "reminder",
    from: ats,
    subject: "Reminder: Your Upcoming Interview with Weave",
    date: "Thu, 15 Oct 2026 07:00:00 +0000",
    text: "Hi Robin, You have an upcoming interview with Weave for the Senior Frontend Engineer role tomorrow.",
  },
];

export async function original(mail: (typeof WEAVE)[number]) {
  let raw = buildEml({
    from: mail.from,
    to: "robin@example.com",
    subject: mail.subject,
    date: mail.date,
    messageId: `<${mail.id}@weave.example>`,
    text: mail.text,
    ...(mail.calendar
      ? {
          attachments: [
            {
              filename: "invite.ics",
              mime: "text/calendar; method=REQUEST",
              content: mail.calendar,
            },
          ],
        }
      : {}),
  });
  if (mail.inReplyTo)
    raw = raw.replace(
      "MIME-Version",
      `In-Reply-To: ${mail.inReplyTo}\r\nMIME-Version`,
    );
  return (await parseEml(new TextEncoder().encode(raw)))[0]!;
}

it("one interview round is a few facts with its emails as evidence, not one entry per email", async () => {
  const t = await createTestDb();
  try {
    const userId = await seedUser(t.db);
    const mailboxId = await seedMailbox(t.db, userId);
    const source = (id: string): IngestSource => ({
      kind: "GMAIL",
      mailboxId,
      providerMessageId: id,
      senderAuthenticated: true,
    });
    for (const mail of WEAVE) {
      const outcome = await ingestOriginal(t.db, {
        userId,
        source: source(mail.id),
        original: await original(mail),
        observedAt: new Date("2026-10-15T08:00:00Z"),
      });
      assert.equal(outcome.status, "APPLIED", mail.id);
    }
    const events = await t.db.query<{
      kind: string;
      starts_round: boolean;
      evidence: number;
    }>(
      `SELECT e.event_kind AS kind, e.starts_round, count(ev.artifact_id)::int AS evidence
         FROM application_events e JOIN event_evidence ev ON ev.event_id = e.id
        WHERE e.user_id = $1 GROUP BY e.id ORDER BY e.occurred_at, e.id`,
      [userId],
    );
    assert.deepEqual(events.rows, [
      { kind: "CONFIRMATION_RECEIVED", starts_round: false, evidence: 1 },
      { kind: "INTERVIEW_SCHEDULED", starts_round: false, evidence: 1 },
      // The next-round email, with the availability reminder as more evidence.
      { kind: "INTERVIEW_INVITED", starts_round: true, evidence: 2 },
      // The details email, with the reschedule reply and the final reminder.
      { kind: "INTERVIEW_SCHEDULED", starts_round: false, evidence: 3 },
      // Each calendar revision keeps its own time.
      { kind: "INTERVIEW_SCHEDULED", starts_round: false, evidence: 1 },
      { kind: "INTERVIEW_SCHEDULED", starts_round: false, evidence: 1 },
      { kind: "INTERVIEW_SCHEDULED", starts_round: false, evidence: 1 },
    ]);

    // The read model shows the same story: two rounds, the latest meeting, every email counted.
    const { getOpening, listOpenings } =
      await import("../src/server/queries.ts");
    const [opening] = await listOpenings(
      t.db,
      userId,
      new Date("2026-10-15T08:00:00Z"),
    );
    assert.deepEqual(opening!.attempts[0]!.round, {
      number: 2,
      kind: "INTERVIEW",
    });
    const detail = await getOpening(
      t.db,
      userId,
      opening!.id,
      new Date("2026-10-15T08:00:00Z"),
    );
    assert.deepEqual(detail!.attempts[0]!.rounds, [
      {
        number: 1,
        kind: "INTERVIEW",
        startedAt: "2026-09-28T09:00:00.000Z",
        meetingAt: null,
        reschedules: 0,
        scheduled: true,
        followsUnseenRound: false,
        emails: 1,
      },
      {
        number: 2,
        kind: "INTERVIEW",
        startedAt: "2026-10-07T09:00:00.000Z",
        meetingAt: "2026-10-16T10:30:00.000Z",
        reschedules: 2,
        scheduled: true,
        followsUnseenRound: false,
        emails: 8,
      },
    ]);
    assert.deepEqual(
      detail!.attempts[0]!.events.map((e) => e.round),
      [null, 1, 2, 2, 2, 2, 2],
    );
    // The final reminder only attached as evidence, but it is still the latest activity.
    assert.equal(
      detail!.attempts[0]!.lastActivityAt,
      "2026-10-15T07:00:00.000Z",
    );
  } finally {
    await t.close();
  }
});

it("forwarded copies: resolving the first review clears the rest, but never a rejection", async () => {
  const { resolveReviewCreate } = await import("../src/server/actions.ts");
  const t = await createTestDb();
  try {
    const userId = await seedUser(t.db);
    const reviews: string[] = [];
    // No confirmation on record: every email waits for the application to exist.
    for (const mail of WEAVE.filter((m) => m.id !== "applied")) {
      const outcome = await ingestOriginal(t.db, {
        userId,
        source: { kind: "FORWARDED_EML" },
        original: await original(mail),
        observedAt: new Date("2026-10-15T08:00:00Z"),
      });
      assert.equal(outcome.status, "REVIEW", mail.id);
      if (outcome.status === "REVIEW") reviews.push(outcome.reviewId);
    }
    // Grouping may use an employer's own domain, never a shared hiring platform's.
    const { listReviews } = await import("../src/server/queries.ts");
    const domains = new Set(
      (await listReviews(t.db, userId)).map((r) => r.employerDomain),
    );
    assert.deepEqual([...domains].sort(), [null, "weave.example"]);
    await resolveReviewCreate(t.db, userId, reviews[0]!, {
      company: "Weave",
      title: "Senior Frontend Engineer",
    } as never);
    const open = await t.db.query(
      "SELECT 1 FROM review_items WHERE user_id = $1 AND state = 'OPEN'",
      [userId],
    );
    assert.equal(open.rows.length, 0);

    // A forwarded rejection that names no role cannot be matched through the sender's domain.
    const rejection = await ingestOriginal(t.db, {
      userId,
      source: { kind: "FORWARDED_EML" },
      original: await original({
        id: "rejection",
        from: swati,
        subject: "Update from Weave",
        date: "Mon, 19 Oct 2026 09:00:00 +0000",
        text: "Hi Robin, thank you for your time. Unfortunately, we have decided to move forward with other candidates.",
      }),
      observedAt: new Date("2026-10-20T08:00:00Z"),
    });
    assert.equal(rejection.status, "REVIEW");
  } finally {
    await t.close();
  }
});

it("a next-round email assigned by hand keeps its round marker", async () => {
  const { resolveReviewAssign } = await import("../src/server/actions.ts");
  const t = await createTestDb();
  try {
    const userId = await seedUser(t.db);
    const mailboxId = await seedMailbox(t.db, userId);
    const ingest = async (mail: Parameters<typeof original>[0]) =>
      ingestOriginal(t.db, {
        userId,
        source: {
          kind: "GMAIL",
          mailboxId,
          providerMessageId: mail.id,
          senderAuthenticated: true,
        },
        original: await original(mail),
        observedAt: new Date("2026-10-15T08:00:00Z"),
      });
    const applied = await ingest(WEAVE[0]!);
    assert.equal(applied.status, "APPLIED");
    if (applied.status !== "APPLIED") return;
    // Round one only got as far as an invitation, so no time rule separates the rounds.
    await ingest({
      id: "first-invite",
      from: swati,
      subject: "Interview invitation - Weave",
      date: "Mon, 21 Sep 2026 09:00:00 +0000",
      text: "Hi Robin, we would like to invite you to an interview for the Senior Frontend Engineer role.",
    });
    // From a personal address and naming neither company nor role: it waits for a person.
    const next = await ingest({
      id: "next-personal",
      from: "Nikita Rathi <nikita.rathi@gmail.com>",
      subject: "Good news",
      date: "Wed, 07 Oct 2026 09:00:00 +0000",
      text: "Hi Robin, Good news! We received positive feedback from your previous interview, and we would like to invite you to the next round.",
    });
    assert.equal(next.status, "REVIEW");
    if (next.status !== "REVIEW") return;
    await resolveReviewAssign(t.db, userId, next.reviewId, applied.attemptId);
    const { getOpening } = await import("../src/server/queries.ts");
    const detail = await getOpening(
      t.db,
      userId,
      applied.openingId,
      new Date("2026-10-15T08:00:00Z"),
    );
    assert.equal(detail!.attempts[0]!.rounds.length, 2);
  } finally {
    await t.close();
  }
});

it("a thread whose first round never reached Ledger is numbered from round 2", async () => {
  const t = await createTestDb();
  try {
    const userId = await seedUser(t.db);
    const mailboxId = await seedMailbox(t.db, userId);
    let openingId = "";
    // Everything except the first-round email: Ledger's first step is "positive feedback".
    for (const mail of WEAVE.filter((m) => m.id !== "first-round")) {
      const outcome = await ingestOriginal(t.db, {
        userId,
        source: {
          kind: "GMAIL",
          mailboxId,
          providerMessageId: mail.id,
          senderAuthenticated: true,
        },
        original: await original(mail),
        observedAt: new Date("2026-10-15T08:00:00Z"),
      });
      if (outcome.status === "APPLIED") openingId = outcome.openingId;
    }
    const { getOpening } = await import("../src/server/queries.ts");
    const now = new Date("2026-10-15T08:00:00Z");
    const rounds = (await getOpening(t.db, userId, openingId, now))!
      .attempts[0]!.rounds;
    assert.deepEqual(
      rounds.map((r) => [r.number, r.followsUnseenRound]),
      [[2, true]],
    );
  } finally {
    await t.close();
  }
});

it("the owner can mark where a round starts, for history recorded without the marker", async () => {
  const { setRoundStart } = await import("../src/server/actions.ts");
  const { getOpening } = await import("../src/server/queries.ts");
  const t = await createTestDb();
  try {
    const userId = await seedUser(t.db);
    const mailboxId = await seedMailbox(t.db, userId);
    let openingId = "";
    for (const mail of WEAVE.filter((m) => m.id !== "first-round")) {
      const outcome = await ingestOriginal(t.db, {
        userId,
        source: {
          kind: "GMAIL",
          mailboxId,
          providerMessageId: mail.id,
          senderAuthenticated: true,
        },
        original: await original(mail),
        observedAt: new Date("2026-10-15T08:00:00Z"),
      });
      if (outcome.status === "APPLIED") openingId = outcome.openingId;
    }
    // History recorded before rounds existed carries no marker.
    await t.db.query(
      "UPDATE application_events SET starts_round = false WHERE user_id = $1",
      [userId],
    );
    const now = new Date("2026-10-15T08:00:00Z");
    const before = (await getOpening(t.db, userId, openingId, now))!
      .attempts[0]!;
    assert.deepEqual(
      before.rounds.map((r) => r.number),
      [1],
    );

    const next = before.events.find((e) => e.kind === "INTERVIEW_INVITED")!;
    await setRoundStart(t.db, userId, next.id, true);
    const after = (await getOpening(t.db, userId, openingId, now))!
      .attempts[0]!;
    assert.deepEqual(
      after.rounds.map((r) => [r.number, r.followsUnseenRound]),
      [[2, true]],
    );
    assert.equal(after.round?.number, 2);

    await setRoundStart(t.db, userId, next.id, false);
    assert.deepEqual(
      (await getOpening(t.db, userId, openingId, now))!.attempts[0]!.rounds.map(
        (r) => r.number,
      ),
      [1],
    );
    // Only assessment and interview events can start a round.
    const confirmation = after.events.find(
      (e) => e.kind === "CONFIRMATION_RECEIVED",
    )!;
    await assert.rejects(
      setRoundStart(t.db, userId, confirmation.id, true),
      /NOT_FOUND/,
    );
  } finally {
    await t.close();
  }
});
