import type { GateDecision, MessageHeaders } from "../domain/types.ts";
import { isRecruitingSenderDomain, senderDomain } from "./ats.ts";

const SENSITIVE_SUBJECT =
  /\b(otp|one[\s-]?time|verification code|security code|passcode|password reset|reset your password|two[\s-]?factor|2fa|sign[\s-]?in code|login code|magic link|confirm your (?:email|identity)|verify your (?:email|identity))\b/i;

/** Literal search terms are shared with Gmail discovery; inflections must be explicit. */
export const RECRUITMENT_SUBJECT_TERMS: readonly string[] = [
  "application", "applications", "apply", "applying", "applied", "applicant", "applicants",
  "candidacy", "candidacies", "candidate", "candidates", "candidature",
  "interview", "interviews", "interviewing", "interviewed", "interviewer", "interviewers",
  "assessment", "assessments", "take-home", "take home", "takehome", "phone screen", "phone screening",
  "on-site", "on site", "onsite", "recruitment", "recruiting", "recruiter", "recruiters",
  "hiring", "talent acquisition", "job offer", "employment offer", "offer letter", "employment letter",
  "offer of employment", "your offer", "an offer", "our offer",
  "position", "positions", "role", "roles", "vacancy", "vacancies", "requisition",
  "opportunity", "opportunities", "next step", "next steps", "unfortunately",
  "thanks for your interest", "thank you for your interest", "career", "careers", "job", "submission",
  ...["coding", "technical", "skill", "skills", "online"].flatMap(prefix =>
    ["challenge", "test", "exercise", "assignment"].flatMap(noun => [`${prefix} ${noun}`, `${prefix} ${noun}s`])),
  ...["recruiter", "hiring manager", "technical", "intro", "introductory", "screening"].map(prefix => `${prefix} call`),
];
const RECRUITMENT_SUBJECT = new RegExp(`\\b(?:${RECRUITMENT_SUBJECT_TERMS.join("|")})\\b`, "i");

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
