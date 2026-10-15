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
  } finally {
    await t.close();
  }
});
