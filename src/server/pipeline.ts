import { createHash, randomUUID } from "node:crypto";
import {
  EXACT_APPLICATION_ID,
  resolveOpening,
  resolveSubmission,
  resolveUpdate,
  SOLE_ATTEMPT,
  UNIQUE_SUBMITTED_EMAIL,
} from "../domain/resolution.ts";
import {
  calendarIdentityHolds,
  gateSignal,
  judgeCalendarRevision,
  mayApplyAutomatically,
  needsAuthority,
  screenSensitive,
  type AuthorityFacts,
  type MatchBasis,
  type ReviewReason,
} from "../domain/policy.ts";
import type { CalendarFacts } from "../domain/types.ts";
import {
  atsKeyId,
  companyKey,
  normalizedText,
} from "../domain/normalization.ts";
import { redactSubject } from "../ingestion/eml.ts";
import {
  EXTRACTOR_VERSION,
  extractSignal,
  isHiringSignal,
} from "../ingestion/extract.ts";
import { classifyHeaders } from "../ingestion/header-gate.ts";
import { messageSensitivity } from "../ingestion/privacy.ts";
import { usableEventDate } from "../ingestion/dates.ts";
import {
  isRecruitingSenderDomain,
  isTrustedAtsDomain,
} from "../ingestion/ats.ts";
import type {
  ExtractedSignal,
  ParsedOriginal,
  SignalKind,
} from "../ingestion/source.ts";
import { employerDomain } from "../ingestion/fields.ts";
import type { Db } from "./db.ts";
import {
  conversationAttempts,
  employerOpenings,
  messageIdKey,
} from "./conversation.ts";
import {
  acceptSubmissionEvidence,
  attemptConfirmedInMailbox,
  attemptsForCalendarUid,
  automaticEventProblem,
  findAttemptsByExternalId,
  insertAttempt,
  insertOpening,
  latestCalendarRevision,
  linkEvidence,
  loadAttempts,
  loadOpenings,
  recordEvent,
  reproject,
  weakOpeningCandidates,
} from "./store.ts";

export type { ReviewReason };

export type IngestSource =
  | {
      kind: "GMAIL";
      mailboxId: string;
      providerMessageId: string;
      senderAuthenticated?: boolean;
      providerThreadId?: string;
    }
  // Synthetic fixtures are explicitly trusted by internal demo/test code only.
  // The upload route must never accept this field from a request or message.
  | { kind: "FORWARDED_EML"; syntheticFixture?: boolean };

export interface IngestInput {
  userId: string;
  source: IngestSource;
  original: ParsedOriginal;
  /** Internal observation clock; never accepted from an HTTP request. */
  observedAt?: Date;
  /** Internal recovery flag; never accepted from an upload or HTTP payload. */
  reprocessUnapplied?: boolean;
}

export type IngestOutcome =
  | {
      status: "APPLIED";
      attemptId: string;
      openingId: string;
      kind: SignalKind;
      createdAttempt: boolean;
      createdOpening: boolean;
      reconciled: number;
    }
  | { status: "REVIEW"; reviewId: string; reason: ReviewReason }
  | { status: "DUPLICATE" }
  | { status: "DUPLICATE_OBSERVATION" }
  | { status: "SKIPPED_SENSITIVE" }
  | { status: "NO_SIGNAL" };

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * Identifies the ORIGINAL message independent of how it reached us (Gmail vs forwarded copy).
 * Include normalized content and recipients. Reused/forged header identities must never
 * suppress a genuinely different signal or attach false evidence to an existing event.
 */
export function originalKeyOf(original: ParsedOriginal): string | null {
  const m = original.message;
  if (!m.messageId || !m.date) return null;
  const normalized = (text: string) =>
    text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .trim();
  return sha256(
    JSON.stringify([
      m.messageId,
      m.fromAddress,
      normalized(m.fromName),
      m.date,
      [...m.to].sort(),
      normalized(m.subject),
      normalized(m.text),
      [...new Set((m.alternativeTexts ?? []).map(normalized))].sort(),
      ...(m.calendarParts?.length
        ? [
            m.calendarParts
              .map((part) => [part.method, normalized(part.content)])
              .sort(),
          ]
        : []),
    ]),
  );
}

const evidenceKeyOf = (original: ParsedOriginal): string =>
  originalKeyOf(original) ?? original.fingerprint;

interface Context {
  tx: Db;
  userId: string;
  artifactId: string;
  signalId: string;
  evidenceKey: string;
  sourceType: "GMAIL" | "FORWARDED_EML";
  signal: ExtractedSignal;
  trustedSender: boolean;
  /** The Gmail mailbox that received this message; null for forwarded files. */
  mailboxId: string | null;
  senderDomain: string;
  senderVerified: boolean;
  replyMessageKeys: readonly string[];
  providerThreadId: string | null;
}

/** A signal that passed gateSignal: its kind and date are known. */
type GatedContext = Context & { kind: SignalKind; occurredAt: string };

export async function ingestOriginal(
  db: Db,
  input: IngestInput,
): Promise<IngestOutcome> {
  // The owner lock serializes ingestion. Unexpected constraint failures are
  // genuine processing errors, never evidence that an email was a duplicate.
  return db.transaction((tx) => run(tx, input));
}

