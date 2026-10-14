import assert from "node:assert/strict";
import test from "node:test";
import { classifyHeaders, projectAttempt, resolveOpening, resolveSubmission, resolveUpdate } from "../src/index.ts";
import type { ApplicationAttempt, ApplicationEvent, JobOpening, OpeningSignal, SubmissionSignal } from "../src/index.ts";

const job: JobOpening = {
  id: "job-a", company: "Example Corp", title: "Senior Frontend Engineer",
  location: "Remote", atsKey: { provider: "ashby", tenant: "example", requisitionId: "FE-7" },
  canonicalUrl: "https://jobs.example.com/opening?id=FE-7",
};
const other: JobOpening = { ...job, id: "job-b", atsKey: { provider: "ashby", tenant: "example", requisitionId: "FE-8" }, canonicalUrl: "https://jobs.example.com/opening?id=FE-8" };
const signal: OpeningSignal = { company: job.company, title: job.title, location: job.location, atsKey: job.atsKey, canonicalUrl: null };
const attempt = (id: string, email: string | null, appId: string | null = null, phone: string | null = null, evidence: string[] = []): ApplicationAttempt => ({
  id, openingId: job.id, applicantEmail: email, externalApplicationId: appId,
  phoneLookupKey: phone, submissionEvidenceIds: evidence,
});
const submission = (evidenceId: string, email: string | null, appId: string | null = null, phone: string | null = null): SubmissionSignal => ({
  evidenceId, applicantEmail: email, externalApplicationId: appId, phoneLookupKey: phone,
});
const event = (id: string, kind: ApplicationEvent["kind"], at: string, attemptId = "a", reviewState: ApplicationEvent["reviewState"] = "ACCEPTED"): ApplicationEvent => ({
  id, kind, attemptId, occurredAt: at, observedAt: at, reviewState, evidenceId: id,
});

