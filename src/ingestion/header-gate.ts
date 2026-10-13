import type { GateDecision, MessageHeaders } from "../domain/types.ts";
import { isRecruitingSenderDomain, senderDomain } from "./ats.ts";

const SENSITIVE_SUBJECT =
  /\b(otp|one[\s-]?time|verification code|security code|passcode|password reset|reset your password|two[\s-]?factor|2fa|sign[\s-]?in code|login code|magic link|confirm your (?:email|identity)|verify your (?:email|identity))\b/i;

/**
 * Recruitment vocabulary in a subject. Word forms are explicit (plurals, -ing/-ed) because a bare
 * `\binterview\b` silently misses "Interviews" or "Interviewing with Acme".
 */
const RECRUITMENT_SUBJECT = new RegExp(
  String.raw`\b(?:` +
    [
      String.raw`applications?`,
      String.raw`appl(?:y|ying|ied)`,
      String.raw`applicants?`,
      String.raw`candidac(?:y|ies)`,
      String.raw`candidates?`,
      String.raw`candidature`,
      String.raw`interview(?:s|ing|ed|er|ers)?`,
      String.raw`assessments?`,
      String.raw`(?:coding|technical|skills?|online) (?:challenge|test|exercise|assignment)s?`,
      String.raw`take[\s-]?home`,
      String.raw`phone screen(?:ing)?`,
      String.raw`(?:recruiter|hiring manager|technical|intro(?:ductory)?|screening) call`,
      String.raw`on[\s-]?site`,
      String.raw`recruit(?:ment|ing|er|ers)`,
      String.raw`hiring(?: process| team| update)?`,
      String.raw`talent acquisition`,
      String.raw`(?:job|employment|offer) (?:offer|letter)`,
      String.raw`offer of employment`,
      String.raw`(?:your|an|our) offer`,
      String.raw`positions?`,
      String.raw`roles?`,
      String.raw`vacanc(?:y|ies)`,
      String.raw`requisition`,
      String.raw`opportunit(?:y|ies)`,
      String.raw`next steps?`,
      String.raw`unfortunately`,
      String.raw`thank(?:s| you) for your interest`,
      String.raw`careers?`,
      String.raw`job`,
      String.raw`submission`,
    ].join("|") +
    String.raw`)\b`,
  "i",
);

/** Account administration from an ATS: never recruiting evidence on its own. */
const ACCOUNT_SUBJECT =
  /\b(?:account|password|sign[\s-]?in|log[\s-]?in|login|profile|welcome to|activate|email address|security|subscription|unsubscribe|newsletter|job alerts?|privacy)\b/i;

/**
 * Minimal pre-body privacy gate. It NEVER inspects or stores message bodies.
 * Unknown messages are not fetched on headers alone; the sync worker may still ask Gmail's own
 * search whether the message contains a recruitment phrase before deciding (see sync.ts).
 *
 * Not a security guarantee: an innocuous-looking subject can still hide an OTP.
 */
export function classifyHeaders(headers: MessageHeaders): GateDecision {
  if (headers.from.length > 1000 || headers.subject.length > 1000)
    return {
      kind: "REVIEW_HEADERS",
      reason: "Metadata exceeds inspection limits",
    };
  const from = headers.from.toLowerCase().trim();
  // Unicode spaces and punctuation are common in ATS subjects ("Interview invitation").
  const subject = headers.subject
    .normalize("NFKC")
    .replace(/[­​-‏⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
  if (!from) return { kind: "REVIEW_HEADERS", reason: "Missing metadata" };

  if (SENSITIVE_SUBJECT.test(subject))
    return {
      kind: "SKIP_SENSITIVE",
      reason: "Potential credential or account-verification message",
    };

  if (subject && RECRUITMENT_SUBJECT.test(subject))
    return { kind: "CANDIDATE", reason: "Recruitment-related subject" };

  // Hiring platforms routinely use subjects like "Acme Robotics - Senior Engineer". Their
  // account-administration mail still needs a recruitment phrase found by mailbox search.
  if (isRecruitingSenderDomain(senderDomain(from))) {
    if (subject && !ACCOUNT_SUBJECT.test(subject))
      return { kind: "CANDIDATE", reason: "Hiring-platform sender" };
    return {
      kind: "REVIEW_HEADERS",
      reason: "ATS sender with unclear message type",
    };
  }
  if (!subject) return { kind: "REVIEW_HEADERS", reason: "Missing metadata" };
  if (/\b(greenhouse|lever|workday|ashby|smartrecruiters)\b/i.test(from)) {
    return {
      kind: "REVIEW_HEADERS",
      reason: "ATS sender with unclear message type",
    };
  }
  return { kind: "SKIP_UNRELATED", reason: "No recruitment indicator" };
}
