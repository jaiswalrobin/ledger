import assert from "node:assert/strict";
import { it } from "node:test";
import { parseEml } from "../src/ingestion/eml.ts";
import { extractSignal } from "../src/ingestion/extract.ts";
import { buildEml } from "./helpers/eml.ts";
import { messageRegions } from "../src/ingestion/regions.ts";

async function extract(text: string, html?: string, subject = "Application received") {
  const [original] = await parseEml(new TextEncoder().encode(buildEml({
    from: "Acme Careers <careers@acme.example>", to: "applicant@example.com", subject, text,
    ...(html === undefined ? {} : { html }),
  })));
  return extractSignal(original!.message);
}

it("plain-text history cannot change current fields, application id, or declared applicant", async () => {
  const current = "We received your application for the Backend Engineer role at Acme.";
  const history = "\n\nOn Monday, Recruiter wrote:\n> We received your application for the Frontend Engineer role at Globex.\n> Application ID: OLD-12345\n> Submitted email: other@example.com";
  const signal = await extract(current + history.repeat(10));
  assert.equal(signal.fields.company, "Acme");
  assert.equal(signal.fields.title, "Backend Engineer");
  assert.equal(signal.fields.externalApplicationId, null);
  assert.equal(signal.fields.applicantEmail, null);
});

it("HTML blockquotes are isolated while authored text after a quote remains available", async () => {
  const signal = await extract("", "<blockquote><p>We received your application for the Frontend Engineer role at Globex.</p></blockquote><p>We received your application for the Backend Engineer role at Acme.</p>");
  assert.equal(signal.fields.company, "Acme");
  assert.equal(signal.fields.title, "Backend Engineer");
});

it("a reply's old subject and quoted receipt cannot create a new confirmation", async () => {
  const signal = await extract("Thanks!\n\n> We received your application for the Backend Engineer role at Acme.", undefined, "Re: Application received: Backend Engineer at Acme");
  assert.equal(signal.kind, null);
  assert.ok(signal.reasons.includes("quoted-history-only"));
});

it("generic footer adjacency does not assert a job title", async () => {
  const signal = await extract("We received your application.\nCompany: Acme\nAcme\nPrivacy Policy");
  assert.equal(signal.fields.title, null);
});

it("signatures remain employer evidence, not event assertions", () => {
  assert.deepEqual(messageRegions("Hello\n\nBest,\nAcme Recruiting\nInterview invitation"), {
    current: "Hello\n", signature: "Best,\nAcme Recruiting\nInterview invitation", hasQuotedHistory: false,
  });
});

it("an early courtesy line preserves receipt assertions and submission identifiers", async () => {
  const signal = await extract("Hi Robin,\n\nThanks!\n\nWe received your application for the Backend Engineer role at Acme.\nApplication ID: APP-99112\nApplicant email: robin@example.com", undefined, "Next steps");
  assert.equal(signal.kind, "CONFIRMATION_RECEIVED");
  assert.equal(signal.fields.title, "Backend Engineer");
  assert.equal(signal.fields.externalApplicationId, "APP-99112");
  assert.equal(signal.fields.applicantEmail, "robin@example.com");
});

it("metadata following a sign-off stays available without using signature prose as assertions", async () => {
  const signal = await extract("We received your application.\nBest,\nAcme Recruiting\n\nJob Title: Backend Engineer\nApplication ID: APP-12345\nhttps://boards.greenhouse.io/acme/jobs/4455001");
  assert.equal(signal.fields.title, "Backend Engineer");
  assert.equal(signal.fields.externalApplicationId, "APP-12345");
  assert.equal(signal.fields.atsKey?.requisitionId, "4455001");
});

it("wrapped prefix-quoted history does not hide a bottom-posted reply", async () => {
  const signal = await extract("On Monday, October 12, Robin Recruiter\n wrote:\n> We received your application for Wrong Engineer at Globex.\n\nWe received your application for the Backend Engineer role at Acme.", undefined, "Re: Next steps");
  assert.equal(signal.kind, "CONFIRMATION_RECEIVED");
  assert.equal(signal.fields.title, "Backend Engineer");
});

