import { createHash, randomUUID } from "node:crypto";
import { resolveOpening, resolveSubmission, resolveUpdate } from "../domain/resolution.ts";
import type { JobOpening } from "../domain/types.ts";
import { redactSubject } from "../ingestion/eml.ts";
import { EXTRACTOR_VERSION, extractSignal } from "../ingestion/extract.ts";
import { classifyHeaders } from "../ingestion/header-gate.ts";
import { TERMINAL_KINDS, type ExtractedSignal, type ParsedOriginal, type SignalKind } from "../ingestion/source.ts";
import type { Db } from "./db.ts";
import {
  addSubmissionEvidence, findAttemptsByExternalId, insertAttempt, insertOpening, isUniqueViolation,
  loadAttempts, loadOpenings, recordEvent, weakOpeningCandidates,
} from "./store.ts";

export type IngestSource =
  | { kind: "GMAIL"; mailboxId: string; providerMessageId: string }
  | { kind: "FORWARDED_EML" };

export interface IngestInput {
  userId: string;
  source: IngestSource;
  original: ParsedOriginal;
}

export type ReviewReason =
  | "NO_DATE" | "MISSING_JOB_DETAILS" | "AMBIGUOUS_OPENING" | "NO_KNOWN_SUBMISSION" | "AMBIGUOUS_ATTEMPT"
  | "POSSIBLE_RESENT_CONFIRMATION" | "TERMINAL_NEEDS_REVIEW" | "UNRECOGNIZED" | "AMBIGUOUS_APPLICATION_ID";

export type IngestOutcome =
  | { status: "APPLIED"; attemptId: string; openingId: string; kind: SignalKind; createdAttempt: boolean; createdOpening: boolean; reconciled: number }
  | { status: "REVIEW"; reviewId: string; reason: ReviewReason }
  | { status: "DUPLICATE" }
  | { status: "DUPLICATE_OBSERVATION" }
  | { status: "SKIPPED_SENSITIVE" }
  | { status: "NO_SIGNAL" };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Identifies the ORIGINAL message independent of how it reached us (Gmail vs forwarded copy).
 * RFC Message-ID alone is not unique, so it is combined with sender and original date.
 */
export function originalKeyOf(original: ParsedOriginal): string | null {
  const m = original.message;
  if (!m.messageId || !m.date) return null;
  return sha256([m.messageId.toLowerCase(), m.fromAddress ?? "", m.date].join("|"));
}

const evidenceKeyOf = (original: ParsedOriginal): string => originalKeyOf(original) ?? original.fingerprint;

interface Context {
  tx: Db;
  userId: string;
  artifactId: string;
  signalId: string;
  evidenceKey: string;
  sourceType: "GMAIL" | "FORWARDED_EML";
  signal: ExtractedSignal;
  occurredAt: string;
}

export async function ingestOriginal(db: Db, input: IngestInput): Promise<IngestOutcome> {
  try {
    return await db.transaction(tx => run(tx, input));
  } catch (error) {
    // Lost a race with an identical ingest; the other transaction owns the result.
    if (isUniqueViolation(error)) return { status: "DUPLICATE" };
    throw error;
  }
}

