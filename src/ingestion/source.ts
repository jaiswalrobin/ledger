import type { ApplicationEventKind, AtsKey } from "../domain/types.ts";

/**
 * Transient, in-memory view of one ORIGINAL message (never an envelope). It is produced
 * by the .eml parser for both uploaded files and Gmail `format=raw` downloads, so both
 * ingestion paths converge here. It must not be persisted or logged.
 */
export interface ParsedMessage {
  messageId: string | null;
  /** Transient RFC identifiers. Only hashes are persisted; ambiguous/oversized chains are ignored. */
  replyMessageIds?: readonly string[];
  threadContextUncertain?: boolean;
  fromName: string;
  fromAddress: string | null;
  /** Original To recipients only. Cc/Bcc and forwarding recipients are deliberately excluded. */
  to: string[];
  subject: string;
  /** ISO instant from the original Date header; null when absent or unparsable. */
  date: string | null;
  text: string;
  /** Other decoded MIME alternatives, transient and never persisted. */
  alternativeTexts?: readonly string[];
  /** Raw HTML for conservative secret screening, never extraction or persistence. */
  inspectionHtml?: string;
  /** Scheduling parts remain transient and pass the same secret screen as message text. */
  calendarParts?: readonly { content: string; method: string | null }[];
}

export interface ParsedOriginal {
  message: ParsedMessage;
  /** sha256 of the original message bytes. Identical whether sent directly or forwarded. */
  fingerprint: string;
  /** Date of the forwarding envelope, kept apart from the original's own date. */
  envelopeDate: string | null;
  /** Attachment provenance is independent of whether the forwarding envelope has a Date. */
  isAttached?: boolean;
  /** Safe parse error codes for omitted sibling attachments, on the first result only. */
  omittedOriginals?: readonly string[];
}

export type SignalKind = Extract<
  ApplicationEventKind,
  | "CONFIRMATION_RECEIVED"
  | "ASSESSMENT_INVITED"
  | "INTERVIEW_INVITED"
  | "INTERVIEW_SCHEDULED"
  | "REJECTION_RECEIVED"
  | "OFFER_RECEIVED"
>;

export const TERMINAL_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  "REJECTION_RECEIVED",
  "OFFER_RECEIVED",
]);

export interface FieldDecision {
  state: "SUPPORTED" | "AMBIGUOUS" | "MISSING";
  value: string | null;
  candidates: readonly { value: string; score: number; sources: readonly string[] }[];
}

export interface CalendarFacts {
  /** Opaque UID hash; raw calendar identifiers and participant addresses are never retained. */
  uidKey: string;
  sequence: number;
  method: string;
  status: string;
  scheduledFor: string | null;
  organizerDomain: string | null;
}

/** Structured, redacted facts lifted from a message. Safe to persist. */
export interface ExtractedFields {
  company: string | null;
  title: string | null;
  fieldDecisions?: { company: FieldDecision; title: FieldDecision };
  calendar?: CalendarFacts;
  location: string | null;
  atsKey: AtsKey | null;
  /** Query-free job URL on a known ATS host, or a clean job-path URL. Never a signed link. */
  canonicalUrl: string | null;
  applicantEmail: string | null;
  externalApplicationId: string | null;
}

export interface ExtractedSignal {
  kind: SignalKind | null;
  confidence: "HIGH" | "LOW";
  fields: ExtractedFields;
  occurredAt: string | null;
  /** Safe rule identifiers for explanation and debugging. Never message content. */
  reasons: string[];
}
