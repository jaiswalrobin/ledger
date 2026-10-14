import { atsKeyId, canonicalUrlId, companyKey, normalizeEmail, normalizedText } from "./normalization.ts";
import type {
  ApplicationAttempt,
  JobOpening,
  OpeningSignal,
  Resolution,
  SubmissionSignal,
} from "./types.ts";

function choose(ids: readonly string[], reason: string): Resolution {
  if (ids.length === 1) return { kind: "MATCH", id: ids[0]!, reason };
  return { kind: "REVIEW", candidateIds: ids, reason };
}

/**
 * Job matching is strong-ID-first. Company/title similarity alone never
 * authorizes silently merging two openings.
 */
export function resolveOpening(
  signal: OpeningSignal,
  openings: readonly JobOpening[],
): Resolution {
  if (!normalizedText(signal.company) || !normalizedText(signal.title)) {
    return { kind: "REVIEW", candidateIds: [], reason: "Missing employer or title" };
  }

  if (signal.atsKey?.provider && signal.atsKey.tenant && signal.atsKey.requisitionId) {
    const key = atsKeyId(signal.atsKey);
    const matching = openings.filter(o => o.atsKey && atsKeyId(o.atsKey) === key);
    if (matching.length) return choose(matching.map(o => o.id), "Matching scoped ATS requisition");
    return { kind: "CREATE", reason: "Distinct scoped ATS requisition" };
  }

  const candidateUrl = signal.canonicalUrl && canonicalUrlId(signal.canonicalUrl);
  if (candidateUrl) {
    const matching = openings.filter(o => o.canonicalUrl && canonicalUrlId(o.canonicalUrl) === candidateUrl);
    if (matching.length) return choose(matching.map(o => o.id), "Matching canonical job URL");
    // URLs may be stale aliases; never create a second opening solely due to URL mismatch.
  }

  const weak = openings.filter(o =>
    companyKey(o.company) === companyKey(signal.company) &&
    normalizedText(o.title) === normalizedText(signal.title) &&
    normalizedText(o.location || "") === normalizedText(signal.location || ""));
  if (weak.length) return {
    kind: "REVIEW",
    candidateIds: weak.map(o => o.id),
    reason: "Company/title/location match is not a stable job identity",
  };

  return { kind: "CREATE", reason: "No candidate opening found" };
}

/**
 * An explicit submission signal is required. Distinct email/phone combinations
 * do not establish separate employer ATS candidate profiles; they only help
 * distinguish observed submission attempts in Ledger.
 */
export function resolveSubmission(
  openingId: string,
  submission: SubmissionSignal,
  attempts: readonly ApplicationAttempt[],
): Resolution {
  if (!submission.evidenceId.trim()) return {
    kind: "REVIEW", candidateIds: [], reason: "Submission has no stable evidence ID",
  };
  const scoped = attempts.filter(a => a.openingId === openingId);
  const sourceMatches = scoped.filter(a => a.submissionEvidenceIds.includes(submission.evidenceId));
  if (sourceMatches.length) return choose(sourceMatches.map(a => a.id), "Already processed submission evidence");

  if (submission.externalApplicationId) {
    const exact = scoped.filter(a => a.externalApplicationId === submission.externalApplicationId);
    if (exact.length) return choose(exact.map(a => a.id), "Matching ATS application ID");
    return { kind: "CREATE", reason: "Distinct observed ATS submission ID" };
  }

  const email = normalizeEmail(submission.applicantEmail);
  const possible = scoped.filter(a =>
    (email && normalizeEmail(a.applicantEmail) === email) ||
    (!email && submission.phoneLookupKey && a.phoneLookupKey === submission.phoneLookupKey) ||
    (!email && !submission.phoneLookupKey));
  if (possible.length) return {
    kind: "REVIEW", candidateIds: possible.map(a => a.id),
    reason: "Possibly resent confirmation or separate submission; insufficient unique evidence",
  };
  // Same phone with a DIFFERENT evidenced applicant email must not collapse submissions.
  return { kind: "CREATE", reason: "New observed submission with no competing attempt identity" };
}

/**
 * A status email is not submission proof. Ambiguous updates are NEVER assigned
 * to an arbitrary attempt, especially for rejection/offer messages.
 */
export function resolveUpdate(
  openingId: string,
  update: Pick<SubmissionSignal, "applicantEmail" | "externalApplicationId" | "phoneLookupKey">,
  attempts: readonly ApplicationAttempt[],
): Resolution {
  const scoped = attempts.filter(a => a.openingId === openingId);
  if (!scoped.length) return { kind: "REVIEW", candidateIds: [], reason: "No known submission attempt" };

  if (update.externalApplicationId) {
    const strong = scoped.filter(a => a.externalApplicationId === update.externalApplicationId);
    if (strong.length) return choose(strong.map(a => a.id), "Exact application ID");
    return { kind: "REVIEW", candidateIds: scoped.map(a => a.id), reason: "Application ID not recognized" };
  }
  const email = normalizeEmail(update.applicantEmail);
  if (email) {
    const matched = scoped.filter(a => normalizeEmail(a.applicantEmail) === email);
    if (matched.length === 1) {
      const selected = matched[0]!;
      if (update.phoneLookupKey && selected.phoneLookupKey && update.phoneLookupKey !== selected.phoneLookupKey) {
        return { kind: "REVIEW", candidateIds: [selected.id], reason: "Conflicting submitted phone identity" };
      }
      return { kind: "MATCH", id: selected.id, reason: "Unique matching submitted email" };
    }
    return {
      kind: "REVIEW",
      candidateIds: matched.length ? matched.map(a => a.id) : scoped.map(a => a.id),
      reason: "Update email does not uniquely identify a submission",
    };
  }

  // A shared phone is an ATS deduplication hint, not proof of application identity.
  return { kind: "REVIEW", candidateIds: scoped.map(a => a.id), reason: "Missing unambiguous application identity" };
}
