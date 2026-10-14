import assert from "node:assert/strict";
import { it } from "node:test";
import { parseEml, EmlError } from "../src/ingestion/eml.ts";
import { extractSignal } from "../src/ingestion/extract.ts";
import { originalKeyOf, ingestOriginal } from "../src/server/pipeline.ts";
import { buildEml } from "./helpers/eml.ts";
import { createTestDb, seedMailbox, seedUser } from "./helpers/db.ts";
import { getOpening } from "../src/server/queries.ts";
import { resolveReviewCreate } from "../src/server/actions.ts";
import { createHash, randomUUID } from "node:crypto";

function calendar(sequence = 1, start = "20261021T100000Z", extra = "", method = "REQUEST") {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", `METHOD:${method}`, "BEGIN:VEVENT", "UID:private-calendar-uid@example.com",
    `SEQUENCE:${sequence}`, "DTSTAMP:20261012T093000Z", `DTSTART:${start}`, "SUMMARY:Technical Interview - Backend Engineer",
    "DESCRIPTION:Interview for the Backend Engineer role at Acme.", "ORGANIZER:mailto:recruiting@acme.example",
    extra, "END:VEVENT", "END:VCALENDAR", ""].filter(line => line !== "").join("\r\n");
}

async function parsed(content: string, method = "REQUEST", text = "Application ID: APP-12345") {
  return (await parseEml(new TextEncoder().encode(buildEml({
    from: "Acme Careers <careers@acme.example>", to: "applicant@example.com", subject: "Interview invitation",
    date: "Mon, 12 Oct 2026 09:30:00 +0000", messageId: "<calendar@example.com>", text,
    attachments: [{ filename: "invite.ics", mime: `text/calendar; method=${method}`, content }],
  }))))[0]!;
}

it("calendar scheduling preserves event time separately from email time and hashes the UID", async () => {
  const signal = extractSignal((await parsed(calendar())).message);
  assert.equal(signal.kind, "INTERVIEW_SCHEDULED");
  assert.equal(signal.fields.company, "Acme");
  assert.equal(signal.fields.title, "Backend Engineer");
  assert.equal(signal.fields.calendar?.scheduledFor, "2026-10-21T10:00:00.000Z");
  assert.equal(signal.occurredAt, "2026-10-12T09:30:00.000Z");
  assert.match(signal.fields.calendar!.uidKey, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(signal).includes("private-calendar-uid"));
  assert.ok(!JSON.stringify(signal).includes("recruiting@"));
});

it("floating time, unknown zones, recurrences, malformed data, and MIME method conflicts require review", async () => {
  for (const content of [calendar(1, "20261021T100000"), calendar().replace("DTSTART:", "DTSTART;TZID=Unknown/Zone:"),
    calendar(1, "20261021T100000Z", "RRULE:FREQ=DAILY"), "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n", calendar(1, undefined, "", "CANCEL")]) {
    const signal = extractSignal((await parsed(content)).message);
    assert.ok(signal.reasons.includes("uncertain-calendar"));
    assert.equal(signal.confidence, "LOW");
  }
});

it("cancellation and tentative calendar requests never assert a scheduled interview", async () => {
  const cancelled = extractSignal((await parsed(calendar(2, undefined, "STATUS:CANCELLED", "CANCEL"), "CANCEL")).message);
  assert.equal(cancelled.kind, null);
  assert.ok(cancelled.reasons.includes("interview-cancelled"));
  assert.ok(extractSignal((await parsed(calendar(1, undefined, "STATUS:TENTATIVE"))).message).reasons.includes("uncertain-calendar"));
});

it("calendar content participates in original identity and attachment limits", async () => {
  assert.notEqual(originalKeyOf(await parsed(calendar(1))), originalKeyOf(await parsed(calendar(2))));
  await assert.rejects(parsed("x".repeat(100_001)), error => error instanceof EmlError && error.code === "TOO_LARGE");
});