it("HTML quote containers and two-cell metadata retain their structure", async () => {
  const signal = await extract("", '<div class="gmail_quote"><p>We received your application for Wrong Engineer at Globex.</p></div><p>We received your application.</p><table><tr><th>Company</th><td><b>Acme</b></td></tr><tr><th>Job Title</th><td>Backend Engineer</td></tr><tr><td>Application ID</td><td>APP-12345</td></tr></table>');
  assert.equal(signal.fields.company, "Acme");
  assert.equal(signal.fields.title, "Backend Engineer");
  assert.equal(signal.fields.externalApplicationId, "APP-12345");
});

it("conditional cancellation policies cannot veto an explicitly scheduled interview", async () => {
  const signal = await extract("Your onsite interview for the Backend Engineer role at Acme is confirmed for Monday.\nIf your interview is cancelled, please let us know 24 hours in advance.", undefined, "Interview confirmation");
  assert.equal(signal.kind, "INTERVIEW_SCHEDULED");
  assert.ok(!signal.reasons.includes("interview-cancelled"));
});

it("an interview subject cannot lend its noun to an unrelated cancelled session", async () => {
  const signal = await extract("Your previous session was cancelled. We would like to invite you to interview for the Backend Engineer role at Acme.", undefined, "Interview invitation");
  assert.equal(signal.kind, "INTERVIEW_INVITED");
});

it("a conditional sentence still asserts its main clause", async () => {
  for (const [text, kind] of [
    ["When you have a moment, please complete the coding assessment for the Data Engineer role.", "ASSESSMENT_INVITED"],
    ["When you're ready, we'd like to invite you to interview with our team.", "INTERVIEW_INVITED"],
    ["If you are still interested, we would like to schedule an interview.", "INTERVIEW_INVITED"],
    ["If you are still interested we would like to schedule an interview.", "INTERVIEW_INVITED"],
    ["Should you accept, we are delighted to extend an offer for the Data Engineer role.", "OFFER_RECEIVED"],
  ] as const)
    assert.equal((await extract(text, undefined, "Next steps")).kind, kind, text);
});

it("the condition itself never asserts an event", async () => {
  for (const text of [
    "If we decide not to move forward, we will let you know.",
    "If we decide not to move forward we will let you know.",
    "If your interview is cancelled please let us know 24 hours in advance.",
  ])
    assert.equal((await extract(text, undefined, "Next steps")).kind, null, text);
});

it("deeply nested or unclosed HTML is read, not rejected as malformed", async () => {
  const body = "<p>Thank you for applying for the Data Engineer position at Acme. We have received your application.</p>";
  for (const html of [
    "<table>" + "<tr><td>row</td>".repeat(25) + "</table>" + body,
    "<div>".repeat(45) + body,
    "<table><tr><td>".repeat(22) + body + "</td></tr></table>".repeat(22),
  ]) {
    const signal = await extract("View this email in a browser.", html);
    assert.equal(signal.kind, "CONFIRMATION_RECEIVED");
    assert.equal(signal.fields.company, "Acme");
  }
});

it("label rows are read when </tr> is omitted", async () => {
  const signal = await extract("View this email in a browser.",
    "<p>We have received your application.</p><table><tr><td>Company:</td><td>Acme</td><tr><td>Job Title</td><td>Data Engineer</td></table>");
  assert.equal(signal.fields.company, "Acme");
  assert.equal(signal.fields.title, "Data Engineer");
});

it("a Gmail quote past the container limit is still quoted history", async () => {
  const signal = await extract("View this email in a browser.",
    "<div>".repeat(45) + "<p>We have received your application for the Data Engineer role at Acme.</p>" +
    '<div class="gmail_quote"><p>We are delighted to offer you the Wrong Engineer role at Wrong Company.</p></div>');
  assert.equal(signal.kind, "CONFIRMATION_RECEIVED");
  assert.equal(signal.fields.company, "Acme");
});
