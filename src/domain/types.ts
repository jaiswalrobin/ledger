/** Stable, owner-scoped domain identifiers. IDs are created by the persistence layer. */
export type Id = string;

export interface AtsKey {
  provider: string;
  tenant: string;
  requisitionId: string;
}

export interface JobOpening {
  id: Id;
  company: string;
  title: string;
  location: string | null;
  atsKey: AtsKey | null;
  /** Caller supplied, validated canonical URL; never put signed application links here. */
  canonicalUrl: string | null;
}

export interface ApplicationAttempt {
  id: Id;
  openingId: Id;
  /** Snapshot of submitted email, not necessarily a connected mailbox. */
  applicantEmail: string | null;
  /** Opaque, keyed HMAC produced at a protected boundary; NEVER plain SHA(phone). */
  phoneLookupKey: string | null;
  externalApplicationId: string | null;
  /** Stable source artifact fingerprints proving an actual submission. */
  submissionEvidenceIds: readonly string[];
}

export interface SubmissionSignal {
  evidenceId: string;
  applicantEmail: string | null;
  phoneLookupKey: string | null;
  externalApplicationId: string | null;
}

export interface OpeningSignal {
  company: string;
  title: string;
  location: string | null;
  atsKey: AtsKey | null;
  canonicalUrl: string | null;
}

export type Resolution =
  | { kind: "MATCH"; id: Id; reason: string }
  | { kind: "CREATE"; reason: string }
  | { kind: "REVIEW"; candidateIds: readonly Id[]; reason: string };

export type Stage = "UNKNOWN" | "APPLIED" | "ASSESSMENT" | "INTERVIEW";
export type Outcome = "PENDING" | "REJECTED" | "OFFERED" | "WITHDRAWN";

export type ApplicationEventKind =
  | "SUBMITTED"
  | "CONFIRMATION_RECEIVED"
  | "ASSESSMENT_INVITED"
  | "INTERVIEW_INVITED"
  | "INTERVIEW_SCHEDULED"
  | "REJECTION_RECEIVED"
  | "OFFER_RECEIVED"
  | "WITHDRAWN"
  | "MANUAL_CORRECTION";

export interface ApplicationEvent {
  id: Id;
  attemptId: Id;
  kind: ApplicationEventKind;
  /** ISO-8601 instant from the actual source, not forward/processing time. */
  occurredAt: string;
  observedAt: string;
  /** Proposed events cannot affect the projected application state. */
  reviewState: "PROPOSED" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";
  evidenceId: string | null;
  correction?: { stage: Stage; outcome: Outcome };
}

export interface AttemptProjection {
  stage: Stage;
  outcome: Outcome;
  lastActivityAt: string | null;
  conflicts: readonly string[];
}

export interface MessageHeaders {
  from: string;
  subject: string;
}

export type GateDecision =
  | { kind: "CANDIDATE"; reason: string }
  | { kind: "SKIP_SENSITIVE"; reason: string }
  | { kind: "SKIP_UNRELATED"; reason: string }
  | { kind: "REVIEW_HEADERS"; reason: string };