it("calendar revisions deduplicate, reject older/conflicting versions, and keep cancellations in review", async () => {
  const t = await createTestDb();
  try {
    const userId = await seedUser(t.db), mailboxId = await seedMailbox(t.db, userId);
    let sequence = 0;
    const ingest = async (original: Awaited<ReturnType<typeof parsed>>) => ingestOriginal(t.db, {
      userId, source: { kind: "GMAIL", mailboxId, providerMessageId: `cal-${++sequence}`, senderAuthenticated:true }, original,
      observedAt: new Date("2026-10-20T12:00:00Z"),
    });
    const [confirmation] = await parseEml(new TextEncoder().encode(buildEml({
      from: "Acme Careers <careers@acme.example>", to: "applicant@example.com", subject: "Application received",
      date: "Mon, 05 Oct 2026 09:30:00 +0000",
      text: "We received your application for the Backend Engineer role at Acme.\nApplication ID: APP-12345",
    })));
    assert.equal((await ingest(confirmation!)).status, "APPLIED");
    assert.equal((await ingest(await parsed(calendar(2)))).status, "APPLIED");
    // Different observation, same revision: UID matches the previously accepted attempt.
    assert.equal((await ingest(await parsed(calendar(2), "REQUEST", "A reminder for your interview."))).status, "APPLIED");
    const older = await ingest(await parsed(calendar(1)));
    assert.equal(older.status === "REVIEW" && older.reason, "CALENDAR_REVISION");
    const conflict = await ingest(await parsed(calendar(2, "20261022T100000Z")));
    assert.equal(conflict.status === "REVIEW" && conflict.reason, "CALENDAR_REVISION");
    assert.equal((await ingest(await parsed(calendar(3, "20261023T100000Z"), "REQUEST", "A new interview time."))).status, "APPLIED");
    const cancelled = await ingest(await parsed(calendar(4, undefined, "STATUS:CANCELLED", "CANCEL"), "CANCEL"));
    assert.equal(cancelled.status === "REVIEW" && cancelled.reason, "INTERVIEW_CANCELLED");
    const events = await t.db.query("SELECT event_kind FROM application_events WHERE user_id=$1 AND review_state='ACCEPTED'", [userId]);
    assert.equal(events.rows.length, 3); // confirmation + two distinct accepted calendar revisions
    const secret = await ingest(await parsed(calendar(5, undefined, "DESCRIPTION:Your verification code is 123456")));
    assert.equal(secret.status, "SKIPPED_SENSITIVE");
  } finally { await t.close(); }
});

it("calendar identity cannot override a submitted contact or a changed organizer, and provenance is version-specific", async () => {
  const t = await createTestDb();
  try {
    const userId=await seedUser(t.db),mailboxId=await seedMailbox(t.db,userId);
    let n=0;
    const ingest=(original:Awaited<ReturnType<typeof parsed>>)=>ingestOriginal(t.db,{userId,source:{kind:"GMAIL",mailboxId,providerMessageId:`identity-${++n}`,senderAuthenticated:true},original,observedAt:new Date("2026-10-20T12:00:00Z")});
    const receipt=async(id:string,email:string)=>(await parseEml(new TextEncoder().encode(buildEml({from:"Acme Careers <careers@acme.example>",to:email,subject:"Application received",date:"Mon, 05 Oct 2026 09:30:00 +0000",text:`We received your application for the Backend Engineer role at Acme.\nApplication ID: ${id}\nApplicant email: ${email}`}))))[0]!;
    const first=await ingest(await receipt("APP-12345","a@example.com"));
    assert.equal(first.status,"APPLIED"); if(first.status!=="APPLIED")return;
    const second=await ingest(await receipt("APP-67890","b@example.com"));
    assert.equal(second.status,"REVIEW");if(second.status!=="REVIEW")return;
    await resolveReviewCreate(t.db,userId,second.reviewId,{openingId:first.openingId});
    assert.equal((await ingest(await parsed(calendar(1)))).status,"APPLIED");
    const contradict=await ingest(await parsed(calendar(2),"REQUEST","Applicant email: b@example.com"));
    assert.equal(contradict.status==="REVIEW"&&contradict.reason,"CALENDAR_REVISION");
    const organizer=await ingest(await parsed(calendar(2).replace("recruiting@acme.example","other@unrelated.example"),"REQUEST","A new time."));
    assert.equal(organizer.status==="REVIEW"&&organizer.reason,"CALENDAR_REVISION");
    const shadowUid="dismissed-proposal@example.com";
    const artifact=(await t.db.query<{id:string}>("SELECT id FROM source_artifacts WHERE user_id=$1 AND provider_message_id='identity-3'",[userId])).rows[0]!;
    await t.db.query(`INSERT INTO extracted_signals(id,user_id,source_artifact_id,extractor_version,event_kind,fields,confidence,processing_state) VALUES($1,$2,$3,'old-proposal',NULL,$4::jsonb,'LOW','DISMISSED')`,[randomUUID(),userId,artifact.id,JSON.stringify({calendar:{uidKey:createHash("sha256").update(shadowUid).digest("hex"),sequence:1}})]);
    const stale=await ingest(await parsed(calendar(2).replace("private-calendar-uid@example.com",shadowUid),"REQUEST","A new time."));
    assert.equal(stale.status==="REVIEW"&&stale.reason,"AMBIGUOUS_ATTEMPT");
    assert.equal((await ingest(await parsed(calendar(2),"REQUEST","A new time."))).status,"APPLIED");
    const detail=await getOpening(t.db,userId,first.openingId);
    const events=detail!.attempts.find(a=>a.id===first.attemptId)!.events.filter(e=>e.kind==="INTERVIEW_SCHEDULED");
    assert.equal(events.length,2);
    assert.equal(events.filter(e=>e.currentSchedule).length,1);
    assert.equal(events.find(e=>e.currentSchedule)!.calendarRevision,2);
    assert.equal(events.find(e=>e.currentSchedule)!.scheduledFor,"2026-10-21T10:00:00.000Z");
    assert.ok((await t.db.query("SELECT signal_id FROM event_evidence WHERE artifact_id=$1",[artifact.id])).rows.every(r=>r.signal_id));
  } finally {await t.close();}
});
