import assert from "node:assert/strict";
import { it } from "node:test";
import { parseEml } from "../src/ingestion/eml.ts";
import { detectKind, extractSignal } from "../src/ingestion/extract.ts";
import { ingestOriginal } from "../src/server/pipeline.ts";
import { createTestDb, seedMailbox, seedUser } from "./helpers/db.ts";
import { buildEml, type EmlSpec } from "./helpers/eml.ts";

/** Synthetic reconstruction of a screening workflow; no original headers, links or identities. */
const prescreen: EmlSpec = {
  from: '"Screening Assistant" <notifications@screening.example>',
  to: "applicant@example.net",
  subject: "Pre-Screening Invitation",
  date: "Fri, 16 Oct 2026 12:00:00 +0000",
  text: [
    "Thank you for your interest in the Frontend Software Engineer Payments Platform opportunity with Northwind and its client!",
    "We invite you to continue our process with a brief conversation about your experience and availability.",
    "In this first step, you will speak with our AI interviewer.",
    "Once you have finished your interview with our AI interviewer, you will hear back from a Talent Specialist regarding the next steps.",
    "If you are selected to move forward in the process, you will be scheduled for a live call.",
    "If you prefer to schedule your pre-screening with a Talent Specialist instead, please let us know.",
    "Complete your pre-screen below!",
    "Take Interview\nSchedule Interview",
  ].join("\n\n"),
};

async function original(spec: EmlSpec) {
  const [parsed] = await parseEml(Buffer.from(buildEml(spec)));
  return parsed!;
}

it("a pre-screen invitation retains its role without asserting a scheduled interview", async () => {
  for (const spec of [
    prescreen,
    {
      ...prescreen,
      text: prescreen.text!.replace(
        "Frontend Software Engineer Payments Platform",
        "Frontend Software\nEngineer Payments Platform",
      ),
    },
    {
      ...prescreen,
      text: "",
      html: prescreen
        .text!.split("\n\n")
        .map((p) => `<p>${p}</p>`)
        .join(""),
    },
  ]) {
    const signal = extractSignal((await original(spec)).message);
    assert.equal(signal.kind, "INTERVIEW_INVITED");
    assert.equal(
      signal.fields.title,
      "Frontend Software Engineer Payments Platform",
    );
    assert.equal(signal.fields.calendar, undefined);
    assert.ok(!signal.reasons.includes("phrase:INTERVIEW_SCHEDULED"));
  }
});

it("once-completed instructions never assert a scheduled interview, including hard wraps", () => {
  for (const text of [
    "Once you have finished your interview with us, you will hear back from our team.",
    "Once you’ve finished your interview with us, you’ll hear back from our team.",
    "Once you have finished your interview with us we will get in touch.",
    "Once you have finished your\ninterview with us, you will hear back from our team.",
    "Once you complete the assessment, your interview will be scheduled.",
  ])
    assert.equal(detectKind(text).kind, null, text);
});

it("a once-clause starts a new assertion region after a single newline", () => {
  assert.equal(
    detectKind(
      "Schedule Interview\nOnce you have finished your interview with us, we will contact you.",
    ).kind,
    "INTERVIEW_INVITED",
  );
});

it("once-conditions cannot assert rejections, offers or cancellations", () => {
  for (const text of [
    "Once you accept the offer of employment, we will discuss your start date.",
    "Once we have decided to move forward with other candidates, we will let you know.",
    "Once your interview is cancelled, please contact us.",
    "Once we have decided to move forward with other candidates we will let you know.",
  ])
    assert.equal(detectKind(text).kind, null, text);
});

it("an asserted main clause still contributes its invitation or booking", () => {
  for (const [text, expected] of [
    [
      "Once you are ready, we would like to schedule an interview.",
      "INTERVIEW_INVITED",
    ],
    [
      "Once you are ready we would like to schedule an interview.",
      "INTERVIEW_INVITED",
    ],
    [
      "Once you are ready, your interview is confirmed for Monday.",
      "INTERVIEW_SCHEDULED",
    ],
    [
      "Your interview is confirmed for Monday. Once you finish your interview with us, we will contact you.",
      "INTERVIEW_SCHEDULED",
    ],
  ] as const)
    assert.equal(detectKind(text).kind, expected, text);
});

it("once reaffirmations and compounds preserve their assertions", () => {
  for (const prefix of ["Once again", "Once more"])
    for (const comma of [",", ""])
      assert.equal(
        detectKind(`${prefix}${comma} your interview is confirmed for Monday.`)
          .kind,
        "INTERVIEW_SCHEDULED",
      );
  assert.equal(
    detectKind("Once-only interview invitation").kind,
    "INTERVIEW_INVITED",
  );
});

it("a pre-screen keeps conflicting organization claims separate", async () => {
  const signal = extractSignal(
    (
      await original({
        ...prescreen,
        from: '"Assistant at Cedar" <notifications@cedar.example>',
        subject: "Cedar, a Northwind Company, Pre-Screening Invitation",
      })
    ).message,
  );
  assert.equal(signal.kind, "INTERVIEW_INVITED");
  assert.equal(signal.fields.company, null);
  assert.equal(signal.fields.fieldDecisions?.company.state, "AMBIGUOUS");
  assert.ok(signal.reasons.includes("conflicting-fields"));
});

it("the pipeline records an invitation without a booked meeting and preserves organization conflicts", async () => {
  const t = await createTestDb();
  try {
    const userId = await seedUser(t.db);
    const mailboxId = await seedMailbox(t.db, userId, "tracker@example.org");
    let sequence = 0;
    const ingest = async (spec: EmlSpec) =>
      ingestOriginal(t.db, {
        userId,
        source: {
          kind: "GMAIL",
          mailboxId,
          providerMessageId: `prescreen-${++sequence}`,
          senderAuthenticated: true,
        },
        original: await original({
          ...spec,
          messageId: `<prescreen-${sequence}@example.org>`,
        }),
        observedAt: new Date("2026-10-20T12:00:00Z"),
      });
    assert.equal(
      (
        await ingest({
          ...prescreen,
          subject: "Application received",
          date: "Mon, 12 Oct 2026 09:00:00 +0000",
          text: "We received your application.\nCompany: Northwind\nJob Title: Frontend Software Engineer Payments Platform",
        })
      ).status,
      "APPLIED",
    );
    const invitation = await ingest(prescreen);
    assert.equal(invitation.status, "APPLIED");
    const { rows } = await t.db.query<{
      event_kind: string;
      scheduled_for: string | null;
    }>(
      "SELECT event_kind,scheduled_for FROM application_events WHERE user_id=$1 ORDER BY occurred_at",
      [userId],
    );
    assert.deepEqual(
      rows.map((r) => r.event_kind),
      ["CONFIRMATION_RECEIVED", "INTERVIEW_INVITED"],
    );
    assert.ok(rows.every((r) => r.scheduled_for === null));
    const ambiguous = await ingest({
      ...prescreen,
      from: '"Assistant at Cedar" <notifications@cedar.example>',
      subject: "Cedar, a Northwind Company, Pre-Screening Invitation",
    });
    assert.equal(
      ambiguous.status === "REVIEW" && ambiguous.reason,
      "CONFLICTING_FIELDS",
    );
    assert.equal(
      (
        await t.db.query("SELECT 1 FROM application_events WHERE user_id=$1", [
          userId,
        ])
      ).rows.length,
      2,
    );
  } finally {
    await t.close();
  }
});
