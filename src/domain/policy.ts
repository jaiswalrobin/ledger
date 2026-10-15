/**
 * Ledger's decision policy: every rule that decides whether an email may change an application on
 * its own, or must go to a person. The module is pure. Callers gather facts (from the extractor,
 * the sender's authentication, the database) and these functions decide, so each rule can be read
 * and tested in one place.
 *
 * Stages, in the order the pipeline asks them:
 *   1. screenSensitive: may anything about the message be kept at all?
 *   2. gateSignal: is the extracted signal itself clear enough to match?
 *   3. calendarIdentityHolds / judgeCalendarRevision: may a calendar invitation link or revise?
 *   4. mayApplyAutomatically: is the match strong enough for this kind of event?
 */
import type { ApplicationEventKind, CalendarFacts, Sensitivity } from "./types.ts";

export type ReviewReason =
  | "NO_DATE"
  | "MISSING_JOB_DETAILS"
  | "AMBIGUOUS_OPENING"
  | "NO_KNOWN_SUBMISSION"
  | "AMBIGUOUS_ATTEMPT"
  | "POSSIBLE_RESENT_CONFIRMATION"
  | "TERMINAL_NEEDS_REVIEW"
  | "UNRECOGNIZED"
  | "AMBIGUOUS_APPLICATION_ID"
  | "EVENT_PRECEDES_SUBMISSION"
  | "CONFLICTING_EVENTS"
  | "CONFLICTING_ALTERNATIVES"
  | "INTERVIEW_CANCELLED"
  | "NOT_SUBMITTED"
  | "CONFLICTING_FIELDS"
  | "UNCERTAIN_CALENDAR"
  | "CALENDAR_REVISION";

// 1. Sensitivity -----------------------------------------------------------------------------

/**
 * A credential delivery is never kept. A message whose only secret is an access link (an
 * assessment or portal link) is kept only when it is hiring mail; the link itself is never stored.
 */
export const screenSensitive = (facts: {
  headerSensitive: boolean;
  level: Sensitivity;
  hiringSignal: boolean;
}): boolean =>
  facts.headerSensitive ||
  facts.level === "CREDENTIAL" ||
  (facts.level === "ACCESS_LINK" && !facts.hiringSignal);

// 2. Signal gate -----------------------------------------------------------------------------

/**
 * Extractor reasons that always send an email to a person, highest precedence first. Each means
 * the extractor saw contradictory or unusable evidence, so no match is attempted.
 */
export const GATED_REASONS: ReadonlyMap<string, ReviewReason> = new Map<string, ReviewReason>([
  ["conflicting-alternatives", "CONFLICTING_ALTERNATIVES"],
  ["conflicting-fields", "CONFLICTING_FIELDS"],
  ["ambiguous-kind", "UNRECOGNIZED"],
  ["ambiguous-job-links", "AMBIGUOUS_OPENING"],
  ["interview-cancelled", "INTERVIEW_CANCELLED"],
  ["uncertain-calendar", "UNCERTAIN_CALENDAR"],
  // Receipt wording next to "not submitted"/"not received": contradictory, so never dismissed.
  ["not-submitted", "NOT_SUBMITTED"],
  ["quoted-history-only", "UNRECOGNIZED"],
]);

/** Marketing digests from job boards: never evidence of an application. */
const JOB_ALERT =
  /\b(?:job alerts?|jobs? (?:for you|you may (?:like|be interested in))|recommended jobs?|new jobs?|similar jobs?|is hiring|are hiring|top jobs?|jobs? digest|weekly digest)\b/i;

export interface GateInput<Kind extends string> {
  kind: Kind | null;
  occurredAt: string | null;
  reasons: readonly string[];
  fields: { fieldDecisions?: Record<string, { state: string }> };
}

export interface GateFacts {
  /** Found by mailbox sync, rather than deliberately forwarded or uploaded by the user. */
  synced: boolean;
  /** The sender's domain belongs to a hiring platform. */
  recruitingSender: boolean;
  subject: string;
}

export type Gate<Kind extends string> =
  | { action: "REVIEW"; reason: ReviewReason }
  | { action: "DISMISS" }
  | { action: "PROCEED"; kind: Kind; occurredAt: string };

export function gateSignal<Kind extends string>(signal: GateInput<Kind>, facts: GateFacts): Gate<Kind> {
  for (const [code, reason] of GATED_REASONS)
    if (signal.reasons.includes(code)) return { action: "REVIEW", reason };
  if (!signal.kind) {
    // A synced message is dismissed only when nothing suggests it is hiring mail. Anything
    // unrecognised from a hiring platform goes to a person instead of disappearing. A file the
    // user forwarded on purpose is never silently dropped.
    const worthReview = facts.recruitingSender && !JOB_ALERT.test(facts.subject);
    return facts.synced && !worthReview ? { action: "DISMISS" } : { action: "REVIEW", reason: "UNRECOGNIZED" };
  }
  if (!signal.occurredAt) return { action: "REVIEW", reason: "NO_DATE" };
  const decisions = Object.values(signal.fields.fieldDecisions ?? {});
  if (decisions.some((decision) => decision.state === "AMBIGUOUS"))
    return { action: "REVIEW", reason: "CONFLICTING_FIELDS" };
  return { action: "PROCEED", kind: signal.kind, occurredAt: signal.occurredAt };
}

// 3. Calendar invitations --------------------------------------------------------------------