async function run(
  tx: Db,
  {
    userId,
    source,
    original,
    observedAt = new Date(),
    reprocessUnapplied = false,
  }: IngestInput,
): Promise<IngestOutcome> {
  // Serialise ingestion per user so concurrent runs cannot create the same opening twice.
  const owner = await tx.query(
    "SELECT id FROM ledger_users WHERE id = $1 FOR UPDATE",
    [userId],
  );
  if (!owner.rows.length) throw new Error("OWNER_NOT_FOUND");
  if (source.kind === "GMAIL") {
    const mailbox = await tx.query(
      "SELECT id FROM connected_mailboxes WHERE id=$1 AND user_id=$2 AND sync_state<>'DISCONNECTED'",
      [source.mailboxId, userId],
    );
    if (!mailbox.rows.length) throw new Error("MAILBOX_NOT_FOUND");
  }

  const seen =
    source.kind === "GMAIL"
      ? await tx.query<{
          id: string;
          source_fingerprint: string;
          body_access_decision: string;
        }>(
          "SELECT id, source_fingerprint, body_access_decision FROM source_artifacts WHERE user_id=$3 AND mailbox_id = $1 AND provider_message_id = $2 AND source_kind = 'GMAIL'",
          [source.mailboxId, source.providerMessageId, userId],
        )
      : await tx.query<{
          id: string;
          source_fingerprint: string;
          body_access_decision: string;
        }>(
          "SELECT id, source_fingerprint, body_access_decision FROM source_artifacts WHERE user_id = $1 AND source_fingerprint = $2 AND source_kind = 'FORWARDED_EML'",
          [userId, original.fingerprint],
        );
  const existing = seen.rows[0];
  if (existing) {
    if (source.kind !== "GMAIL") return { status: "DUPLICATE" };
    // Preserve accepted/rejected events and every review decision, including dismissals.
    const protectedResult = await tx.query(
      `SELECT 1 FROM event_evidence WHERE user_id=$1 AND artifact_id=$2
       UNION ALL SELECT 1 FROM extracted_signals s WHERE s.user_id=$1 AND s.source_artifact_id=$2
         AND (s.processing_state='APPLIED' OR EXISTS (SELECT 1 FROM review_items r WHERE r.user_id=$1 AND r.signal_id=s.id))`,
      [userId, existing.id],
    );
    if (protectedResult.rows.length) return { status: "DUPLICATE" };
    // A crash after ingest commits but before the task finishes must retain the
    // original exclusion, rather than turning that exclusion into "processed".
    if (!reprocessUnapplied)
      return {
        status:
          existing.body_access_decision === "SKIPPED_SENSITIVE"
            ? "SKIPPED_SENSITIVE"
            : "NO_SIGNAL",
      };
    if (existing.source_fingerprint !== original.fingerprint)
      throw new Error("SOURCE_CHANGED");
  }

  const m = original.message;
  const replyMessageKeys = (m.replyMessageIds ?? [])
    .map(messageIdKey)
    .filter((key): key is string => key !== null);
  const providerThreadId =
    source.kind === "GMAIL" && !m.threadContextUncertain
      ? (source.providerThreadId ?? null)
      : null;
  const usableDate = usableEventDate(m.date, observedAt);
  const artifactId = existing?.id ?? randomUUID();
  const originalKey = originalKeyOf(original);
  const fromDomain = m.fromAddress?.split("@")[1] ?? "";
  const trustedSender =
    source.kind === "FORWARDED_EML"
      ? source.syntheticFixture === true
      : source.senderAuthenticated === true && isTrustedAtsDomain(fromDomain);
  const insertArtifact = (
    decision: string,
    subject: string | null,
    key: string | null,
    extractorVersion: string | null,
  ) =>
    existing
      ? tx.query(
          `UPDATE source_artifacts SET body_access_decision=$3, subject_redacted=$4, original_key=$5,
          extractor_version=$6, original_message_at=$7, sender_authenticated=$8,sender_domain=$9,sender_verified=$10,
          provider_thread_id=$11,message_id_key=$12,reply_message_keys=$13 WHERE id=$1 AND user_id=$2`,
          [
            artifactId,
            userId,
            decision,
            subject,
            key,
            extractorVersion,
            usableDate,
            trustedSender,
            decision === "SKIPPED_SENSITIVE" ? null : fromDomain.toLowerCase(),
            source.kind === "GMAIL" && source.senderAuthenticated === true,
            decision === "SKIPPED_SENSITIVE" ? null : providerThreadId,
            decision === "SKIPPED_SENSITIVE" ? null : messageIdKey(m.messageId),
            decision === "SKIPPED_SENSITIVE" ? [] : replyMessageKeys,
          ],
        )
      : tx.query(
          `INSERT INTO source_artifacts (id, user_id, source_kind, mailbox_id, provider_message_id, original_rfc_message_id,
         source_fingerprint, original_message_at, envelope_message_at, body_access_decision, extractor_version, original_key, subject_redacted,sender_authenticated,sender_domain,sender_verified,
         provider_thread_id,message_id_key,reply_message_keys)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            artifactId,
            userId,
            source.kind,
            source.kind === "GMAIL" ? source.mailboxId : null,
            source.kind === "GMAIL" ? source.providerMessageId : null,
            null,
            original.fingerprint,
            usableDate,
            original.envelopeDate,
            decision,
            extractorVersion,
            key,
            subject,
            trustedSender,
            decision === "SKIPPED_SENSITIVE" ? null : fromDomain.toLowerCase(),
            source.kind === "GMAIL" && source.senderAuthenticated === true,
            decision === "SKIPPED_SENSITIVE" ? null : providerThreadId,
            decision === "SKIPPED_SENSITIVE" ? null : messageIdKey(m.messageId),
            decision === "SKIPPED_SENSITIVE" ? [] : replyMessageKeys,
          ],
        );
  const decision =
    source.kind === "GMAIL" ? "FETCHED_CANDIDATE" : "MANUAL_IMPORT";

  const headers = classifyHeaders({
    from: `${m.fromName} <${m.fromAddress ?? ""}>`,
    subject: m.subject,
  });
  // Extraction is transient; nothing is stored before this decision.
  const signal = extractSignal({ ...m, date: usableDate });
  if (
    screenSensitive({
      headerSensitive: headers.kind === "SKIP_SENSITIVE",
      level: messageSensitivity(m),
      hiringSignal: isHiringSignal(signal),
    })
  ) {
    // Nothing derived from a credential-like message is kept, including its subject.
    await insertArtifact("SKIPPED_SENSITIVE", null, null, null);
    if (existing)
      await tx.query(
        "DELETE FROM extracted_signals WHERE user_id=$1 AND source_artifact_id=$2",
        [userId, artifactId],
      );
    return { status: "SKIPPED_SENSITIVE" };
  }

  const subjectRedacted = redactSubject(m.subject);

  if (originalKey) {
    const earlier = await tx.query<{ id: string }>(
      `SELECT a.id FROM source_artifacts a WHERE a.user_id=$1 AND a.original_key=$2 AND a.id<>$3
         AND (EXISTS (SELECT 1 FROM event_evidence e WHERE e.user_id=$1 AND e.artifact_id=a.id)
           OR EXISTS (SELECT 1 FROM extracted_signals s JOIN review_items r ON r.signal_id=s.id AND r.user_id=s.user_id
             WHERE s.user_id=$1 AND s.source_artifact_id=a.id)) ORDER BY a.source_observed_at LIMIT 1`,
      [userId, originalKey, artifactId],
    );
    if (earlier.rows.length) {
      await insertArtifact(
        decision,
        subjectRedacted,
        originalKey,
        EXTRACTOR_VERSION,
      );
      await tx.query(
        `INSERT INTO event_evidence (user_id, event_id, artifact_id, evidence_kind)
         SELECT user_id, event_id, $3, evidence_kind FROM event_evidence WHERE user_id = $1 AND artifact_id = $2
         ON CONFLICT DO NOTHING`,
        [userId, earlier.rows[0]!.id, artifactId],
      );
      await insertSignal(tx, userId, artifactId, signal, "DUPLICATE");
      return { status: "DUPLICATE_OBSERVATION" };
    }
  }

  await insertArtifact(
    decision,
    subjectRedacted,
    originalKey,
    EXTRACTOR_VERSION,
  );
  const signalId = await insertSignal(tx, userId, artifactId, signal, "REVIEW");
  const base = {
    tx,
    userId,
    artifactId,
    signalId,
    evidenceKey: evidenceKeyOf(original),
    sourceType: source.kind,
    signal,
    trustedSender,
    mailboxId: source.kind === "GMAIL" ? source.mailboxId : null,
    senderDomain: fromDomain.toLowerCase(),
    senderVerified:
      source.kind === "FORWARDED_EML" || source.senderAuthenticated === true,
    replyMessageKeys,
    providerThreadId,
  };

  const gate = gateSignal(signal, {
    synced: source.kind === "GMAIL",
    recruitingSender: isRecruitingSenderDomain(fromDomain),
    subject: m.subject,
  });
  if (gate.action === "DISMISS") {
    await tx.query(
      "UPDATE extracted_signals SET processing_state = 'DISMISSED' WHERE id = $1",
      [signalId],
    );
    return { status: "NO_SIGNAL" };
  }
  if (gate.action === "REVIEW") return review(base, gate.reason, [], []);

  const outcome = await apply(
    { ...base, kind: gate.kind, occurredAt: gate.occurredAt },
    true,
  );
  if (outcome.status === "APPLIED") {
    await tx.query(
      "UPDATE extracted_signals SET processing_state = 'APPLIED' WHERE id = $1",
      [signalId],
    );
    if (outcome.kind === "CONFIRMATION_RECEIVED")
      return {
        ...outcome,
        reconciled: await reconcileWaitingUpdates(
          tx,
          userId,
          observedAt,
          outcome.openingId,
        ),
      };
  }
  return outcome;
}

async function insertSignal(
  tx: Db,
  userId: string,
  artifactId: string,
  s: ExtractedSignal,
  state: string,
): Promise<string> {
  const id = randomUUID();
  const result = await tx.query<{ id: string }>(
    `INSERT INTO extracted_signals (id, user_id, source_artifact_id, extractor_version, event_kind, fields, confidence, processing_state)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
     ON CONFLICT (source_artifact_id,extractor_version) DO UPDATE SET event_kind=EXCLUDED.event_kind,
       fields=EXCLUDED.fields,confidence=EXCLUDED.confidence,processing_state=EXCLUDED.processing_state
     RETURNING id`,
    [
      id,
      userId,
      artifactId,
      EXTRACTOR_VERSION,
      s.kind,
      JSON.stringify(s.fields),
      s.confidence,
      state,
    ],
  );
  return result.rows[0]!.id;
}

async function review(
  c: Pick<Context, "tx" | "userId" | "artifactId" | "signalId">,
  reason: ReviewReason,
  candidateAttemptIds: readonly string[],
  candidateOpeningIds: readonly string[],
): Promise<IngestOutcome> {
  const id = randomUUID();
  await c.tx.query(
    `INSERT INTO review_items (id, user_id, source_artifact_id, signal_id, reason_code, candidate_attempt_ids, candidate_opening_ids)
     VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7::uuid[])`,
    [
      id,
      c.userId,
      c.artifactId,
      c.signalId,
      reason,
      [...candidateAttemptIds],
      [...candidateOpeningIds],
    ],
  );
  return { status: "REVIEW", reviewId: id, reason };
}

/** A stage either continues with a value or stops, sending the email to review. */
type Stop = {
  ok: false;
  reason: ReviewReason;
  attemptIds: readonly string[];
  openingIds: readonly string[];
};
type Step<T> = { ok: true; value: T } | Stop;

const next = <T>(value: T): Step<T> => ({ ok: true, value });
const stop = (
  reason: ReviewReason,
  attemptIds: readonly string[] = [],
  openingIds: readonly string[] = [],
): Stop => ({ ok: false, reason, attemptIds, openingIds });

/** The email itself named one attempt: by application ID, calendar UID, or conversation. */
interface DirectMatch {
  openingId: string;
  attemptId: string;
  basis: MatchBasis;
}

interface Located {
  openingId: string;
  /** Matched by a stable identity, not just company and title. */
  strongOpening: boolean;
  createdOpening: boolean;
  direct: DirectMatch | null;
}

type AcceptedCalendar = Awaited<ReturnType<typeof latestCalendarRevision>>;

const UPDATE_BASIS: Readonly<Record<string, MatchBasis>> = {
  [EXACT_APPLICATION_ID]: "APPLICATION_ID",
  [UNIQUE_SUBMITTED_EMAIL]: "SUBMITTED_EMAIL",
  [SOLE_ATTEMPT]: "SOLE_ATTEMPT",
};

/**
 * Matches a signal that passed gateSignal, and records it when the policy allows.
 *
 * `createReviews` is false while re-evaluating an existing review item: it must stay open
 * (unchanged) rather than spawn a second item for the same signal.
 */
async function apply(
  c: GatedContext,
  createReviews: boolean,
): Promise<IngestOutcome> {
  const fail = (step: Stop): Promise<IngestOutcome> =>
    createReviews
      ? review(c, step.reason, step.attemptIds, step.openingIds)
      : Promise.resolve({
          status: "REVIEW",
          reviewId: "",
          reason: step.reason,
        });
  const calendar = c.signal.fields.calendar;
  const accepted = calendar
    ? await latestCalendarRevision(c.tx, c.userId, c.signalId, calendar.uidKey)
    : null;

  const located = await locateOpening(c, accepted);
  if (!located.ok) return fail(located);
  const result =
    c.kind === "CONFIRMATION_RECEIVED"
      ? await applyConfirmation(c, located.value)
      : await applyUpdate(c, located.value, accepted);
  return result.ok ? result.value : fail(result);
}

/** Finds the opening: from the email's own identifiers first, then by company and title. */
async function locateOpening(
  c: GatedContext,
  accepted: AcceptedCalendar,
): Promise<Step<Located>> {
  // Confirmations always resolve (or create) their opening by its description.
  if (c.kind !== "CONFIRMATION_RECEIVED") {
    const direct = await locateAttempt(c, accepted);
    if (!direct.ok) return direct;
    if (direct.value)
      return next({
        openingId: direct.value.openingId,
        strongOpening: true,
        createdOpening: false,
        direct: direct.value,
      });
    const context = await employerContextOpening(c);
    if (!context.ok) return context;
    if (context.value)
      return next({
        openingId: context.value,
        strongOpening: false,
        createdOpening: false,
        direct: null,
      });
  }
  return describedOpening(c);
}

/**
 * An update that names its attempt. An application ID is the strongest link and, when present,
 * the only one tried: conflicting identities never fall back to a UID or a thread.
 */
async function locateAttempt(
  c: GatedContext,
  accepted: AcceptedCalendar,
): Promise<Step<DirectMatch | null>> {
  const f = c.signal.fields;
  if (f.externalApplicationId)
    return byApplicationId(c, f.externalApplicationId);
  if (f.calendar) {
    const linked = await byCalendarUid(c, f.calendar, accepted);
    if (!linked.ok || linked.value) return linked;
  }
  return byConversation(c);
}

/** An accepted calendar UID can link later revisions without inventing applicant contacts. */
async function byCalendarUid(
  c: GatedContext,
  calendar: CalendarFacts,
  accepted: AcceptedCalendar,
): Promise<Step<DirectMatch | null>> {
  const { tx, userId } = c;
  const f = c.signal.fields;
  const known = await attemptsForCalendarUid(
    tx,
    userId,
    c.signalId,
    calendar.uidKey,
  );
  const candidates = () =>
    [known.map((k) => k.attemptId), known.map((k) => k.openingId)] as const;
  if (known.length > 1) return stop("CALENDAR_REVISION", ...candidates());
  if (!known[0]) return next(null);
  if (
    !calendarIdentityHolds(
      calendar,
      accepted?.calendar ?? null,
      c.senderVerified,
    )
  )
    return stop("CALENDAR_REVISION", ...candidates());
  const { attemptId, openingId } = known[0];
  const opening = (await loadOpenings(tx, userId, { id: openingId }))[0]!;
  // A revision may omit the company or title, but must not name a different one.
  const differentCompany =
    f.company && companyKey(f.company) !== companyKey(opening.company);
  const differentTitle =
    f.title && normalizedText(f.title) !== normalizedText(opening.title);
  const differentAts =
    f.atsKey &&
    (!opening.atsKey || atsKeyId(f.atsKey) !== atsKeyId(opening.atsKey));
  if (differentCompany || differentTitle || differentAts)
    return stop("CALENDAR_REVISION", [attemptId], [opening.id]);
  return next({ openingId: opening.id, attemptId, basis: "CALENDAR_IDENTITY" });
}

/** IDs are scoped to employers and openings: a bare reused ID cannot cross that boundary. */
async function byApplicationId(
  c: GatedContext,
  externalApplicationId: string,
): Promise<Step<DirectMatch | null>> {
  const { tx, userId } = c;
  const f = c.signal.fields;
  const hits = await findAttemptsByExternalId(
    tx,
    userId,
    externalApplicationId,
  );
  if (hits.length > 1)
    return stop(
      "AMBIGUOUS_APPLICATION_ID",
      hits.map((h) => h.id),
      [...new Set(hits.map((h) => h.openingId))],
    );
  const hit = hits[0];
  if (!hit) return next(null);
  const known = (await loadOpenings(tx, userId, { id: hit.openingId }))[0];
  if (!known) return next(null);
  const matching =
    f.company &&
    f.title &&
    weakOpeningCandidates(
      { company: f.company, title: f.title, location: f.location },
      [known],
    ).length === 1;
  const stable =
    f.atsKey && known.atsKey && atsKeyId(f.atsKey) === atsKeyId(known.atsKey);
  if (!stable && !(matching && !f.atsKey)) return next(null);
  if (
    (f.company && companyKey(f.company) !== companyKey(known.company)) ||
    (f.title && normalizedText(f.title) !== normalizedText(known.title))
  )
    return stop("AMBIGUOUS_OPENING", [hit.id], [known.id]);
  return next({
    openingId: hit.openingId,
    attemptId: hit.id,
    basis: "APPLICATION_ID",
  });
}

/** A reply to, or a message in the same thread as, accepted mail from the same sender domain. */
async function byConversation(
  c: GatedContext,
): Promise<Step<DirectMatch | null>> {
  if (
    !c.mailboxId ||
    !c.senderVerified ||
    (!c.replyMessageKeys.length && !c.providerThreadId)
  )
    return next(null);
  const linked = await conversationAttempts(
    c.tx,
    c.userId,
    c.mailboxId,
    c.senderDomain,
    c.replyMessageKeys,
    c.providerThreadId,
    c.signal.fields,
  );
  const attemptIds = linked.map((row) => row.attemptId);
  const openingIds = linked.map((row) => row.openingId);
  if (linked.some((row) => row.conflicting))
    return stop("AMBIGUOUS_OPENING", attemptIds, openingIds);
  if (linked.length > 1)
    return stop("AMBIGUOUS_ATTEMPT", attemptIds, openingIds);
  const only = linked[0];
  if (!only) return next(null);
  // The thread only counts when it is with the employer itself or an authenticated hiring platform.
  if (
    !isTrustedAtsDomain(c.senderDomain) &&
    !employerDomain(c.senderDomain, only.company)
  )
    return stop("MISSING_JOB_DETAILS", [only.attemptId], [only.openingId]);
  return next({
    openingId: only.openingId,
    attemptId: only.attemptId,
    basis: "CONVERSATION",
  });
}

/** An update missing its company or title, from a verified employer domain with one known opening. */
async function employerContextOpening(
  c: GatedContext,
): Promise<Step<string | null>> {
  const f = c.signal.fields;
  if (
    (f.company && f.title) ||
    !c.mailboxId ||
    !c.senderVerified ||
    f.externalApplicationId
  )
    return next(null);
  const context = await employerOpenings(c.tx, c.userId, c.senderDomain);
  if (context.overflow)
    return stop(
      "AMBIGUOUS_OPENING",
      [],
      context.openings.map((o) => o.id),
    );
  const known = context.openings.filter(
    (o) =>
      (!f.company || companyKey(f.company) === companyKey(o.company)) &&
      (!f.title || normalizedText(f.title) === normalizedText(o.title)),
  );
  if (known.length > 1)
    return stop(
      "AMBIGUOUS_OPENING",
      [],
      known.map((o) => o.id),
    );
  return next(known[0]?.id ?? null);
}

/**
 * The opening the email describes. Only a confirmation may create one; an update needs a strong
 * match, or a unique company/title candidate (enough for non-terminal events only; see policy).
 */
async function describedOpening(c: GatedContext): Promise<Step<Located>> {
  const f = c.signal.fields;
  if (!f.company || !f.title) return stop("MISSING_JOB_DETAILS");
  const description = {
    company: f.company,
    title: f.title,
    location: f.location,
    atsKey: f.atsKey,
    canonicalUrl: f.canonicalUrl,
  };
  const openings = await loadOpenings(c.tx, c.userId, {
    title: f.title,
    atsKey: f.atsKey,
    canonicalUrl: f.canonicalUrl,
  });
  const resolved = resolveOpening(description, openings);
  const found = (
    openingId: string,
    strongOpening: boolean,
    createdOpening = false,
  ) => next({ openingId, strongOpening, createdOpening, direct: null });
  if (resolved.kind === "MATCH") return found(resolved.id, true);
  if (c.kind === "CONFIRMATION_RECEIVED") {
    if (resolved.kind === "REVIEW")
      return stop("AMBIGUOUS_OPENING", [], resolved.candidateIds);
    return found(await insertOpening(c.tx, c.userId, description), false, true);
  }
  if (f.atsKey) return stop("NO_KNOWN_SUBMISSION");
  const candidates = weakOpeningCandidates(
    { company: f.company, title: f.title, location: f.location },
    openings,
  );
  if (candidates.length === 0) return stop("NO_KNOWN_SUBMISSION");
  if (candidates.length > 1)
    return stop(
      "AMBIGUOUS_OPENING",
      [],
      candidates.map((o) => o.id),
    );
  return found(candidates[0]!.id, false);
}

function eventFor(c: GatedContext, attemptId: string) {
  const f = c.signal.fields;
  return {
    userId: c.userId,
    attemptId,
    kind: c.kind,
    occurredAt: c.occurredAt,
    sourceType: c.sourceType,
    origin: "AUTO" as const,
    dedupeKey: `${attemptId}:${c.kind}:${c.evidenceKey}`,
    signalId: c.signalId,
    ...(c.kind === "INTERVIEW_SCHEDULED" && f.calendar
      ? { calendar: f.calendar, senderDomain: c.senderDomain }
      : {}),
  };
}

const applied = (
  c: GatedContext,
  attemptId: string,
  openingId: string,
  created: { attempt?: boolean; opening?: boolean } = {},
): IngestOutcome => ({
  status: "APPLIED",
  attemptId,
  openingId,
  kind: c.kind,
  createdAttempt: created.attempt ?? false,
  createdOpening: created.opening ?? false,
  reconciled: 0,
});

/** A confirmation is submission proof: it matches its attempt, or creates one. */
async function applyConfirmation(
  c: GatedContext,
  located: Located,
): Promise<Step<IngestOutcome>> {
  const { tx, userId } = c;
  const f = c.signal.fields;
  const { openingId, createdOpening } = located;
  const attempts = await loadAttempts(tx, userId, openingId);
  const decision = createdOpening
    ? ({ kind: "CREATE", reason: "New opening" } as const)
    : resolveSubmission(
        openingId,
        {
          evidenceId: c.evidenceKey,
          applicantEmail: f.applicantEmail,
          phoneLookupKey: null,
          externalApplicationId: f.externalApplicationId,
        },
        attempts,
      );
  if (decision.kind === "REVIEW")
    return stop("POSSIBLE_RESENT_CONFIRMATION", decision.candidateIds, [
      openingId,
    ]);
  const createdAttempt = decision.kind === "CREATE";
  const attemptId =
    decision.kind === "MATCH"
      ? decision.id
      : await insertAttempt(tx, userId, openingId, {
          applicantEmail: f.applicantEmail,
          externalApplicationId: f.externalApplicationId,
          submittedAt: c.occurredAt,
          evidenceKey: c.evidenceKey,
        });
  await acceptSubmissionEvidence(
    tx,
    userId,
    attemptId,
    c.evidenceKey,
    c.occurredAt,
    f,
  );
  // A resent confirmation is more evidence for the first one, not a second event.
  const prior = createdAttempt
    ? null
    : await tx.query<{ id: string }>(
        `SELECT id FROM application_events
          WHERE user_id=$1 AND attempt_id=$2 AND event_kind='CONFIRMATION_RECEIVED' ORDER BY occurred_at,id LIMIT 1`,
        [userId, attemptId],
      );
  if (prior?.rows[0]) {
    await linkEvidence(tx, userId, prior.rows[0].id, c.artifactId, c.signalId);
    await reproject(tx, userId, attemptId);
  } else await recordEvent(tx, eventFor(c, attemptId), c.artifactId);
  return next(
    applied(c, attemptId, openingId, {
      attempt: createdAttempt,
      opening: createdOpening,
    }),
  );
}

/** Which attempt an update belongs to. A direct match must agree with any identity the email names. */
function matchAttempt(
  c: GatedContext,
  located: Located,
  attempts: Awaited<ReturnType<typeof loadAttempts>>,
): Step<{ attemptId: string; basis: MatchBasis | null }> {
  const f = c.signal.fields;
  const { openingId, direct } = located;
  const update = {
    applicantEmail: f.applicantEmail,
    externalApplicationId: f.externalApplicationId,
    phoneLookupKey: null,
  };
  if (direct) {
    if (f.externalApplicationId || f.applicantEmail) {
      const identity = resolveUpdate(openingId, update, attempts);
      if (identity.kind !== "MATCH" || identity.id !== direct.attemptId)
        return stop(
          f.calendar ? "CALENDAR_REVISION" : "AMBIGUOUS_ATTEMPT",
          attempts.map((a) => a.id),
          [openingId],
        );
    }
    return next({ attemptId: direct.attemptId, basis: direct.basis });
  }
  const decision = resolveUpdate(openingId, update, attempts);
  if (decision.kind !== "MATCH")
    return stop(
      attempts.length ? "AMBIGUOUS_ATTEMPT" : "NO_KNOWN_SUBMISSION",
      decision.kind === "REVIEW" ? decision.candidateIds : [],
      [openingId],
    );
  return next({
    attemptId: decision.id,
    basis: UPDATE_BASIS[decision.reason] ?? null,
  });
}

async function authorityFacts(
  c: GatedContext,
  located: Located,
  match: { attemptId: string; basis: MatchBasis | null },
): Promise<AuthorityFacts> {
  const opening = (
    await loadOpenings(c.tx, c.userId, { id: located.openingId })
  )[0]!;
  return {
    basis: match.basis,
    strongOpening: located.strongOpening,
    confirmedInSameMailbox:
      c.mailboxId !== null &&
      (await attemptConfirmedInMailbox(
        c.tx,
        c.userId,
        match.attemptId,
        c.mailboxId,
      )),
    trustedSender: c.trustedSender,
    verifiedEmployer:
      !!c.mailboxId &&
      c.senderVerified &&
      !!employerDomain(c.senderDomain, opening.company),
    confidence: c.signal.confidence,
  };
}

/** A status update: match its attempt, check the policy, then record it. */
async function applyUpdate(
  c: GatedContext,
  located: Located,
  accepted: AcceptedCalendar,
): Promise<Step<IngestOutcome>> {
  const { tx, userId } = c;
  const { openingId } = located;
  const attempts = await loadAttempts(tx, userId, openingId);
  const matched = matchAttempt(c, located, attempts);
  if (!matched.ok) return matched;
  const { attemptId } = matched.value;
  if (
    needsAuthority(c.kind) &&
    !mayApplyAutomatically(
      c.kind,
      await authorityFacts(c, located, matched.value),
    )
  )
    return stop("TERMINAL_NEEDS_REVIEW", [attemptId], [openingId]);

  const calendar = c.signal.fields.calendar;
  if (calendar) {
    const verdict = judgeCalendarRevision(
      calendar,
      accepted,
      attemptId,
      c.senderDomain,
    );
    if (verdict === "REPEAT" && accepted) {
      await linkEvidence(
        tx,
        userId,
        accepted.eventId,
        c.artifactId,
        c.signalId,
      );
      return next(applied(c, attemptId, openingId));
    }
    if (verdict === "OUT_OF_ORDER" && accepted)
      return stop(
        "CALENDAR_REVISION",
        [attemptId, accepted.attemptId],
        [openingId],
      );
    if (verdict !== "NEW")
      return stop("CALENDAR_REVISION", [attemptId], [openingId]);
  }

  const event = eventFor(c, attemptId);
  const problem = await automaticEventProblem(tx, event);
  if (problem) return stop(problem, [attemptId], [openingId]);
  await recordEvent(tx, event, c.artifactId);
  return next(applied(c, attemptId, openingId));
}

/**
 * Updates can arrive before the submission they belong to (Gmail lists newest first, forwards
 * come in any order). Once a new attempt exists, re-evaluate waiting updates under exactly the
 * same rules; anything still ambiguous stays in review untouched. Recheck only candidates for
 * the changed opening, in bounded batches. The scheduler resumes remaining work after commit.
 */
export async function reconcileWaitingUpdates(
  tx: Db,
  userId: string,
  observedAt: Date,
  openingId: string,
): Promise<number> {
  await tx.query(
    `INSERT INTO review_reconciliation_jobs(user_id,job_opening_id) VALUES($1,$2)
    ON CONFLICT(user_id,job_opening_id) DO UPDATE SET requested_at=now(),through_created_at=now(),
      last_created_at=NULL,last_review_id=NULL`,
    [userId, openingId],
  );
  return reconcileReviewBatch(tx, userId, observedAt, openingId);
}

const RECONCILIATION_BATCH_SIZE = 25;

/** Called while holding the owner's domain lock; the job cursor advances with domain writes. */
async function reconcileReviewBatch(
  tx: Db,
  userId: string,
  observedAt: Date,
  openingId: string,
): Promise<number> {
  const jobs = await tx.query<{
    through_created_at: unknown;
    last_created_at: unknown;
    last_review_id: string | null;
  }>(
    "SELECT through_created_at,last_created_at,last_review_id FROM review_reconciliation_jobs WHERE user_id=$1 AND job_opening_id=$2 FOR UPDATE",
    [userId, openingId],
  );
  const job = jobs.rows[0];
  if (!job) return 0;
  const opening = (await loadOpenings(tx, userId, { id: openingId }))[0];
  if (!opening) return 0;
  const { rows } = await tx.query<{
    review_id: string;
    signal_id: string;
    event_kind: SignalKind | null;
    fields: ExtractedSignal["fields"];
    artifact_id: string;
    source_kind: "GMAIL" | "FORWARDED_EML";
    original_message_at: unknown;
    original_key: string | null;
    source_fingerprint: string;
    sender_authenticated: boolean;
    mailbox_id: string | null;
    sender_domain: string | null;
    sender_verified: boolean;
    reply_message_keys: string[];
    provider_thread_id: string | null;
    confidence: "HIGH" | "LOW";
    review_created_at: unknown;
  }>(
    `SELECT r.id AS review_id, s.id AS signal_id, s.event_kind, s.fields, s.confidence, a.id AS artifact_id, a.source_kind,
            a.original_message_at, a.original_key, a.source_fingerprint, a.sender_authenticated, a.mailbox_id,
            a.sender_domain,a.sender_verified,a.reply_message_keys,a.provider_thread_id,r.created_at AS review_created_at
       FROM review_items r
       JOIN extracted_signals s ON s.id = r.signal_id AND s.user_id = r.user_id
       JOIN source_artifacts a ON a.id = r.source_artifact_id AND a.user_id = r.user_id
      WHERE r.user_id=$1 AND r.state='OPEN' AND r.reason_code IN ('NO_KNOWN_SUBMISSION','AMBIGUOUS_ATTEMPT','MISSING_JOB_DETAILS')
        AND s.event_kind IS NOT NULL AND s.event_kind<>'CONFIRMATION_RECEIVED'
        AND r.created_at<=$3 AND ($4::timestamptz IS NULL OR (r.created_at,r.id)>($4,$5::uuid))
        AND ($2::uuid=ANY(r.candidate_opening_ids)
          OR lower(regexp_replace(btrim(s.fields->>'title'),'\\s+',' ','g'))=$6
          OR ($7::text IS NOT NULL AND s.fields->>'canonicalUrl'=$7)
          OR ($8::text IS NOT NULL AND s.fields->'atsKey'->>'provider'=$8
            AND s.fields->'atsKey'->>'tenant'=$9 AND s.fields->'atsKey'->>'requisitionId'=$10)
          OR EXISTS (SELECT 1 FROM application_attempts known WHERE known.user_id=$1 AND known.job_opening_id=$2
            AND known.external_application_id=s.fields->>'externalApplicationId')
          OR EXISTS (SELECT 1 FROM application_events e JOIN application_attempts known ON known.id=e.attempt_id AND known.user_id=e.user_id
            JOIN event_evidence ev ON ev.event_id=e.id AND ev.user_id=e.user_id
            JOIN source_artifacts prior ON prior.id=ev.artifact_id AND prior.user_id=ev.user_id
            WHERE e.user_id=$1 AND known.job_opening_id=$2 AND e.review_state='ACCEPTED'
              AND prior.mailbox_id=a.mailbox_id AND prior.sender_domain=a.sender_domain AND prior.sender_verified
              AND (prior.message_id_key=ANY(a.reply_message_keys)
                OR (a.provider_thread_id IS NOT NULL AND prior.provider_thread_id=a.provider_thread_id)
                OR (s.fields->>'title' IS NULL AND a.sender_verified))))
      ORDER BY r.created_at,r.id LIMIT $11`,
    [
      userId,
      openingId,
      job.through_created_at,
      job.last_created_at,
      job.last_review_id,
      normalizedText(opening.title),
      opening.canonicalUrl,
      opening.atsKey?.provider ?? null,
      opening.atsKey?.tenant ?? null,
      opening.atsKey?.requisitionId ?? null,
      RECONCILIATION_BATCH_SIZE,
    ],
  );
  let applied = 0;
  for (const row of rows) {
    if (!row.event_kind || !row.original_message_at) continue;
    const originalAt = (
      row.original_message_at instanceof Date
        ? row.original_message_at
        : new Date(String(row.original_message_at))
    ).toISOString();
    const occurredAt = usableEventDate(originalAt, observedAt);
    if (!occurredAt) continue;
    // Only reviews apply() opened are rechecked: their signals already passed gateSignal, and
    // everything it reads is stored unchanged.
    const result = await apply(
      {
        tx,
        userId,
        artifactId: row.artifact_id,
        signalId: row.signal_id,
        evidenceKey: row.original_key ?? row.source_fingerprint,
        sourceType: row.source_kind,
        signal: {
          kind: row.event_kind,
          confidence: row.confidence,
          fields: row.fields,
          occurredAt,
          reasons: [],
        },
        kind: row.event_kind,
        occurredAt,
        trustedSender: row.sender_authenticated,
        mailboxId: row.mailbox_id,
        senderDomain: row.sender_domain ?? "",
        senderVerified:
          row.source_kind === "FORWARDED_EML" || row.sender_verified,
        replyMessageKeys: row.reply_message_keys,
        providerThreadId: row.provider_thread_id,
      },
      false,
    );
    if (result.status !== "APPLIED") continue;
    await tx.query(
      "UPDATE review_items SET state = 'RESOLVED', resolution = 'AUTO_RECONCILED', resolved_at = now() WHERE id = $1 AND user_id = $2",
      [row.review_id, userId],
    );
    await tx.query(
      "UPDATE extracted_signals SET processing_state = 'APPLIED' WHERE id = $1",
      [row.signal_id],
    );
    applied += 1;
  }
  if (rows.length < RECONCILIATION_BATCH_SIZE) {
    await tx.query(
      "DELETE FROM review_reconciliation_jobs WHERE user_id=$1 AND job_opening_id=$2",
      [userId, openingId],
    );
  } else {
    const last = rows.at(-1)!;
    await tx.query(
      `UPDATE review_reconciliation_jobs SET last_created_at=$3,last_review_id=$4,requested_at=now()
      WHERE user_id=$1 AND job_opening_id=$2`,
      [userId, openingId, last.review_created_at, last.review_id],
    );
  }
  return applied;
}

/** Scheduled continuation runs even without Gmail credentials. Each opening is isolated. */
export async function drainReviewReconciliations(
  db: Db,
  observedAt = new Date(),
  maxJobs = 4,
): Promise<{ applied: number; failed: number }> {
  const jobs = await db.query<{ user_id: string; job_opening_id: string }>(
    "SELECT user_id,job_opening_id FROM review_reconciliation_jobs ORDER BY requested_at,user_id,job_opening_id LIMIT $1",
    [Math.max(1, Math.min(20, Math.floor(maxJobs)))],
  );
  let applied = 0,
    failed = 0;
  for (const job of jobs.rows) {
    try {
      applied += await db.transaction(async (tx) => {
        const owner = await tx.query(
          "SELECT id FROM ledger_users WHERE id=$1 FOR UPDATE",
          [job.user_id],
        );
        if (!owner.rows.length) return 0;
        return reconcileReviewBatch(
          tx,
          job.user_id,
          observedAt,
          job.job_opening_id,
        );
      });
    } catch {
      failed++;
      // Keep the failed sweep durable, but let other openings run before retrying it.
      await db
        .query(
          "UPDATE review_reconciliation_jobs SET requested_at=now() WHERE user_id=$1 AND job_opening_id=$2",
          [job.user_id, job.job_opening_id],
        )
        .catch(() => undefined);
    }
  }
  return { applied, failed };
}