async function run(tx: Db, { userId, source, original }: IngestInput): Promise<IngestOutcome> {
  // Serialise ingestion per user so concurrent runs cannot create the same opening twice.
  await tx.query("SELECT id FROM ledger_users WHERE id = $1 FOR UPDATE", [userId]);

  const seen = source.kind === "GMAIL"
    ? await tx.query("SELECT 1 FROM source_artifacts WHERE mailbox_id = $1 AND provider_message_id = $2 AND source_kind = 'GMAIL'", [source.mailboxId, source.providerMessageId])
    : await tx.query("SELECT 1 FROM source_artifacts WHERE user_id = $1 AND source_fingerprint = $2 AND source_kind = 'FORWARDED_EML'", [userId, original.fingerprint]);
  if (seen.rows.length) return { status: "DUPLICATE" };

  const m = original.message;
  const artifactId = randomUUID();
  const originalKey = originalKeyOf(original);
  const insertArtifact = (decision: string, subject: string | null, key: string | null, extractorVersion: string | null) =>
    tx.query(
      `INSERT INTO source_artifacts (id, user_id, source_kind, mailbox_id, provider_message_id, original_rfc_message_id,
         source_fingerprint, original_message_at, envelope_message_at, body_access_decision, extractor_version, original_key, subject_redacted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [artifactId, userId, source.kind, source.kind === "GMAIL" ? source.mailboxId : null,
        source.kind === "GMAIL" ? source.providerMessageId : null, m.messageId, original.fingerprint, m.date, original.envelopeDate,
        decision, extractorVersion, key, subject]);
  const decision = source.kind === "GMAIL" ? "FETCHED_CANDIDATE" : "MANUAL_IMPORT";

  const gate = classifyHeaders({ from: `${m.fromName} <${m.fromAddress ?? ""}>`, subject: m.subject });
  if (gate.kind === "SKIP_SENSITIVE") {
    // Nothing derived from a credential-like message is kept, including its subject.
    await insertArtifact("SKIPPED_SENSITIVE", null, null, null);
    return { status: "SKIPPED_SENSITIVE" };
  }

  const signal = extractSignal(m);
  const subjectRedacted = redactSubject(m.subject);

  if (originalKey) {
    const earlier = await tx.query<{ id: string }>(
      "SELECT id FROM source_artifacts WHERE user_id = $1 AND original_key = $2 ORDER BY source_observed_at LIMIT 1", [userId, originalKey]);
    if (earlier.rows.length) {
      await insertArtifact(decision, subjectRedacted, originalKey, EXTRACTOR_VERSION);
      await tx.query(
        `INSERT INTO event_evidence (user_id, event_id, artifact_id, evidence_kind)
         SELECT user_id, event_id, $3, evidence_kind FROM event_evidence WHERE user_id = $1 AND artifact_id = $2
         ON CONFLICT DO NOTHING`, [userId, earlier.rows[0]!.id, artifactId]);
      await insertSignal(tx, userId, artifactId, signal, "DUPLICATE");
      return { status: "DUPLICATE_OBSERVATION" };
    }
  }

  await insertArtifact(decision, subjectRedacted, originalKey, EXTRACTOR_VERSION);
  const signalId = await insertSignal(tx, userId, artifactId, signal, "REVIEW");
  const base = { tx, userId, artifactId, signalId, evidenceKey: evidenceKeyOf(original), sourceType: source.kind, signal };

  if (!signal.kind) {
    if (source.kind === "GMAIL") {
      await tx.query("UPDATE extracted_signals SET processing_state = 'DISMISSED' WHERE id = $1", [signalId]);
      return { status: "NO_SIGNAL" };
    }
    return review(base, "UNRECOGNIZED", [], []);
  }
  if (!signal.occurredAt) return review(base, "NO_DATE", [], []);

  const outcome = await apply({ ...base, occurredAt: signal.occurredAt }, true);
  if (outcome.status === "APPLIED") {
    await tx.query("UPDATE extracted_signals SET processing_state = 'APPLIED' WHERE id = $1", [signalId]);
    if (outcome.createdAttempt) return { ...outcome, reconciled: await reconcileWaitingUpdates(tx, userId) };
  }
  return outcome;
}

async function insertSignal(tx: Db, userId: string, artifactId: string, s: ExtractedSignal, state: string): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO extracted_signals (id, user_id, source_artifact_id, extractor_version, event_kind, fields, confidence, processing_state)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [id, userId, artifactId, EXTRACTOR_VERSION, s.kind, JSON.stringify(s.fields), s.confidence, state]);
  return id;
}

async function review(
  c: Pick<Context, "tx" | "userId" | "artifactId" | "signalId">,
  reason: ReviewReason, candidateAttemptIds: readonly string[], candidateOpeningIds: readonly string[],
): Promise<IngestOutcome> {
  const id = randomUUID();
  await c.tx.query(
    `INSERT INTO review_items (id, user_id, source_artifact_id, signal_id, reason_code, candidate_attempt_ids, candidate_opening_ids)
     VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7::uuid[])`,
    [id, c.userId, c.artifactId, c.signalId, reason, [...candidateAttemptIds], [...candidateOpeningIds]]);
  return { status: "REVIEW", reviewId: id, reason };
}

/**
 * `createReviews` is false while re-evaluating an existing review item: it must stay open
 * (unchanged) rather than spawn a second item for the same signal.
 */
async function apply(c: Context, createReviews: boolean): Promise<IngestOutcome> {
  const { tx, userId, signal } = c;
  const fail = (reason: ReviewReason, attemptIds: readonly string[], openingIds: readonly string[]): Promise<IngestOutcome> =>
    createReviews ? review(c, reason, attemptIds, openingIds) : Promise.resolve({ status: "REVIEW", reviewId: "", reason });
  const kind = signal.kind!;
  const f = signal.fields;
  const isConfirmation = kind === "CONFIRMATION_RECEIVED";

  let openingId: string | null = null;
  let strongOpening = false;
  let createdOpening = false;
  let directAttemptId: string | null = null;

  // An observed application id is the strongest link for any update.
  if (!isConfirmation && f.externalApplicationId) {
    const hits = await findAttemptsByExternalId(tx, userId, f.externalApplicationId);
    if (hits.length > 1) return fail("AMBIGUOUS_APPLICATION_ID", hits.map(h => h.id), [...new Set(hits.map(h => h.openingId))]);
    if (hits.length === 1) {
      openingId = hits[0]!.openingId;
      directAttemptId = hits[0]!.id;
      strongOpening = true;
    }
  }

  if (!openingId) {
    if (!f.company || !f.title) return fail("MISSING_JOB_DETAILS", [], []);
    const openings = await loadOpenings(tx, userId);
    const resolved = resolveOpening({ company: f.company, title: f.title, location: f.location, atsKey: f.atsKey, canonicalUrl: f.canonicalUrl }, openings);
    if (resolved.kind === "MATCH") {
      openingId = resolved.id;
      strongOpening = true;
    } else if (isConfirmation) {
      if (resolved.kind === "REVIEW") return fail("AMBIGUOUS_OPENING", [], resolved.candidateIds);
      openingId = await insertOpening(tx, userId, { company: f.company, title: f.title, location: f.location, atsKey: f.atsKey, canonicalUrl: f.canonicalUrl });
      createdOpening = true;
    } else {
      // Updates never create openings. A unique company/title hint is enough for non-terminal events only.
      const candidates: JobOpening[] = weakOpeningCandidates({ company: f.company, title: f.title, location: f.location }, openings);
      if (candidates.length === 0) return fail("NO_KNOWN_SUBMISSION", [], []);
      if (candidates.length > 1) return fail("AMBIGUOUS_OPENING", [], candidates.map(o => o.id));
      openingId = candidates[0]!.id;
    }
  }

  const attempts = await loadAttempts(tx, userId, openingId);
  const event = (attemptId: string) => ({
    userId, attemptId, kind, occurredAt: c.occurredAt, sourceType: c.sourceType, origin: "AUTO" as const,
    dedupeKey: `${attemptId}:${kind}:${c.evidenceKey}`,
  });

  if (isConfirmation) {
    const submission = { evidenceId: c.evidenceKey, applicantEmail: f.applicantEmail, phoneLookupKey: null, externalApplicationId: f.externalApplicationId };
    const decision = createdOpening ? ({ kind: "CREATE", reason: "New opening" } as const) : resolveSubmission(openingId, submission, attempts);
    if (decision.kind === "REVIEW") return fail("POSSIBLE_RESENT_CONFIRMATION", decision.candidateIds, [openingId]);
    let attemptId: string;
    let createdAttempt = false;
    if (decision.kind === "MATCH") {
      attemptId = decision.id;
      await addSubmissionEvidence(tx, userId, attemptId, c.evidenceKey);
    } else {
      attemptId = await insertAttempt(tx, userId, openingId, {
        applicantEmail: f.applicantEmail, externalApplicationId: f.externalApplicationId, submittedAt: c.occurredAt, evidenceKey: c.evidenceKey,
      });
      createdAttempt = true;
    }
    await recordEvent(tx, event(attemptId), c.artifactId);
    return { status: "APPLIED", attemptId, openingId, kind, createdAttempt, createdOpening, reconciled: 0 };
  }

  const update = { applicantEmail: f.applicantEmail, externalApplicationId: f.externalApplicationId, phoneLookupKey: null };
  const decision = directAttemptId
    ? ({ kind: "MATCH", id: directAttemptId, reason: "Exact application ID" } as const)
    : resolveUpdate(openingId, update, attempts);
  if (decision.kind !== "MATCH") {
    return fail(attempts.length ? "AMBIGUOUS_ATTEMPT" : "NO_KNOWN_SUBMISSION", decision.kind === "REVIEW" ? decision.candidateIds : [], [openingId]);
  }
  // Rejections and offers are irreversible-feeling: only an exact application id, or a unique email
  // on a strongly matched opening, may apply them without a human.
  const strongAttempt = decision.reason === "Exact application ID" || (decision.reason === "Unique matching submitted email" && strongOpening);
  if (TERMINAL_KINDS.has(kind) && !strongAttempt) return fail("TERMINAL_NEEDS_REVIEW", [decision.id], [openingId]);

  await recordEvent(tx, event(decision.id), c.artifactId);
  return { status: "APPLIED", attemptId: decision.id, openingId, kind, createdAttempt: false, createdOpening: false, reconciled: 0 };
}

/**
 * Updates can arrive before the submission they belong to (Gmail lists newest first, forwards
 * come in any order). Once a new attempt exists, re-evaluate waiting "no known submission"
 * items under exactly the same rules; anything still ambiguous stays in review untouched.
 */
async function reconcileWaitingUpdates(tx: Db, userId: string): Promise<number> {
  const { rows } = await tx.query<{
    review_id: string; signal_id: string; event_kind: SignalKind | null; fields: ExtractedSignal["fields"]; artifact_id: string;
    source_kind: "GMAIL" | "FORWARDED_EML"; original_message_at: unknown; original_key: string | null; source_fingerprint: string;
  }>(
    `SELECT r.id AS review_id, s.id AS signal_id, s.event_kind, s.fields, a.id AS artifact_id, a.source_kind,
            a.original_message_at, a.original_key, a.source_fingerprint
       FROM review_items r
       JOIN extracted_signals s ON s.id = r.signal_id AND s.user_id = r.user_id
       JOIN source_artifacts a ON a.id = r.source_artifact_id AND a.user_id = r.user_id
      WHERE r.user_id = $1 AND r.state = 'OPEN' AND r.reason_code = 'NO_KNOWN_SUBMISSION'
      ORDER BY a.original_message_at, r.created_at, r.id`, [userId]);
  let applied = 0;
  for (const row of rows) {
    if (!row.event_kind || !row.original_message_at) continue;
    const occurredAt = (row.original_message_at instanceof Date ? row.original_message_at : new Date(String(row.original_message_at))).toISOString();
    const signal: ExtractedSignal = { kind: row.event_kind, confidence: "HIGH", fields: row.fields, occurredAt, reasons: [] };
    const result = await apply({
      tx, userId, artifactId: row.artifact_id, signalId: row.signal_id, evidenceKey: row.original_key ?? row.source_fingerprint,
      sourceType: row.source_kind, signal, occurredAt,
    }, false);
    if (result.status !== "APPLIED") continue;
    await tx.query("UPDATE review_items SET state = 'RESOLVED', resolution = 'AUTO_RECONCILED', resolved_at = now() WHERE id = $1 AND user_id = $2", [row.review_id, userId]);
    await tx.query("UPDATE extracted_signals SET processing_state = 'APPLIED' WHERE id = $1", [row.signal_id]);
    applied += 1;
  }
  return applied;
}