test("scoped ATS requisition overrides title variation", () => {
  assert.deepEqual(resolveOpening({ ...signal, title: "Software Engineer II" }, [job, other]), { kind: "MATCH", id: job.id, reason: "Matching scoped ATS requisition" });
});
test("different scoped requisition creates a distinct job opening", () => {
  assert.equal(resolveOpening({ ...signal, atsKey: other.atsKey }, [job]).kind, "CREATE");
});
test("same employer and role is never enough to automatically merge", () => {
  const result = resolveOpening({ ...signal, atsKey: null, canonicalUrl: null }, [job]);
  assert.equal(result.kind, "REVIEW");
});
test("canonical URLs preserve job-ID query parameters", () => {
  const result = resolveOpening({ ...signal, atsKey: null, canonicalUrl: "https://jobs.example.com/opening?id=FE-8" }, [job, other]);
  assert.deepEqual(result, { kind: "MATCH", id: other.id, reason: "Matching canonical job URL" });
});
test("ambiguous duplicate ATS requisitions go to review", () => {
  const result = resolveOpening(signal, [job, { ...job, id: "duplicate" }]);
  assert.equal(result.kind, "REVIEW");
});
test("replayed confirmation references existing attempt", () => {
  const result = resolveSubmission(job.id, submission("source-a", "A@example.com"), [attempt("a", "a@example.com", null, null, ["source-a"])]);
  assert.equal(result.kind, "MATCH");
});
test("same ATS application ID never creates a second attempt", () => {
  const result = resolveSubmission(job.id, submission("fresh-mail", "other@example.com", "app-1"), [attempt("a", "a@example.com", "app-1")]);
  assert.equal(result.kind, "MATCH");
});
test("different explicit ATS application IDs can represent different submissions", () => {
  const result = resolveSubmission(job.id, submission("new-submission", "a@example.com", "app-2"), [attempt("a", "a@example.com", "app-1")]);
  assert.equal(result.kind, "CREATE");
});
test("same email and no external ID is review rather than automatic duplicate or new attempt", () => {
  const result = resolveSubmission(job.id, submission("different-confirmation", "a@example.com"), [attempt("a", "A@example.com")]);
  assert.equal(result.kind, "REVIEW");
});
test("different email with same phone does not merge attempts", () => {
  const result = resolveSubmission(job.id, submission("new-confirmation", "b@example.com", null, "shared-phone-hmac"), [attempt("a", "a@example.com", null, "shared-phone-hmac")]);
  assert.equal(result.kind, "CREATE");
});
test("unknown applicant email with matching phone goes to review", () => {
  const result = resolveSubmission(job.id, submission("maybe", null, null, "same-hmac"), [attempt("a", "a@example.com", null, "same-hmac")]);
  assert.equal(result.kind, "REVIEW");
});
test("missing stable submission evidence cannot create application", () => {
  assert.equal(resolveSubmission(job.id, submission("", "b@example.com"), []).kind, "REVIEW");
});
test("status updates identify the correct attempt by email", () => {
  const result = resolveUpdate(job.id, { applicantEmail: "SECOND@example.com", phoneLookupKey: null, externalApplicationId: null }, [attempt("a", "first@example.com"), attempt("b", "second@example.com")]);
  assert.deepEqual(result, { kind: "MATCH", id: "b", reason: "Unique matching submitted email" });
});
test("same email on multiple attempts cannot confidently match rejection", () => {
  const result = resolveUpdate(job.id, { applicantEmail: "first@example.com", phoneLookupKey: null, externalApplicationId: null }, [attempt("a", "first@example.com"), attempt("b", "first@example.com")]);
  assert.equal(result.kind, "REVIEW");
});
test("unknown application ID cannot fall back to guessed email match", () => {
  const result = resolveUpdate(job.id, { applicantEmail: "a@example.com", phoneLookupKey: null, externalApplicationId: "unknown-id" }, [attempt("a", "a@example.com", "known-id")]);
  assert.equal(result.kind, "REVIEW");
});
test("phone mismatch on otherwise matching email is not auto-accepted", () => {
  const result = resolveUpdate(job.id, { applicantEmail: "a@example.com", phoneLookupKey: "hmac-b", externalApplicationId: null }, [attempt("a", "a@example.com", null, "hmac-a")]);
  assert.equal(result.kind, "REVIEW");
});
test("no attempt identity means unresolved even with one known attempt", () => {
  const result = resolveUpdate(job.id, { applicantEmail: null, phoneLookupKey: null, externalApplicationId: null }, [attempt("a", "a@example.com")]);
  assert.equal(result.kind, "REVIEW");
});
test("attempt state remains independent across two submissions", () => {
  const events = [
    event("e1", "SUBMITTED", "2026-10-01T12:00:00Z", "a"),
    event("e2", "REJECTION_RECEIVED", "2026-10-07T12:00:00Z", "a"),
    event("e3", "SUBMITTED", "2026-10-03T12:00:00Z", "b"),
    event("e4", "INTERVIEW_INVITED", "2026-10-09T12:00:00Z", "b"),
  ];
  assert.deepEqual([projectAttempt("a", events).outcome, projectAttempt("b", events).stage], ["REJECTED", "INTERVIEW"]);
});
test("out-of-order messages do not rewind stage", () => {
  const events = [event("late", "ASSESSMENT_INVITED", "2026-10-02T00:00:00Z"), event("early", "INTERVIEW_INVITED", "2026-10-05T00:00:00Z")];
  assert.equal(projectAttempt("a", events).stage, "INTERVIEW");
});
test("a proposed rejection never changes state", () => {
  const events = [event("apply", "SUBMITTED", "2026-10-01T00:00:00Z"), event("r", "REJECTION_RECEIVED", "2026-10-02T00:00:00Z", "a", "PROPOSED")];
  assert.equal(projectAttempt("a", events).outcome, "PENDING");
});
test("conflicting terminal events do not silently override first accepted outcome", () => {
  const events = [event("r", "REJECTION_RECEIVED", "2026-10-01T00:00:00Z"), event("offer", "OFFER_RECEIVED", "2026-10-03T00:00:00Z")];
  const result = projectAttempt("a", events);
  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.conflicts.length, 1);
});
test("manual correction can restore correct state without deleting prior history", () => {
  const correction: ApplicationEvent = { ...event("manual", "MANUAL_CORRECTION", "2026-10-04T00:00:00Z"), correction: { stage: "INTERVIEW", outcome: "PENDING" } };
  const result = projectAttempt("a", [event("r", "REJECTION_RECEIVED", "2026-10-01T00:00:00Z"), correction]);
  assert.deepEqual({ stage: result.stage, outcome: result.outcome }, { stage: "INTERVIEW", outcome: "PENDING" });
});
test("OTP from ATS is skipped even if subject says application", () => {
  const result = classifyHeaders({ from: "no-reply@jobs.example.com", subject: "Your application verification code (OTP)" });
  assert.equal(result.kind, "SKIP_SENSITIVE");
});
test("recruiter interview message is candidate for targeted extraction", () => {
  assert.equal(classifyHeaders({ from: "recruiter@example.com", subject: "Interview invitation for Frontend role" }).kind, "CANDIDATE");
});
test("unrelated banking messages do not cause body reads", () => {
  assert.equal(classifyHeaders({ from: "bank@example.com", subject: "Monthly statement" }).kind, "SKIP_UNRELATED");
});
test("ATS sender alone cannot justify body retrieval", () => {
  assert.equal(classifyHeaders({ from: "noreply@greenhouse.io", subject: "Your account" }).kind, "REVIEW_HEADERS");
});
test("'Thank you for applying' confirmations are candidates, including from ATS senders", () => {
  assert.equal(classifyHeaders({ from: '"Acme" <no-reply@us.greenhouse-mail.io>', subject: "Thank you for applying to Acme" }).kind, "CANDIDATE");
  assert.equal(classifyHeaders({ from: '"Northwind" <no-reply@hire.lever.co>', subject: "Thanks for applying to Northwind Labs" }).kind, "CANDIDATE");
});
test("a verification code is still skipped when the subject also says applying", () => {
  assert.equal(classifyHeaders({ from: "no-reply@greenhouse.io", subject: "Your code for applying: 482913 (verification code)" }).kind, "SKIP_SENSITIVE");
});

test("companyKey merges legal-form and case variants but never a prefix", async () => {
  const { companyKey } = await import("../src/domain/normalization.ts");
  for (const variant of ["ACME", "Acme, Inc.", "The Acme Co.", "Acme Inc", "acme  llc", "Acme Holdings Ltd"])
    assert.equal(companyKey(variant), "acme", variant);
  assert.equal(companyKey("Johnson & Johnson"), companyKey("Johnson and Johnson"));
  assert.equal(companyKey("McDonald's"), "mcdonalds");
  assert.notEqual(companyKey("Acme"), companyKey("Acme Robotics"));
  assert.equal(companyKey("Company"), "company");
  assert.equal(companyKey("Inc."), "inc");
});
