import { projectAttempt, resolveOpening, resolveSubmission, resolveUpdate } from "../src/index.ts";
import type { ApplicationAttempt, ApplicationEvent, JobOpening, OpeningSignal } from "../src/index.ts";

const opening: JobOpening = {
  id: "opening-1", company: "Example Corp", title: "Senior Frontend Engineer",
  location: "Remote", atsKey: { provider: "ashby", tenant: "example", requisitionId: "FE-7" },
  canonicalUrl: null,
};
const incoming: OpeningSignal = {
  company: "Example Corp", title: "Senior FE Engineer", location: "Remote",
  atsKey: { provider: "ashby", tenant: "example", requisitionId: "FE-7" }, canonicalUrl: null,
};
const attempts: ApplicationAttempt[] = [{
  id: "attempt-a", openingId: opening.id, applicantEmail: "first@example.com",
  phoneLookupKey: "hmac-a", externalApplicationId: "ats-1", submissionEvidenceIds: ["source-a"],
}, {
  id: "attempt-b", openingId: opening.id, applicantEmail: "second@example.com",
  phoneLookupKey: "hmac-a", externalApplicationId: "ats-2", submissionEvidenceIds: ["source-b"],
}];
const events: ApplicationEvent[] = [
  { id: "e1", attemptId: "attempt-a", kind: "REJECTION_RECEIVED", occurredAt: "2026-10-05T10:00:00Z", observedAt: "2026-10-05T10:01:00Z", reviewState: "ACCEPTED", evidenceId: "source-r1" },
  { id: "e2", attemptId: "attempt-b", kind: "INTERVIEW_INVITED", occurredAt: "2026-10-12T10:00:00Z", observedAt: "2026-10-12T10:01:00Z", reviewState: "ACCEPTED", evidenceId: "source-i2" },
];
const result = {
  opening: resolveOpening(incoming, [opening]),
  replayedSubmission: resolveSubmission(opening.id, { evidenceId: "source-a", applicantEmail: "first@example.com", phoneLookupKey: "hmac-a", externalApplicationId: "ats-1" }, attempts),
  interviewMatch: resolveUpdate(opening.id, { applicantEmail: "second@example.com", phoneLookupKey: "hmac-a", externalApplicationId: null }, attempts),
  attempts: attempts.map(a => ({ id: a.id, ...projectAttempt(a.id, events) })),
};
console.log(JSON.stringify(result, null, 2));