/**
 * An accepted invitation's UID may link a later revision to the same attempt only when the
 * sender is authenticated and both revisions name the same organizer domain. A UID is easy to
 * copy; the organizer is what makes it the same meeting.
 */
export const calendarIdentityHolds = (
  incoming: Pick<CalendarFacts, "organizerDomain">,
  accepted: Pick<CalendarFacts, "organizerDomain"> | null,
  senderVerified: boolean,
): boolean =>
  senderVerified &&
  !!incoming.organizerDomain &&
  !!accepted?.organizerDomain &&
  incoming.organizerDomain === accepted.organizerDomain;

const CALENDAR_IDENTITY = ["uidKey", "sequence", "method", "status", "scheduledFor", "organizerDomain"] as const;

/** Two observations of one invitation revision: every safe calendar fact agrees. */
export const sameCalendarRevision = (a: CalendarFacts, b: CalendarFacts): boolean =>
  CALENDAR_IDENTITY.every((key) => a[key] === b[key]);

export interface AcceptedRevision {
  attemptId: string;
  calendar: CalendarFacts;
  /** The domain that sent the accepted revision, when recorded. */
  senderDomain: string | null;
}

export type RevisionVerdict =
  /** A higher SEQUENCE for the same attempt: record it as the new schedule. */
  | "NEW"
  /** The accepted revision again: attach the evidence, change nothing. */
  | "REPEAT"
  /** Sent by a different organizer or domain than the accepted revision. */
  | "OTHER_SENDER"
  /** Belongs to another attempt, or is older than the accepted revision. */
  | "OUT_OF_ORDER"
  /** Same SEQUENCE but different facts: an edit that did not bump the sequence. */
  | "CHANGED_WITHOUT_SEQUENCE";

/** How an invitation relates to the accepted revision with the same UID (null: there is none). */
export function judgeCalendarRevision(
  incoming: CalendarFacts,
  accepted: AcceptedRevision | null,
  attemptId: string,
  senderDomain: string,
): RevisionVerdict {
  if (!accepted) return "NEW";
  if (
    incoming.organizerDomain !== accepted.calendar.organizerDomain ||
    (accepted.senderDomain && accepted.senderDomain !== senderDomain)
  )
    return "OTHER_SENDER";
  if (accepted.attemptId !== attemptId || incoming.sequence < accepted.calendar.sequence) return "OUT_OF_ORDER";
  if (incoming.sequence === accepted.calendar.sequence)
    return sameCalendarRevision(incoming, accepted.calendar) ? "REPEAT" : "CHANGED_WITHOUT_SEQUENCE";
  return "NEW";
}

// 4. Authority to apply ----------------------------------------------------------------------

/** Rejections and offers: the events a person would most regret seeing applied wrongly. */
export const TERMINAL_KINDS: ReadonlySet<ApplicationEventKind> = new Set<ApplicationEventKind>([
  "REJECTION_RECEIVED",
  "OFFER_RECEIVED",
]);

/** How an update was tied to one application attempt. */
export type MatchBasis =
  /** The email repeats the attempt's application ID. */
  | "APPLICATION_ID"
  /** The email names the address the attempt was submitted with, and no other attempt has it. */
  | "SUBMITTED_EMAIL"
  /** The opening has exactly one attempt and the email does not contradict it. */
  | "SOLE_ATTEMPT"
  /** The email replies to, or shares a thread with, accepted mail from the same sender domain. */
  | "CONVERSATION"
  /** The invitation's UID belongs to an accepted invitation for the attempt. */
  | "CALENDAR_IDENTITY";

export interface AuthorityFacts {
  /** Null when the match came from a rule this policy does not know: never strong. */
  basis: MatchBasis | null;
  /** The opening was matched by a stable identity (ATS requisition, URL, application ID, ...). */
  strongOpening: boolean;
  /** One of the attempt's confirmations reached the mailbox this email arrived in. */
  confirmedInSameMailbox: boolean;
  /** The sender is an authenticated hiring platform. */
  trustedSender: boolean;
  /** The sender is authenticated and its domain belongs to the opening's employer. */
  verifiedEmployer: boolean;
  confidence: "HIGH" | "LOW";
}

/** Whether the event's kind requires AuthorityFacts at all; others apply once matched. */
export const needsAuthority = (kind: ApplicationEventKind): boolean => TERMINAL_KINDS.has(kind);

/**
 * Rejections and offers apply without a person only when three things hold:
 * - the attempt is identified strongly: an exact application ID; a unique submitted email on a
 *   strongly matched opening; or the sole attempt, or a verified conversation, whose
 *   confirmation reached the same mailbox;
 * - the sender is an authenticated hiring platform or the employer's own verified domain;
 * - the extractor is confident.
 * An invitation's UID alone never authorizes one.
 */
export function mayApplyAutomatically(kind: ApplicationEventKind, facts: AuthorityFacts): boolean {
  if (!needsAuthority(kind)) return true;
  const strongAttempt =
    facts.basis === "APPLICATION_ID" ||
    (facts.basis === "SUBMITTED_EMAIL" && facts.strongOpening) ||
    ((facts.basis === "SOLE_ATTEMPT" || facts.basis === "CONVERSATION") && facts.confirmedInSameMailbox);
  return strongAttempt && (facts.trustedSender || facts.verifiedEmployer) && facts.confidence === "HIGH";
}
