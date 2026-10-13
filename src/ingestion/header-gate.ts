import type { GateDecision, MessageHeaders } from "../domain/types.ts";

/**
 * Minimal pre-body privacy gate. It NEVER inspects or stores message bodies.
 * Conservative: unknown messages are not automatically fetched. A later
 * privacy-reviewed allowlist may improve recall for unusual recruiter emails.
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
  const subject = headers.subject.toLowerCase().trim();
  if (!from || !subject)
    return { kind: "REVIEW_HEADERS", reason: "Missing metadata" };

  const sensitive =
    /\b(otp|one[\s-]?time|verification code|security code|passcode|password reset|reset your password|two[\s-]?factor|2fa|sign[\s-]?in code|login code|magic link|confirm your (?:email|identity)|verify your (?:email|identity))\b/i;
  if (sensitive.test(subject))
    return {
      kind: "SKIP_SENSITIVE",
      reason: "Potential credential or account-verification message",
    };

  const recruitment =
    /\b(application|applying|applied|applicant|interview|assessment|coding challenge|recruitment|recruiter|hiring process|job offer|candidate|unfortunately|position|role)\b/i;
  if (recruitment.test(subject))
    return { kind: "CANDIDATE", reason: "Recruitment-related subject" };

  // Do not classify every message from a recruiting platform as safe.
  if (/\b(greenhouse|lever|workday|ashby|smartrecruiters)\b/i.test(from)) {
    return {
      kind: "REVIEW_HEADERS",
      reason: "ATS sender with unclear message type",
    };
  }
  return { kind: "SKIP_UNRELATED", reason: "No recruitment indicator" };
}
